//go:build windows

package main

import (
	"errors"
	"flag"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// platformEarly handles Windows-only process modes before the generic flag
// parser runs. Keeping it here means the Linux build stays headless and small.
var procAttachConsole = windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")

const attachParentProcess = ^uint32(0)

func attachParentConsole(args []string) {
	if len(args) < 2 {
		return
	}
	if r, _, _ := procAttachConsole.Call(uintptr(attachParentProcess)); r == 0 {
		return
	}
	if out, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout = out
		os.Stderr = out
	}
}

func platformEarly(args []string) (bool, error) {
	attachParentConsole(args)
	if len(args) < 2 {
		return true, runDesktop(defaultDesktopConfig())
	}
	switch args[1] {
	case "service":
		return true, serviceCommand(args[2:])
	case "ui":
		return true, runDesktop(defaultDesktopConfig())
	case "--service":
		return true, runWindowsService()
	}
	return false, nil
}

func defaultDesktopConfig() *config {
	cfg := &config{
		port:            47600,
		timeout:         30 * time.Second,
		name:            hostnameOr(""),
		credentialsFile: defaultCredentialsPath(),
	}
	return cfg
}

func hostnameOr(fallback string) string {
	if name, err := os.Hostname(); err == nil && name != "" {
		return name
	}
	return fallback
}

func serviceCommand(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: remote-agent service install|uninstall|start|stop")
	}
	fs := flag.NewFlagSet("service", flag.ContinueOnError)
	credentials := fs.String("credentials", defaultCredentialsPath(), "credentials file to copy into ProgramData")
	_ = fs.Parse(args[1:])
	switch args[0] {
	case "install":
		return installService(*credentials)
	case "uninstall":
		return uninstallService()
	case "start":
		return startService()
	case "stop":
		return stopService()
	default:
		return errors.New("unknown service command: " + args[0])
	}
}
