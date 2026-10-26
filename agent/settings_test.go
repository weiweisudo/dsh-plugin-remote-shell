package main

import (
	"path/filepath"
	"testing"
)

func TestSavedDeviceName(t *testing.T) {
	dir := t.TempDir()
	creds := filepath.Join(dir, "credentials.json")
	if err := saveSavedName(creds, "书房 Windows PC"); err != nil {
		t.Fatal(err)
	}
	if got := loadSavedName(creds); got != "书房 Windows PC" {
		t.Fatalf("loadSavedName = %q", got)
	}
	cfg := &config{credentialsFile: creds, name: "hostname"}
	applySavedName(cfg)
	if cfg.name != "书房 Windows PC" {
		t.Fatalf("applySavedName = %q", cfg.name)
	}
	explicit := &config{credentialsFile: creds, name: "explicit", nameExplicit: true}
	applySavedName(explicit)
	if explicit.name != "explicit" {
		t.Fatalf("explicit name was overwritten: %q", explicit.name)
	}
}
