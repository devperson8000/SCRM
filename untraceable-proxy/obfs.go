package main

// obfs.go — the padding half of component 3, and the one honest limitation in
// the whole integration.
//
// WHY THIS IS A SEPARATE, OPT-IN MODULE and not wired into the upstream path:
//
// Frame padding only works when BOTH ends speak the padding protocol, because
// the receiver has to recognize and DISCARD the padding frames. Your upstream
// is an arbitrary website (google.com, etc.) — it does NOT run this protocol,
// so you cannot inject padding frames into that stream without corrupting it.
//
// Therefore padding can only be applied on a leg you control on BOTH ends:
//   - proxy  <-> a cooperating client (your own app / service worker), or
//   - proxy  <-> proxy  (a chained hop you also operate).
//
// And even then, restated from the review: single-scheme padding is weak
// against a competent traffic-analysis adversary and a *distinctive* padding
// pattern becomes its own fingerprint. This is here for the controlled-peer
// case and to be explicit about the boundary — not as a promise of anonymity.

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	mrand "math/rand"
)

const (
	frameData = 0x00 // real payload; deliver to the application
	framePad  = 0x01 // padding; receiver reads and discards

	maxFrame = 0xffff // 16-bit length field
)

// writeFrame emits one real frame, optionally preceded by a random-sized pad
// frame so an observer can't read the payload length off the packet length.
// Padding bytes come from crypto/rand so they are indistinguishable from the
// surrounding ciphertext once the whole stream is wrapped in TLS.
func writeFrame(w io.Writer, payload []byte, rng *mrand.Rand) error {
	if len(payload) > maxFrame {
		return errors.New("obfs: payload exceeds max frame size")
	}
	if rng.Intn(10) < 3 { // ~30% of frames get a pad companion
		padLen := rng.Intn(512) + 1
		pad := make([]byte, padLen)
		if _, err := rand.Read(pad); err != nil {
			return err
		}
		if err := putFrame(w, framePad, pad); err != nil {
			return err
		}
	}
	return putFrame(w, frameData, payload)
}

func putFrame(w io.Writer, typ byte, p []byte) error {
	var hdr [3]byte
	hdr[0] = typ
	binary.BigEndian.PutUint16(hdr[1:], uint16(len(p)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(p)
	return err
}

// readFrame returns the next real payload, transparently skipping pad frames.
func readFrame(r io.Reader) ([]byte, error) {
	for {
		var hdr [3]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return nil, err
		}
		n := binary.BigEndian.Uint16(hdr[1:])
		buf := make([]byte, n)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		if hdr[0] == framePad {
			continue // discard and keep reading
		}
		return buf, nil
	}
}
