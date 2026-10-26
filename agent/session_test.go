//go:build !windows

package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestShellSessionPersistsState(t *testing.T) {
	s, err := startShellSession("test-session", "bash", "")
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := s.exec(ctx, "cd /tmp && export DSH_TEST_VALUE=42 && echo first", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 0 || !strings.Contains(res.Stdout, "first") {
		t.Fatalf("first result: %+v", res)
	}
	res, err = s.exec(ctx, "pwd; printf 'value=%s\\n' \"$DSH_TEST_VALUE\"", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Stdout, "/tmp") || !strings.Contains(res.Stdout, "value=42") {
		t.Fatalf("state was not preserved: %+v", res)
	}
}
