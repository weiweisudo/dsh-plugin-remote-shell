//go:build windows

package main

import (
	"strings"
	"syscall"
	"unicode/utf8"

	"golang.org/x/sys/windows"
)

var procGetOEMCP = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetOEMCP")

// decodeShellOutput decodes cmd.exe output bytes from the OEM code page when
// they are not valid UTF-8. PowerShell output is already UTF-8 via its script
// prelude. This is a fallback for cmd builtins such as echo/dir.
func decodeShellOutput(shell string, b []byte) string {
	name := strings.ToLower(strings.TrimSpace(shell))
	if name != "" && name != "cmd" {
		return string(b)
	}
	if len(b) == 0 || utf8.Valid(b) {
		return string(b)
	}
	cp, _, _ := procGetOEMCP.Call()
	if cp == 0 {
		cp = 936
	}
	n, err := windows.MultiByteToWideChar(uint32(cp), 0, &b[0], int32(len(b)), nil, 0)
	if err != nil || n <= 0 {
		return string(b)
	}
	buf := make([]uint16, n)
	if _, err := windows.MultiByteToWideChar(uint32(cp), 0, &b[0], int32(len(b)), &buf[0], n); err != nil {
		return string(b)
	}
	return syscall.UTF16ToString(buf)
}
