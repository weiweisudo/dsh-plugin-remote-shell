//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	errAlreadyRunning = errors.New("another Juzi Session agent is already running")
	procShellExecute  = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteW")
	procMessageBox    = windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW")
)

const singleInstanceName = `Local\JuziSessionAgent-p0`

func processElevated() bool {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return false
	}
	defer token.Close()
	return token.IsElevated()
}

func acquireSingleInstance(wait time.Duration) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(singleInstanceName)
	if err != nil {
		return 0, err
	}
	deadline := time.Now().Add(wait)
	for {
		h, err := windows.CreateMutex(nil, false, name)
		if err == nil {
			return h, nil
		}
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			if h != 0 {
				_ = windows.CloseHandle(h)
			}
			if time.Now().After(deadline) {
				return 0, errAlreadyRunning
			}
			time.Sleep(150 * time.Millisecond)
			continue
		}
		return 0, err
	}
}

func releaseSingleInstance(h windows.Handle) {
	if h != 0 {
		_ = windows.CloseHandle(h)
	}
}

func relaunchAsAdmin() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString("--elevated")
	r, _, callErr := procShellExecute.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(file)),
		uintptr(unsafe.Pointer(params)),
		0,
		uintptr(1), // SW_SHOWNORMAL
	)
	if r <= 32 {
		return fmt.Errorf("ShellExecuteW runas failed: %v (code %d)", callErr, r)
	}
	return nil
}

func showAgentMessage(text, caption string) {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(caption)
	_, _, _ = procMessageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x40) // MB_ICONINFORMATION
}
