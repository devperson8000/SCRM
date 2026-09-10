package main

// forward.go — component 1 (zero-footprint in-memory streaming) and the timing
// half of component 3 (jitter).
//
// Honest scope, restated from the design review:
//   - The streaming loop below never touches disk and never logs payloads.
//     That part is real and valuable.
//   - Zeroing the buffer after use is kept because it is free, but it is a WEAK
//     anti-forensic control in a GC language (the runtime may have copied the
//     bytes elsewhere; the kernel's socket buffers hold copies you can't reach).
//     The real endpoint-forensics defenses live in hardening.go and in how you
//     run the process (no swap, no core dumps, ephemeral disk).

import (
	"io"
	mrand "math/rand"
	"net"
	"sync"
	"time"
)

// 32 KiB matches io.Copy's internal default and the typical TLS record ceiling,
// so we rarely do partial-record reads.
const bufSize = 32 * 1024

var bufPool = sync.Pool{
	New: func() any {
		b := make([]byte, bufSize)
		return &b
	},
}

// pipe streams src -> dst entirely through one pooled, reused buffer, then wipes
// it before returning it to the pool. If jitterMax > 0 it sleeps a small,
// non-uniform delay between chunks to blur inter-packet timing (component 3).
//
// The jitter here is deliberately tiny and capped: it is a decorrelation nudge
// for a casual observer, NOT a defense against a real traffic-analysis
// adversary (see obfs.go for why single-ended padding/jitter is limited).
func pipe(dst io.Writer, src io.Reader, rng *mrand.Rand, jitterMax time.Duration) (int64, error) {
	bp := bufPool.Get().(*[]byte)
	buf := *bp
	defer func() {
		for i := range buf { // best-effort wipe; see honest caveat above.
			buf[i] = 0
		}
		bufPool.Put(bp)
	}()

	var total int64
	for {
		nr, er := src.Read(buf)
		if nr > 0 {
			if jitterMax > 0 && rng != nil {
				jitterSleep(rng, jitterMax)
			}
			nw, ew := dst.Write(buf[:nr])
			total += int64(nw)
			if ew != nil {
				return total, ew
			}
			if nw < nr {
				return total, io.ErrShortWrite
			}
		}
		if er != nil {
			if er == io.EOF {
				return total, nil
			}
			return total, er
		}
	}
}

// jitterSleep draws a non-uniform micro-delay: mostly near-zero, occasionally
// up to jitterMax. A uniform delay is a weak defense and adds constant latency;
// a skewed distribution costs less on average while still breaking a perfectly
// periodic timing signature.
func jitterSleep(rng *mrand.Rand, jitterMax time.Duration) {
	// 1-in-6 chance of any delay at all; when it fires, a fraction of the cap.
	if rng.Intn(6) != 0 {
		return
	}
	d := time.Duration(rng.Int63n(int64(jitterMax)))
	if d > 0 {
		time.Sleep(d)
	}
}

// splice runs a full-duplex forward between two connections and blocks until
// BOTH directions finish. Half-close is propagated so a one-sided idle stream
// (long-poll, SSE) gets a clean EOF instead of leaking a goroutine forever —
// and a leaked goroutine pins its buffers, quietly defeating the zeroing above.
func splice(a, b net.Conn, rng *mrand.Rand, jitterMax time.Duration) {
	var wg sync.WaitGroup
	wg.Add(2)

	oneWay := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = pipe(dst, src, rng, jitterMax)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.SetReadDeadline(time.Now()) // fallback: unblock the peer
		}
	}

	go oneWay(a, b)
	go oneWay(b, a)
	wg.Wait()
	_ = a.Close()
	_ = b.Close()
}
