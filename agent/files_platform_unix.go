//go:build !windows

package main

import (
	"os"
	"path/filepath"
)

func defaultUploadRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "juzi-downloads")
	}
	if serviceMode {
		return filepath.Join(home, ".local", "share", "juzi", "downloads")
	}
	return filepath.Join(home, "Downloads")
}

func replaceFile(src, dst string) error {
	return os.Rename(src, dst)
}
