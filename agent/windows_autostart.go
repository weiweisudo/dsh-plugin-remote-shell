//go:build windows

package main

import (
	"errors"
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const (
	autoStartRunKey = `Software\Microsoft\Windows\CurrentVersion\Run`
	autoStartValue  = "DSHRemoteShell"
)

func autoStartEnabled() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, autoStartRunKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	value, _, err := key.GetStringValue(autoStartValue)
	return err == nil && strings.TrimSpace(value) != ""
}

func setAutoStart(enabled bool) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, autoStartRunKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if !enabled {
		if err := key.DeleteValue(autoStartValue); err != nil && !errors.Is(err, registry.ErrNotExist) {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return key.SetStringValue(autoStartValue, `"`+exe+`"`)
}
