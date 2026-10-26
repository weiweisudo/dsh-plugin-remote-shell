//go:build !windows

package main

// platformEarly is a no-op on Linux/macOS: the headless agent keeps the
// existing flag-driven CLI and has no tray/service modes.
func platformEarly(_ []string) (bool, error) {
	return false, nil
}
