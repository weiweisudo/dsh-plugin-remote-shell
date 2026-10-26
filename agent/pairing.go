package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type credentials struct {
	Endpoint  string `json:"endpoint"`
	MachineID string `json:"machine_id"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at,omitempty"`
	UpdatedAt string `json:"updated_at"`
}

func defaultCredentialsPath() string {
	if runtime.GOOS == "windows" {
		if base := os.Getenv("LOCALAPPDATA"); base != "" {
			return filepath.Join(base, "dsh-remote-shell", "credentials.json")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "credentials.json"
	}
	return filepath.Join(home, ".dsh", "remote-shell", "credentials.json")
}

func parsePairLink(raw string) (endpoint, secret string, err error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", "", err
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return "", "", errors.New("pair link must use ws:// or wss://")
	}
	secret = strings.TrimSpace(u.Fragment)
	secret = strings.TrimPrefix(secret, "pair=")
	if secret == "" {
		return "", "", errors.New("pair link is missing the #secret fragment")
	}
	u.Fragment = ""
	return u.String(), secret, nil
}

func loadCredentials(path string) (*credentials, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c credentials
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse credentials: %w", err)
	}
	if c.Endpoint == "" || c.Token == "" || c.MachineID == "" {
		return nil, errors.New("credentials are incomplete")
	}
	return &c, nil
}

func saveCredentials(path, endpoint, machineID, token, expiresAt string) error {
	if path == "" {
		return errors.New("empty credentials path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	c := credentials{
		Endpoint:  endpoint,
		MachineID: machineID,
		Token:     token,
		ExpiresAt: expiresAt,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	b, err := json.MarshalIndent(c, "", "  ")
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
