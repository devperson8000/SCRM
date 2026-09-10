//go:build !linux

package main

// hardening_other.go — non-Linux stub. Mlockall/RLIMIT_CORE semantics differ
// per OS; on anything but Linux we no-op and say so, rather than pretend the
// process is hardened when it isn't.

import "errors"

func harden() []error {
	return []error{errors.New("memory hardening (mlockall/no-core) only implemented on linux")}
}
