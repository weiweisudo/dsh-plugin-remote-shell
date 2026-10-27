package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	fileMagic        = "JZ1"
	fileVersion      = 1
	fileChunkSize    = 64 << 10
	fileWindow       = 8 << 20
	fileAckBytes     = 1 << 20
	fileMaxTransfers = 2
	fileQueueLimit   = 4
	fileHeaderSize   = 32
	fileMaxFrame     = 128 << 10
	fileTransferTTL  = 7 * 24 * time.Hour
)

type fileMeta struct {
	TransferID string `json:"transfer_id"`
	Direction  string `json:"direction"`
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256"`
	UpdatedAt  string `json:"updated_at"`
}

type fileTransfer struct {
	mu        sync.Mutex
	id        string
	direction string
	path      string
	partPath  string
	metaPath  string
	size      int64
	sha       string
	overwrite bool
	resume    bool
	offset    int64
	acked     int64
	status    string
	err       string
	file      *os.File
	source    *os.File
	acks      chan int64
	done      chan struct{}
	manager   *transferManager
}

type transferManager struct {
	mu        sync.Mutex
	transfers map[string]*fileTransfer
	queue     []*fileTransfer
	active    int
	closed    bool
	uploadDir string
	sendJSON  func(wireMessage) error
	sendBin   func([]byte) error
}

func newTransferManager(sendJSON func(wireMessage) error, sendBin func([]byte) error) *transferManager {
	return &transferManager{
		transfers: make(map[string]*fileTransfer),
		uploadDir: defaultUploadRoot(),
		sendJSON:  sendJSON,
		sendBin:   sendBin,
	}
}

func normalizeTransferID(id string) (string, error) {
	id = strings.TrimPrefix(strings.TrimSpace(id), "t_")
	if len(id) != 32 {
		return "", errors.New("bad transfer id")
	}
	if _, err := hex.DecodeString(id); err != nil {
		return "", errors.New("bad transfer id")
	}
	return id, nil
}

func wireTransferID(id string) string {
	return "t_" + strings.TrimPrefix(id, "t_")
}

func resolveTransferPath(root, p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Clean(filepath.Join(root, p))
}

func (m *transferManager) handleJSON(msg wireMessage) {
	switch msg.Type {
	case "file_begin":
		m.beginUpload(msg)
	case "file_request":
		m.beginDownload(msg)
	case "file_ready":
		m.readyDownload(msg)
	case "file_ack":
		m.ack(msg)
	case "file_end":
		m.finishUpload(msg)
	case "file_abort":
		m.abort(msg.TransferID)
	case "file_result":
		m.resultFromPeer(msg)
	}
}

func (m *transferManager) sendStatus(t *fileTransfer) {
	t.mu.Lock()
	status := t.status
	offset := t.offset
	size := t.size
	errText := t.err
	t.mu.Unlock()
	_ = m.sendJSON(wireMessage{
		Type: "file_status", TransferID: wireTransferID(t.id), Direction: t.direction, Path: t.path,
		Status: status, Offset: offset, Size: size, Error: errText,
	})
}

func (m *transferManager) beginUpload(msg wireMessage) {
	id, err := normalizeTransferID(msg.TransferID)
	if err != nil {
		_ = m.sendJSON(wireMessage{Type: "file_error", ID: msg.ID, TransferID: msg.TransferID, Error: err.Error()})
		return
	}
	target := resolveTransferPath(m.uploadDir, msg.Path)
	if target == "" || msg.Size < 0 || len(msg.SHA256) != 64 {
		_ = m.sendJSON(wireMessage{Type: "file_error", ID: msg.ID, TransferID: wireTransferID(id), Error: "bad_request"})
		return
	}
	t := &fileTransfer{
		id: id, direction: "upload", path: target, size: msg.Size, sha: strings.ToLower(msg.SHA256),
		overwrite: msg.Overwrite, resume: msg.Resume, status: "queued", manager: m,
		partPath: target + ".part", metaPath: target + ".part.meta",
	}
	m.add(t)
}

func (m *transferManager) beginDownload(msg wireMessage) {
	id, err := normalizeTransferID(msg.TransferID)
	if err != nil {
		_ = m.sendJSON(wireMessage{Type: "file_error", ID: msg.ID, TransferID: msg.TransferID, Error: err.Error()})
		return
	}
	path := resolveTransferPath(m.uploadDir, msg.Path)
	if path == "" {
		_ = m.sendJSON(wireMessage{Type: "file_error", ID: msg.ID, TransferID: wireTransferID(id), Error: "bad_request"})
		return
	}
	t := &fileTransfer{
		id: id, direction: "download", path: path, status: "queued", manager: m, resume: msg.Resume,
	}
	m.add(t)
}

func (m *transferManager) add(t *fileTransfer) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		_ = m.sendJSON(wireMessage{Type: "file_error", TransferID: wireTransferID(t.id), Error: "canceled"})
		return
	}
	m.transfers[t.id] = t
	if m.active < fileMaxTransfers {
		m.active++
		m.mu.Unlock()
		go m.start(t)
		return
	}
	if len(m.queue) >= fileQueueLimit {
		delete(m.transfers, t.id)
		m.mu.Unlock()
		_ = m.sendJSON(wireMessage{Type: "file_error", TransferID: wireTransferID(t.id), Error: "too_many_transfers"})
		return
	}
	m.queue = append(m.queue, t)
	m.mu.Unlock()
	m.sendStatus(t)
}

func (m *transferManager) start(t *fileTransfer) {
	switch t.direction {
	case "upload":
		m.startUpload(t)
	case "download":
		m.startDownload(t)
	}
}

func (m *transferManager) startUpload(t *fileTransfer) {
	if fi, err := os.Stat(t.path); err == nil && !fi.IsDir() && !t.overwrite {
		m.fail(t, "exists")
		return
	}
	if err := os.MkdirAll(filepath.Dir(t.path), 0o755); err != nil {
		m.fail(t, "io_error")
		return
	}
	var offset int64 = 0
	if t.resume {
		if meta, err := readFileMeta(t.metaPath); err == nil && meta.TransferID == t.id && meta.Path == t.path && meta.Size == t.size && meta.SHA256 == t.sha {
			if fi, err := os.Stat(t.partPath); err == nil && fi.Size() <= t.size {
				offset = fi.Size()
			}
		}
	}
	if offset == 0 {
		_ = os.Remove(t.partPath)
		_ = os.Remove(t.metaPath)
	}
	if err := writeFileMeta(t.metaPath, fileMeta{TransferID: t.id, Direction: "upload", Path: t.path, Size: t.size, SHA256: t.sha, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}); err != nil {
		m.fail(t, "io_error")
		return
	}
	f, err := os.OpenFile(t.partPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		m.fail(t, "permission_denied")
		return
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		f.Close()
		m.fail(t, "io_error")
		return
	}
	t.mu.Lock()
	t.file = f
	t.offset = offset
	t.status = "running"
	t.mu.Unlock()
	m.sendJSON(wireMessage{Type: "file_ready", TransferID: wireTransferID(t.id), Offset: offset, Path: t.path})
	m.sendStatus(t)
}

func (m *transferManager) startDownload(t *fileTransfer) {
	f, err := os.Open(t.path)
	if err != nil {
		m.fail(t, "not_found")
		return
	}
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		f.Close()
		m.fail(t, "bad_request")
		return
	}
	t.mu.Lock()
	t.source = f
	t.size = fi.Size()
	t.status = "preparing"
	t.mu.Unlock()
	go func() {
		sha, err := hashFile(t.path)
		if err != nil {
			f.Close()
			m.fail(t, "io_error")
			return
		}
		t.mu.Lock()
		t.sha = sha
		t.status = "waiting_ready"
		t.mu.Unlock()
		_ = m.sendJSON(wireMessage{Type: "file_offer", TransferID: wireTransferID(t.id), Path: t.path, Size: t.size, SHA256: sha})
		m.sendStatus(t)
	}()
}

func (m *transferManager) readyDownload(msg wireMessage) {
	t := m.get(msg.TransferID)
	if t == nil || t.direction != "download" {
		return
	}
	t.mu.Lock()
	if t.status != "waiting_ready" {
		t.mu.Unlock()
		return
	}
	offset := msg.Offset
	if offset < 0 || offset > t.size {
		t.mu.Unlock()
		m.fail(t, "offset_mismatch")
		return
	}
	t.offset = offset
	t.acked = offset
	t.status = "running"
	f := t.source
	size := t.size
	sha := t.sha
	t.mu.Unlock()
	_ = msg
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		m.fail(t, "io_error")
		return
	}
	go m.sendDownload(t, f, offset, size, sha)
}

func (m *transferManager) sendDownload(t *fileTransfer, f *os.File, offset, size int64, sha string) {
	buf := make([]byte, fileChunkSize)
	for offset < size {
		t.mu.Lock()
		acked := t.acked
		status := t.status
		t.mu.Unlock()
		if status == "canceled" {
			return
		}
		if offset-acked > fileWindow {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		n, err := f.ReadAt(buf, offset)
		if n > 0 {
			frame, err := buildFileChunk(t.id, offset, buf[:n])
			if err != nil {
				m.fail(t, "io_error")
				return
			}
			if err := m.sendBin(frame); err != nil {
				m.fail(t, "io_error")
				return
			}
			offset += int64(n)
		}
		if err != nil && err != io.EOF {
			m.fail(t, "io_error")
			return
		}
	}
	_ = m.sendJSON(wireMessage{Type: "file_end", TransferID: wireTransferID(t.id), SHA256: sha})
	t.mu.Lock()
	t.status = "verifying"
	t.mu.Unlock()
	m.sendStatus(t)
}

func (m *transferManager) handleBinary(data []byte) {
	if len(data) < fileHeaderSize {
		return
	}
	if string(data[:3]) != fileMagic || data[3] != fileVersion {
		return
	}
	id := hex.EncodeToString(data[4:20])
	offset := int64(binary.LittleEndian.Uint64(data[20:28]))
	n := int(binary.LittleEndian.Uint32(data[28:32]))
	if n < 0 || fileHeaderSize+n > len(data) {
		return
	}
	t := m.get(id)
	if t == nil || t.direction != "upload" {
		return
	}
	t.mu.Lock()
	if t.status != "running" || t.file == nil {
		t.mu.Unlock()
		return
	}
	if offset != t.offset {
		t.mu.Unlock()
		m.fail(t, "offset_mismatch")
		return
	}
	payload := data[fileHeaderSize : fileHeaderSize+n]
	written, err := t.file.WriteAt(payload, offset)
	if err != nil || written != len(payload) {
		t.mu.Unlock()
		m.fail(t, "io_error")
		return
	}
	t.offset += int64(written)
	shouldAck := t.offset-t.acked >= fileAckBytes
	if shouldAck {
		t.acked = t.offset
	}
	acked := t.acked
	t.mu.Unlock()
	if shouldAck {
		_ = m.sendJSON(wireMessage{Type: "file_ack", TransferID: wireTransferID(t.id), Offset: acked})
	}
}

func (m *transferManager) ack(msg wireMessage) {
	t := m.get(msg.TransferID)
	if t == nil || t.direction != "download" {
		return
	}
	t.mu.Lock()
	if msg.Offset > t.acked && msg.Offset <= t.size {
		t.acked = msg.Offset
	}
	t.mu.Unlock()
}

func (m *transferManager) finishUpload(msg wireMessage) {
	t := m.get(msg.TransferID)
	if t == nil || t.direction != "upload" {
		return
	}
	t.mu.Lock()
	f := t.file
	offset := t.offset
	size := t.size
	sha := t.sha
	overwrite := t.overwrite
	path := t.path
	part := t.partPath
	meta := t.metaPath
	t.mu.Unlock()
	if f == nil {
		return
	}
	if offset != size || !strings.EqualFold(msg.SHA256, sha) {
		f.Close()
		m.fail(t, "size_mismatch")
		return
	}
	_ = f.Sync()
	f.Close()
	got, err := hashFile(part)
	if err != nil {
		m.fail(t, "io_error")
		return
	}
	if !strings.EqualFold(got, sha) {
		m.fail(t, "sha256_mismatch")
		return
	}
	if fi, err := os.Stat(path); err == nil && !fi.IsDir() && !overwrite {
		m.fail(t, "exists")
		return
	}
	if err := replaceFile(part, path); err != nil {
		m.fail(t, "io_error")
		return
	}
	_ = os.Remove(meta)
	t.mu.Lock()
	t.status = "completed"
	t.offset = size
	t.file = nil
	t.mu.Unlock()
	_ = m.sendJSON(wireMessage{Type: "file_result", TransferID: wireTransferID(t.id), OK: true, Path: path, Size: size})
	m.sendStatus(t)
	m.finished(t)
}

func (m *transferManager) resultFromPeer(msg wireMessage) {
	t := m.get(msg.TransferID)
	if t == nil || t.direction != "download" {
		return
	}
	if msg.OK {
		t.mu.Lock()
		t.status = "completed"
		if t.source != nil {
			t.source.Close()
			t.source = nil
		}
		t.mu.Unlock()
		m.sendStatus(t)
		m.finished(t)
		return
	}
	if msg.Error == "" {
		msg.Error = "io_error"
	}
	m.fail(t, msg.Error)
}

func (m *transferManager) fail(t *fileTransfer, reason string) {
	t.mu.Lock()
	t.status = "failed"
	t.err = reason
	if t.file != nil {
		t.file.Close()
		t.file = nil
	}
	if t.source != nil {
		t.source.Close()
		t.source = nil
	}
	t.mu.Unlock()
	_ = m.sendJSON(wireMessage{Type: "file_error", TransferID: wireTransferID(t.id), Error: reason})
	m.sendStatus(t)
	m.finished(t)
}

func (m *transferManager) abort(id string) {
	t := m.get(id)
	if t == nil {
		return
	}
	t.mu.Lock()
	t.status = "canceled"
	if t.file != nil {
		t.file.Close()
		t.file = nil
	}
	if t.source != nil {
		t.source.Close()
		t.source = nil
	}
	_ = os.Remove(t.partPath)
	_ = os.Remove(t.metaPath)
	t.mu.Unlock()
	m.sendStatus(t)
	m.finished(t)
}

func (m *transferManager) get(id string) *fileTransfer {
	id, err := normalizeTransferID(id)
	if err != nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.transfers[id]
}

func (m *transferManager) finished(t *fileTransfer) {
	m.mu.Lock()
	delete(m.transfers, t.id)
	if m.active > 0 {
		m.active--
	}
	var next *fileTransfer
	if len(m.queue) > 0 && !m.closed {
		next = m.queue[0]
		m.queue = m.queue[1:]
		m.active++
	}
	m.mu.Unlock()
	if next != nil {
		go m.start(next)
	}
}

func (m *transferManager) close() {
	m.mu.Lock()
	m.closed = true
	all := make([]*fileTransfer, 0, len(m.transfers))
	for _, t := range m.transfers {
		all = append(all, t)
	}
	m.queue = nil
	m.mu.Unlock()
	for _, t := range all {
		t.mu.Lock()
		t.status = "canceled"
		if t.file != nil {
			t.file.Close()
			t.file = nil
		}
		if t.source != nil {
			t.source.Close()
			t.source = nil
		}
		t.mu.Unlock()
	}
}

func readFileMeta(path string) (fileMeta, error) {
	var meta fileMeta
	b, err := os.ReadFile(path)
	if err != nil {
		return meta, err
	}
	err = json.Unmarshal(b, &meta)
	return meta, err
}

func writeFileMeta(path string, meta fileMeta) error {
	b, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func buildFileChunk(id string, offset int64, payload []byte) ([]byte, error) {
	raw, err := hex.DecodeString(id)
	if err != nil || len(raw) != 16 {
		return nil, errors.New("bad transfer id")
	}
	frame := make([]byte, fileHeaderSize+len(payload))
	copy(frame[:3], fileMagic)
	frame[3] = fileVersion
	copy(frame[4:20], raw)
	binary.LittleEndian.PutUint64(frame[20:28], uint64(offset))
	binary.LittleEndian.PutUint32(frame[28:32], uint32(len(payload)))
	copy(frame[fileHeaderSize:], payload)
	return frame, nil
}
