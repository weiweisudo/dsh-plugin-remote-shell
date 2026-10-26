package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const maxShellSessions = 8

type sessionResult struct {
	ExitCode   int
	Stdout     string
	Stderr     string
	Truncated  bool
	TimedOut   bool
	DurationMS int64
	CWD        string
}

type shellSession struct {
	id     string
	shell  string
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	lines  chan string
	done   chan error

	stderrMu  sync.Mutex
	stderrBuf *capBuffer

	execMu    sync.Mutex
	closeOnce sync.Once
	closed    bool
}

type sessionManager struct {
	mu       sync.Mutex
	sessions map[string]*shellSession
}

func newSessionManager() *sessionManager {
	return &sessionManager{sessions: make(map[string]*shellSession)}
}

func (m *sessionManager) open(id, shell, cwd string) (*shellSession, error) {
	if id == "" {
		return nil, errors.New("session id is required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.sessions[id]; exists {
		return nil, fmt.Errorf("session %q already exists", id)
	}
	if len(m.sessions) >= maxShellSessions {
		return nil, fmt.Errorf("too many shell sessions (max %d)", maxShellSessions)
	}
	s, err := startShellSession(id, shell, cwd)
	if err != nil {
		return nil, err
	}
	m.sessions[id] = s
	return s, nil
}

func (m *sessionManager) get(id string) *shellSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *sessionManager) remove(id string) {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if s != nil {
		s.close()
	}
}

func (m *sessionManager) closeAll() {
	m.mu.Lock()
	list := make([]*shellSession, 0, len(m.sessions))
	for id, s := range m.sessions {
		list = append(list, s)
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	for _, s := range list {
		s.close()
	}
}

func startShellSession(id, shell, cwd string) (*shellSession, error) {
	if strings.TrimSpace(shell) == "" {
		if runtime.GOOS == "windows" {
			shell = "powershell"
		} else {
			shell = "bash"
		}
	}
	path, args, ps, err := sessionCommand(shell)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(path, args...)
	if strings.TrimSpace(cwd) != "" {
		cmd.Dir = cwd
	}
	cmd.Env = commandEnvironment(os.Environ())
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}
	s := &shellSession{
		id:        id,
		shell:     shell,
		cmd:       cmd,
		stdin:     stdin,
		stdout:    bufio.NewReaderSize(stdout, 64<<10),
		lines:     make(chan string, 2048),
		done:      make(chan error, 1),
		stderrBuf: &capBuffer{limit: maxStreamBytes},
	}
	_ = ps // kept for readability of the platform switch below
	go s.readStdout()
	go s.readStderr(stderr)
	go func() { s.done <- cmd.Wait() }()
	return s, nil
}

func (s *shellSession) readStdout() {
	for {
		line, err := s.stdout.ReadString('\n')
		if len(line) > 0 {
			// The command reader drains this channel. Blocking here preserves
			// marker lines even when a command produces a lot of output.
			s.lines <- line
		}
		if err != nil {
			return
		}
	}
}

func (s *shellSession) readStderr(r io.Reader) {
	reader := bufio.NewReaderSize(r, 32<<10)
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			s.stderrMu.Lock()
			_, _ = s.stderrBuf.Write([]byte(line))
			s.stderrMu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (s *shellSession) exec(ctx context.Context, command string, timeout time.Duration) (sessionResult, error) {
	s.execMu.Lock()
	defer s.execMu.Unlock()
	if s.closed {
		return sessionResult{}, errors.New("session is closed")
	}
	// Drop any prompt/leftover output from the previous command.
	for {
		select {
		case <-s.lines:
			continue
		default:
		}
		break
	}
	s.stderrMu.Lock()
	s.stderrBuf = &capBuffer{limit: maxStreamBytes}
	s.stderrMu.Unlock()

	token := randomSessionToken()
	doneMarker := "__DSH_DONE_" + token + "__ "
	cwdMarker := "__DSH_CWD_" + token + "__ "
	script := sessionScript(s.shell, command, token)
	if _, err := io.WriteString(s.stdin, script); err != nil {
		s.close()
		return sessionResult{}, fmt.Errorf("write command: %w", err)
	}

	start := time.Now()
	stdout := &capBuffer{limit: maxStreamBytes}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	done := false
	exitCode := -1
	cwd := ""
	for {
		select {
		case line := <-s.lines:
			if strings.HasPrefix(line, doneMarker) {
				_, _ = fmt.Sscanf(strings.TrimSpace(strings.TrimPrefix(line, doneMarker)), "%d", &exitCode)
				done = true
			} else if strings.HasPrefix(line, cwdMarker) {
				cwd = strings.TrimSpace(strings.TrimPrefix(line, cwdMarker))
			} else if !done {
				_, _ = stdout.Write([]byte(line))
			}
		case err := <-s.done:
			if err != nil {
				return sessionResult{}, fmt.Errorf("session exited: %w", err)
			}
			return sessionResult{}, errors.New("session exited")
		case <-ctx.Done():
			s.close()
			return sessionResult{TimedOut: true, ExitCode: -1, DurationMS: time.Since(start).Milliseconds()}, ctx.Err()
		case <-timer.C:
			s.close()
			return sessionResult{TimedOut: true, ExitCode: -1, DurationMS: time.Since(start).Milliseconds()}, errors.New("command timed out")
		}
		if done && cwd != "" {
			time.Sleep(10 * time.Millisecond)
			s.stderrMu.Lock()
			stderr := s.stderrBuf.String()
			truncated := stdout.truncated || s.stderrBuf.truncated
			s.stderrMu.Unlock()
			return sessionResult{
				ExitCode:   exitCode,
				Stdout:     stdout.String(),
				Stderr:     stderr,
				Truncated:  truncated,
				CWD:        cwd,
				DurationMS: time.Since(start).Milliseconds(),
			}, nil
		}
	}
}

func (s *shellSession) close() {
	s.closeOnce.Do(func() {
		s.closed = true
		_ = s.stdin.Close()
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
	})
}

func randomSessionToken() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func sessionCommand(shell string) (path string, args []string, powerShell bool, err error) {
	shell = strings.ToLower(strings.TrimSpace(shell))
	if runtime.GOOS == "windows" {
		switch shell {
		case "", "powershell":
			root := os.Getenv("SystemRoot")
			if root == "" {
				root = `C:\Windows`
			}
			return filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				[]string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"}, true, nil
		case "pwsh":
			return "pwsh.exe", []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"}, true, nil
		case "cmd":
			return "", nil, false, errors.New("persistent cmd.exe sessions are not supported; use powershell or one-shot remote_exec")
		default:
			return "", nil, false, fmt.Errorf("unsupported Windows session shell %q", shell)
		}
	}
	var name string
	var shellArgs []string
	switch shell {
	case "", "bash":
		name, shellArgs = "bash", []string{"--noprofile", "--norc"}
	case "sh":
		name = "sh"
	case "pwsh":
		return "pwsh", []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"}, true, nil
	default:
		return "", nil, false, fmt.Errorf("unsupported Unix session shell %q", shell)
	}
	// A persistent shell writes to a pipe, where libc stdio is block-buffered.
	// Force line buffering so markers are visible before the session exits.
	if _, err := exec.LookPath("stdbuf"); err == nil {
		return "stdbuf", append([]string{"-oL", "-eL", name}, shellArgs...), false, nil
	}
	return name, shellArgs, false, nil
}

func sessionScript(shell, command, token string) string {
	if strings.EqualFold(shell, "powershell") || strings.EqualFold(shell, "pwsh") {
		return fmt.Sprintf(`%s
$global:LASTEXITCODE = $null
$__dsh_ok = $?
$__dsh_ec = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($__dsh_ok) { 0 } else { 1 }
[Console]::Out.WriteLine("")
[Console]::Out.WriteLine("__DSH_DONE_%s__ $__dsh_ec")
[Console]::Out.WriteLine("__DSH_CWD_%s__ $($PWD.Path)")
`, command, token, token)
	}
	return fmt.Sprintf(`%s
__dsh_ec=$?
printf '\n__DSH_DONE_%s__ %%d\n' "$__dsh_ec"
printf '__DSH_CWD_%s__ %%s\n' "$PWD"
`, command, token, token)
}
