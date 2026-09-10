package main

// proxy.go — the integration point where components 1, 2, 4 (and the jitter of
// 3) meet on a single request path.
//
// Flow for a rewriting (Model B) fetch:
//   1. Client speaks TLS 1.3 to us (server.go).                      [comp 5]
//   2. We read its request and choose ONE coherent browser Profile.  [profile]
//   3. We forge a clean, consistent header set — dropping anything
//      that would reveal a proxy.                                    [comp 4]
//   4. We dial the upstream host with a matching uTLS fingerprint.   [comp 2]
//   5. We stream the response back through zeroing buffers, with
//      optional timing jitter.                                       [comp 1,3]

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	mrand "math/rand"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

// hopByHop headers are per-connection and must never be forwarded (RFC 7230).
var hopByHop = map[string]bool{
	"Connection": true, "Proxy-Connection": true, "Keep-Alive": true,
	"Proxy-Authenticate": true, "Proxy-Authorization": true, "Te": true,
	"Trailer": true, "Transfer-Encoding": true, "Upgrade": true,
}

// proxyLeaks announce "a proxy handled this." Strip them in BOTH directions.
var proxyLeaks = map[string]bool{
	"Via": true, "X-Forwarded-For": true, "X-Forwarded-Host": true,
	"X-Forwarded-Proto": true, "X-Real-Ip": true, "Forwarded": true,
	"X-Proxy-Id": true, "X-Cache": true,
}

const (
	idleTimeout = 60 * time.Second
	dialTimeout = 10 * time.Second
)

// newRNG returns a per-connection PRNG seeded from crypto/rand. Per-connection
// (not the global source) avoids lock contention between connection goroutines;
// crypto seeding means the jitter/profile pattern isn't predictable.
func newRNG() *mrand.Rand {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return mrand.New(mrand.NewSource(int64(binary.LittleEndian.Uint64(b[:])))) //nolint:gosec // non-crypto use
}

// handleConn owns one accepted client connection end to end.
func handleConn(conn net.Conn, jitterMax time.Duration, forceProfile *Profile) {
	defer conn.Close()
	// Panic isolation: one malformed stream must not crash the process (a crash
	// could dump memory and drop every other tunnel).
	defer func() { _ = recover() }()

	_ = conn.SetDeadline(time.Now().Add(idleTimeout))
	rng := newRNG()

	profile := pickProfile(rng.Uint64())
	if forceProfile != nil {
		profile = *forceProfile
	}

	br := bufio.NewReader(conn)
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}

	// CONNECT = opaque TCP tunnel (Model A). We CANNOT forge the upstream TLS
	// fingerprint here: the client performs its own end-to-end TLS through the
	// tunnel, so the JA3 on the wire is the client's, not ours. We tunnel it
	// straight and rely only on the client<->proxy TLS for confidentiality.
	if req.Method == http.MethodConnect {
		tunnel(conn, req.RequestURI, rng, jitterMax)
		return
	}

	// Otherwise: rewriting fetch. The upstream URL arrives as the path, e.g.
	//   GET /https://example.com/page?q=1 HTTP/1.1
	target := strings.TrimPrefix(req.RequestURI, "/")
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		writeSimple(conn, 400, "bad or missing absolute upstream URL")
		return
	}

	if err := fetch(conn, req, u, profile, rng, jitterMax); err != nil {
		writeSimple(conn, 502, "upstream fetch failed")
	}
}

// tunnel wires an opaque bidirectional TCP relay for CONNECT.
func tunnel(client net.Conn, hostport string, rng *mrand.Rand, jitterMax time.Duration) {
	if _, _, err := net.SplitHostPort(hostport); err != nil {
		writeSimple(client, 400, "bad CONNECT target")
		return
	}
	up, err := net.DialTimeout("tcp", hostport, dialTimeout)
	if err != nil {
		writeSimple(client, 502, "connect failed")
		return
	}
	// Clear our own deadline; splice manages liveness via half-close.
	_ = client.SetDeadline(time.Time{})
	_, _ = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	splice(client, up, rng, jitterMax)
}

// fetch performs the forged upstream request over a uTLS (https) or plain (http)
// connection and streams the response back to the client.
func fetch(client net.Conn, in *http.Request, u *url.URL, p Profile, rng *mrand.Rand, jitterMax time.Duration) error {
	// Build a clean outbound request. We do NOT forward the client's original
	// headers wholesale — those can leak the proxy or the real client. We start
	// empty and forge a coherent set (component 4).
	out, err := http.NewRequest(in.Method, u.String(), in.Body)
	if err != nil {
		return err
	}
	applyRequestHeaders(out, p)
	// Preserve only body-shape headers the origin genuinely needs.
	if ct := in.Header.Get("Content-Type"); ct != "" {
		out.Header.Set("Content-Type", ct)
	}
	out.ContentLength = in.ContentLength

	resp, err := roundTrip(out, u, p)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	sanitizeResponseHeaders(resp.Header)

	// Status line + hygiene'd headers, then stream the body through the zeroing,
	// optionally-jittered copy loop.
	if _, err := fmt.Fprintf(client, "HTTP/1.1 %d %s\r\n", resp.StatusCode, http.StatusText(resp.StatusCode)); err != nil {
		return err
	}
	_ = resp.Header.Write(client)
	_, _ = io.WriteString(client, "\r\n")
	_, err = pipe(client, resp.Body, rng, jitterMax)
	return err
}

// roundTrip dials the upstream with the profile's TLS fingerprint and performs
// the request, transparently handling HTTP/2 (what a real Chrome/Firefox would
// negotiate via ALPN) or falling back to HTTP/1.1.
func roundTrip(req *http.Request, u *url.URL, p Profile) (*http.Response, error) {
	host := u.Hostname()
	if u.Scheme == "http" {
		// Plain HTTP upstream: no TLS fingerprint to mimic.
		port := u.Port()
		if port == "" {
			port = "80"
		}
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), dialTimeout)
		if err != nil {
			return nil, err
		}
		if err := req.Write(conn); err != nil {
			return nil, err
		}
		return http.ReadResponse(bufio.NewReader(conn), req)
	}

	port := u.Port()
	if port == "" {
		port = "443"
	}
	uconn, err := dialUTLS(net.JoinHostPort(host, port), host, p.ClientHelloID)
	if err != nil {
		return nil, err
	}

	// What did the server pick over ALPN? A real Chrome almost always ends up on
	// h2; honoring that keeps the whole exchange coherent with the fingerprint.
	if uconn.ConnectionState().NegotiatedProtocol == "h2" {
		cc, err := (&http2.Transport{}).NewClientConn(uconn)
		if err != nil {
			return nil, err
		}
		req.URL.Scheme = "https"
		req.URL.Host = net.JoinHostPort(host, port)
		return cc.RoundTrip(req)
	}

	if err := req.Write(uconn); err != nil {
		return nil, err
	}
	return http.ReadResponse(bufio.NewReader(uconn), req)
}

// dialUTLS opens TCP and completes a TLS handshake whose Client Hello mimics the
// given browser (component 2). Upstream certificate verification stays ON —
// mimicry is about *our* hello bytes, not about trusting anyone less.
func dialUTLS(addr, sni string, id utls.ClientHelloID) (*utls.UConn, error) {
	tcp, err := net.DialTimeout("tcp", addr, dialTimeout)
	if err != nil {
		return nil, err
	}
	cfg := &utls.Config{ServerName: sni, MinVersion: utls.VersionTLS12, MaxVersion: utls.VersionTLS13}
	uconn := utls.UClient(tcp, cfg, id)
	if err := uconn.Handshake(); err != nil {
		_ = tcp.Close()
		return nil, err
	}
	return uconn, nil
}

// applyRequestHeaders forges a coherent identity for the chosen profile. The
// Sec-Ch-Ua* client hints are Chrome-only: we add them ONLY when the profile
// provides them, so a Firefox identity never carries Chrome-shaped headers.
func applyRequestHeaders(req *http.Request, p Profile) {
	req.Header.Set("User-Agent", p.UserAgent)
	req.Header.Set("Accept", p.Accept)
	req.Header.Set("Accept-Language", p.AcceptLanguage)
	req.Header.Set("Accept-Encoding", p.AcceptEncoding)
	req.Header.Set("Upgrade-Insecure-Requests", "1")
	if p.SecChUa != "" {
		req.Header.Set("Sec-Ch-Ua", p.SecChUa)
		req.Header.Set("Sec-Ch-Ua-Mobile", p.SecChUaMobile)
		req.Header.Set("Sec-Ch-Ua-Platform", p.SecChUaPlatform)
	}
}

// sanitizeResponseHeaders strips hop-by-hop and proxy-revealing headers before
// the response reaches the client, so nothing announces the intermediary.
func sanitizeResponseHeaders(h http.Header) {
	for name := range h {
		canon := http.CanonicalHeaderKey(name)
		if hopByHop[canon] || proxyLeaks[canon] {
			h.Del(name)
		}
	}
}

func writeSimple(w io.Writer, code int, msg string) {
	_, _ = fmt.Fprintf(w, "HTTP/1.1 %d %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		code, http.StatusText(code), len(msg), msg)
}
