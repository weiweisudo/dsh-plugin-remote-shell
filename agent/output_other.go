//go:build !windows

package main

func decodeShellOutput(_ string, b []byte) string { return string(b) }
