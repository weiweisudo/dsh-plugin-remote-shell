package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxJobs          = 16
	jobRetention     = 24 * time.Hour
	jobStdoutLimit   = 50 << 20
	jobStderrLimit   = 10 << 20
	defaultTailBytes = 32 << 10
)

type jobSnapshot struct {
	ID         string
	Name       string
	Command    string
	Shell      string
	CWD        string
	Status     string
	ExitCode   int
	StartedAt  string
	DurationMS int64
	BytesOut   int64
	BytesErr   int64
	StdoutTail string
	StderrTail string
	Truncated  bool
}

type cappedWriter struct {
	mu        sync.Mutex
	w         io.Writer
	remaining int64
	written   int64
	truncated bool
}

func (c *cappedWriter) stats() (int64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.written, c.truncated
}

func (c *cappedWriter) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := len(p)
	if c.remaining <= 0 {
		c.truncated = true
		return n, nil
	}
	if int64(len(p)) > c.remaining {
		c.truncated = true
		p = p[:c.remaining]
	}
	written, err := c.w.Write(p)
	c.written += int64(written)
	c.remaining -= int64(written)
	if err != nil {
		return written, err
	}
	return n, nil
}

type job struct {
	id      string
	name    string
	command string
	shell   string
	cwd     string

	stdoutPath string
	stderrPath string
	stdout     *cappedWriter
	stderr     *cappedWriter

	startedAt time.Time
	endedAt   time.Time
	proc      *runningCommand
	done      chan struct{}

	mu       sync.Mutex
	exitCode int
	err      error
	canceled bool
}

func (j *job) finish(code int, err error) {
	j.mu.Lock()
	j.exitCode = code
	j.err = err
	j.endedAt = time.Now()
	j.mu.Unlock()
	close(j.done)
}

func (j *job) cancel() {
	select {
	case <-j.done:
		return // already finished; do not relabel a completed job as canceled
	default:
	}
	j.mu.Lock()
	j.canceled = true
	j.mu.Unlock()
	if j.proc != nil {
		_ = j.proc.terminate()
	}
}

func (j *job) snapshot(wait time.Duration, tailBytes int) jobSnapshot {
	if wait > 0 {
		timer := time.NewTimer(wait)
		select {
		case <-j.done:
		case <-timer.C:
		}
		timer.Stop()
	}
	j.mu.Lock()
	status := "running"
	exitCode := j.exitCode
	err := j.err
	canceled := j.canceled
	endedAt := j.endedAt
	j.mu.Unlock()
	select {
	case <-j.done:
		switch {
		case canceled:
			status = "canceled"
		case exitCode < 0 || (err != nil && exitCode == 0):
			status = "failed"
		default:
			status = "exited"
		}
	default:
		if canceled {
			status = "canceling"
		}
	}
	if tailBytes <= 0 || tailBytes > 256<<10 {
		tailBytes = defaultTailBytes
	}
	outTail, outTruncated, _ := readTail(j.stdoutPath, tailBytes)
	errTail, errTruncated, _ := readTail(j.stderrPath, tailBytes)
	duration := time.Since(j.startedAt).Milliseconds()
	if !endedAt.IsZero() {
		duration = endedAt.Sub(j.startedAt).Milliseconds()
	}
	bytesOut, outTrunc := j.stdout.stats()
	bytesErr, errTrunc := j.stderr.stats()
	return jobSnapshot{
		ID:         j.id,
		Name:       j.name,
		Command:    j.command,
		Shell:      j.shell,
		CWD:        j.cwd,
		Status:     status,
		ExitCode:   exitCode,
		StartedAt:  j.startedAt.UTC().Format(time.RFC3339),
		DurationMS: duration,
		BytesOut:   bytesOut,
		BytesErr:   bytesErr,
		StdoutTail: outTail,
		StderrTail: errTail,
		Truncated:  outTruncated || errTruncated || outTrunc || errTrunc,
	}
}

func readTail(path string, limit int) (string, bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", false, err
	}
	size := st.Size()
	start := int64(0)
	truncated := false
	if size > int64(limit) {
		start = size - int64(limit)
		truncated = true
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return "", truncated, err
	}
	return string(buf), truncated, nil
}

type jobManager struct {
	mu       sync.Mutex
	dir      string
	jobs     map[string]*job
	started  int
	lastScan time.Time
}

func newJobManager(dir string) (*jobManager, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &jobManager{dir: dir, jobs: make(map[string]*job)}, nil
}

func (m *jobManager) start(command, shell, cwd, name string) (*job, error) {
	if strings.TrimSpace(command) == "" {
		return nil, errors.New("command is required")
	}
	m.mu.Lock()
	m.cleanupLocked()
	running := 0
	for _, j := range m.jobs {
		select {
		case <-j.done:
		default:
			running++
		}
	}
	if running >= maxJobs {
		m.mu.Unlock()
		return nil, fmt.Errorf("too many running jobs (max %d)", maxJobs)
	}
	id := "j_" + randomJobID()
	stdoutPath := filepath.Join(m.dir, id+".out")
	stderrPath := filepath.Join(m.dir, id+".err")
	outFile, err := os.OpenFile(stdoutPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	errFile, err := os.OpenFile(stderrPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		outFile.Close()
		os.Remove(stdoutPath)
		m.mu.Unlock()
		return nil, err
	}
	out := &cappedWriter{w: outFile, remaining: jobStdoutLimit}
	errw := &cappedWriter{w: errFile, remaining: jobStderrLimit}
	p, err := startCommandShellDir(command, shell, cwd, commandEnvironment(os.Environ()))
	if err != nil {
		outFile.Close()
		errFile.Close()
		os.Remove(stdoutPath)
		os.Remove(stderrPath)
		m.mu.Unlock()
		return nil, err
	}
	if strings.TrimSpace(name) == "" {
		name = command
	}
	if len(name) > 80 {
		name = name[:80]
	}
	j := &job{
		id:         id,
		name:       name,
		command:    command,
		shell:      shell,
		cwd:        cwd,
		stdoutPath: stdoutPath,
		stderrPath: stderrPath,
		stdout:     out,
		stderr:     errw,
		startedAt:  time.Now(),
		proc:       p,
		done:       make(chan struct{}),
	}
	m.jobs[id] = j
	m.started++
	m.mu.Unlock()
	go func() {
		code, runErr := runStartedCommand(context.Background(), p, out, errw, outputDrainTimeout)
		_ = outFile.Close()
		_ = errFile.Close()
		j.finish(code, runErr)
	}()
	return j, nil
}

func (m *jobManager) get(id string) *job {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jobs[id]
}

func (m *jobManager) cancel(id string) (*job, error) {
	j := m.get(id)
	if j == nil {
		return nil, fmt.Errorf("job not found: %s", id)
	}
	j.cancel()
	return j, nil
}

func (m *jobManager) list() []jobSnapshot {
	m.mu.Lock()
	jobs := make([]*job, 0, len(m.jobs))
	for _, j := range m.jobs {
		jobs = append(jobs, j)
	}
	m.mu.Unlock()
	out := make([]jobSnapshot, 0, len(jobs))
	for _, j := range jobs {
		out = append(out, j.snapshot(0, 4096))
	}
	sort.Slice(out, func(i, k int) bool { return out[i].StartedAt > out[k].StartedAt })
	return out
}

func (m *jobManager) cleanupLocked() {
	if time.Since(m.lastScan) < time.Hour {
		return
	}
	m.lastScan = time.Now()
	for id, j := range m.jobs {
		select {
		case <-j.done:
			j.mu.Lock()
			ended := j.endedAt
			j.mu.Unlock()
			if !ended.IsZero() && time.Since(ended) > jobRetention {
				os.Remove(j.stdoutPath)
				os.Remove(j.stderrPath)
				delete(m.jobs, id)
			}
		default:
		}
	}
}

func randomJobID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

var (
	globalJobsMu sync.Mutex
	globalJobs   *jobManager
)

func ensureJobManager(dir string) (*jobManager, error) {
	globalJobsMu.Lock()
	defer globalJobsMu.Unlock()
	if globalJobs != nil {
		return globalJobs, nil
	}
	if strings.TrimSpace(dir) == "" {
		dir = filepath.Join(os.TempDir(), "dsh-juzi-jobs")
	}
	m, err := newJobManager(dir)
	if err != nil {
		return nil, err
	}
	globalJobs = m
	return m, nil
}

func jobManagerOrNil() *jobManager {
	globalJobsMu.Lock()
	defer globalJobsMu.Unlock()
	return globalJobs
}
