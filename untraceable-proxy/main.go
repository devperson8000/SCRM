package main

// main.go — wiring, flags, and startup hardening.

import (
	"flag"
	"log"
	"time"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:8443", "client<->proxy TLS listen address")
	jitterMs := flag.Int("jitter-ms", 0, "max per-chunk timing jitter in ms (0 = off; adds latency)")
	profileName := flag.String("profile", "auto", "browser profile: auto | chrome-win | firefox-win")
	flag.Parse()

	// Endpoint-forensics hardening FIRST, before we touch any secrets: lock
	// pages into RAM (no swap) and forbid core dumps. Non-fatal but loud on
	// failure — running without it silently weakens the RAM-only guarantee.
	for _, err := range harden() {
		log.Printf("[hardening] WARNING: %v", err)
	}

	var forced *Profile
	switch *profileName {
	case "auto":
		forced = nil
	case "chrome-win":
		forced = &chromeWin
	case "firefox-win":
		forced = &firefoxWin
	default:
		log.Fatalf("unknown profile %q", *profileName)
	}

	cert, err := ephemeralCert()
	if err != nil {
		log.Fatalf("cert: %v", err)
	}

	ln, err := listen(*addr, cert)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	jitter := time.Duration(*jitterMs) * time.Millisecond
	log.Printf("listening on %s (profile=%s jitter=%s)", *addr, *profileName, jitter)
	log.Printf("test: curl -k https://%s/https://example.com/", *addr)

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			continue
		}
		go handleConn(conn, jitter, forced)
	}
}
