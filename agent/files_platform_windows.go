//go:build windows

package main

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func defaultUploadRoot() string {
	if serviceMode {
		if dir := os.Getenv("ProgramData"); dir != "" {
			return filepath.Join(dir, "dsh-remote-shell", "Downloads")
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, "Downloads")
	}
	return filepath.Join(os.TempDir(), "juzi-downloads")
}

func replaceFile(src, dst string) error {
	srcp, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	dstp, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(srcp, dstp, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		_ = os.Remove(dst)
		return os.Rename(src, dst)
	}
	return nil
}
