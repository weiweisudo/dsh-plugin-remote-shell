//go:build !windows

package main

import "os/exec"

func configureShellProcess(_ *exec.Cmd) {}
