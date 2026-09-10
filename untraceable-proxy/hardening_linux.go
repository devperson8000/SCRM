//go:build linux

package main

// hardening.go (Linux) — the endpoint-forensics defense that actually matters.
//
// From the review: buffer-zeroing is ~1% of the value. THIS is the other 99%.
// A single swap-out or core dump writes plaintext to disk and defeats the whole
// "RAM-only" goal in one syscall. These two calls close that hole.

import (
	"golang.org/x/sys/unix"
)

// harden locks all current and future pages into RAM (no swap) and forbids core
// dumps (no memory image on crash). Mlockall needs CAP_IPC_LOCK or a raised
// RLIMIT_MEMLOCK; we treat failure as non-fatal but report it, because running
// without it silently weakens the guarantee the rest of the code implies.
func harden() []error {
	var errs []error

	if err := unix.Mlockall(unix.MCL_CURRENT | unix.MCL_FUTURE); err != nil {
		errs = append(errs, err)
	}

	// RLIMIT_CORE = 0 => the kernel never writes a core file for this process.
	if err := unix.Setrlimit(unix.RLIMIT_CORE, &unix.Rlimit{Cur: 0, Max: 0}); err != nil {
		errs = append(errs, err)
	}

	return errs
}
