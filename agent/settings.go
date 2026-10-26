package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type localSettings struct {
	Name string `json:"name"`
}

func settingsPath(credentialsFile string) string {
	dir := filepath.Dir(credentialsFile)
	if dir == "." || dir == "" {
		dir = filepath.Dir(defaultCredentialsPath())
	}
	return filepath.Join(dir, "settings.json")
}

func loadSavedName(credentialsFile string) string {
	b, err := os.ReadFile(settingsPath(credentialsFile))
	if err != nil {
		return ""
	}
	var s localSettings
	if json.Unmarshal(b, &s) != nil {
		return ""
	}
	return strings.TrimSpace(s.Name)
}

func saveSavedName(credentialsFile, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("device name cannot be empty")
	}
	if len([]rune(name)) > 80 {
		return errors.New("device name must be at most 80 characters")
	}
	path := settingsPath(credentialsFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(localSettings{Name: name}, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func applySavedName(cfg *config) {
	if cfg == nil || cfg.nameExplicit {
		return
	}
	if name := loadSavedName(cfg.credentialsFile); name != "" {
		cfg.name = name
	}
}
