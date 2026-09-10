package main

// server.go — component 5, server side: the client <-> proxy TLS 1.3 listener
// enforcing Perfect Forward Secrecy.

import (
	"crypto/tls"
	"net"
)

// pfsListenerConfig enforces TLS 1.3 only. Every TLS 1.3 suite is AEAD and every
// key exchange is ephemeral ECDHE, so PFS is guaranteed by the protocol — you
// cannot accidentally turn it off. (crypto/tls ignores the CipherSuites field
// for 1.3; suite choice is automatic, preferring AES-GCM with AES-NI and
// ChaCha20-Poly1305 without it.)
func pfsListenerConfig(cert tls.Certificate) *tls.Config {
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13, // 1.3 only: no downgrade to 1.2 ciphers
		MaxVersion:   tls.VersionTLS13,

		// X25519 first: a fresh ephemeral key per handshake — the mechanism of
		// PFS. X25519MLKEM768 (post-quantum hybrid) is offered by default in
		// modern Go and is also forward-secret; leaving the default in place is
		// fine, but we pin the classical order for a stable, explained config.
		CurvePreferences: []tls.CurveID{tls.X25519, tls.CurveP256},

		// Session tickets, if reused across handshakes, can weaken PFS. Disabling
		// them forces a full ephemeral handshake per connection — the right trade
		// for a privacy proxy, at the cost of resumption/0-RTT. Rotate ticket
		// keys frequently instead if you must keep resumption.
		SessionTicketsDisabled: true,
	}
}

func listen(addr string, cert tls.Certificate) (net.Listener, error) {
	return tls.Listen("tcp", addr, pfsListenerConfig(cert))
}
