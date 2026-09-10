package main

// profile.go — the coherence contract.
//
// The single most important integration rule from the design review: the TLS
// Client Hello (JA3/JA4), the ALPN set, and the HTTP identity headers must all
// tell the SAME story. A Chrome JA3 next to a Firefox User-Agent is *more*
// detectable than no obfuscation at all, because no real browser emits that
// combination. So we bind the uTLS ClientHelloID and the header set together
// into one struct that can never drift apart, and choose exactly one per
// upstream connection.

import (
	utls "github.com/refraction-networking/utls"
)

// Profile pins a browser identity across every layer of the stack.
type Profile struct {
	Name string

	// ClientHelloID drives the TLS fingerprint (component 2). uTLS rewrites
	// the Client Hello bytes — cipher order, extensions, GREASE, key shares,
	// signature algorithms — to match this browser.
	ClientHelloID utls.ClientHelloID

	// The HTTP identity (component 4). Every value here must be consistent
	// with ClientHelloID: same browser, same major version, same platform.
	UserAgent       string
	Accept          string
	AcceptLanguage  string
	AcceptEncoding  string
	SecChUa         string
	SecChUaMobile   string
	SecChUaPlatform string
}

// chromeWin mimics a desktop Chrome on Windows.
//
// NOTE ON VERSION PINNING: we use HelloChrome_Auto so this compiles and tracks
// whatever Chrome uTLS ships as "current". That is convenient but weaker than
// pinning: "Auto" changes its JA3 as you upgrade the uTLS library, and a JA3
// that drifts over time is itself a (weak) fingerprint. It also risks going out
// of sync with the hard-coded UserAgent below. In production, pin BOTH together
// — e.g. utls.HelloChrome_120 with a Chrome/120 UA — and bump them in lockstep.
var chromeWin = Profile{
	Name:            "chrome-win",
	ClientHelloID:   utls.HelloChrome_Auto,
	UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	AcceptLanguage:  "en-US,en;q=0.9",
	AcceptEncoding:  "gzip, deflate, br, zstd",
	SecChUa:         `"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`,
	SecChUaMobile:   "?0",
	SecChUaPlatform: `"Windows"`,
}

// firefoxWin mimics a desktop Firefox on Windows. Firefox does not send the
// Sec-Ch-Ua client-hint headers at all — so we deliberately leave them empty,
// and applyRequestHeaders must NOT add them for this profile. Adding Chrome-only
// headers to a Firefox identity is exactly the kind of incoherence that flags.
var firefoxWin = Profile{
	Name:           "firefox-win",
	ClientHelloID:  utls.HelloFirefox_Auto,
	UserAgent:      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
	Accept:         "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	AcceptLanguage: "en-US,en;q=0.5",
	AcceptEncoding: "gzip, deflate, br, zstd",
	// SecChUa* intentionally blank for Firefox.
}

var profiles = []Profile{chromeWin, firefoxWin}

// pickProfile selects a profile deterministically from a per-connection seed.
// We avoid math/rand's global source here; the caller passes a seed derived
// from crypto/rand so profile choice isn't itself a predictable pattern.
func pickProfile(seed uint64) Profile {
	return profiles[seed%uint64(len(profiles))]
}
