//go:build windows

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func serviceCredentialsPath() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = `C:\ProgramData`
	}
	return filepath.Join(base, "dsh-remote-shell", "credentials.json")
}

func installService(userCredentials string) error {
	c, err := loadCredentials(userCredentials)
	if err != nil {
		return fmt.Errorf("先在本机完成配对，再安装服务: %w", err)
	}
	target := serviceCredentialsPath()
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	if err := saveCredentials(target, c.Endpoint, c.MachineID, c.Token, c.ExpiresAt); err != nil {
		return err
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("需要管理员权限: %w", err)
	}
	defer m.Disconnect()

	if s, err := m.OpenService(serviceName); err == nil {
		s.Close()
		return fmt.Errorf("服务 %s 已安装", serviceName)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cfg := mgr.Config{
		DisplayName:      "DSH Remote Shell Agent",
		Description:      "DSH 远程机器 agent（出站 WebSocket，无入站监听）",
		StartType:        mgr.StartAutomatic,
		ServiceStartName: "LocalSystem",
	}
	s, err := m.CreateService(serviceName, exe, cfg, "--service")
	if err != nil {
		return err
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, 86400)
	if err := s.Start(); err != nil {
		return fmt.Errorf("服务已安装但启动失败: %w", err)
	}
	return nil
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("需要管理员权限: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return nil
	}
	defer s.Close()
	if err := stopServiceHandle(s); err != nil {
		return err
	}
	for i := 0; i < 20; i++ {
		if st, err := s.Query(); err == nil && st.State == svc.Stopped {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	return s.Delete()
}

func startService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	return s.Start()
}

func stopService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	return stopServiceHandle(s)
}

func stopServiceHandle(s *mgr.Service) error {
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State == svc.Stopped {
		return nil
	}
	_, err = s.Control(svc.Stop)
	return err
}

func queryServiceState() (installed, running bool, errText string) {
	m, err := mgr.Connect()
	if err != nil {
		return false, false, err.Error()
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return false, false, ""
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return true, false, err.Error()
	}
	return true, st.State == svc.Running, ""
}

func runWindowsService() error {
	logPath := filepath.Join(filepath.Dir(serviceCredentialsPath()), "agent.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0o700)
	if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		defer f.Close()
		log.SetOutput(f)
	}
	log.Printf("service: starting")
	return svc.Run(serviceName, &serviceHandler{})
}

type serviceHandler struct{}

func (h *serviceHandler) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	cfg := defaultDesktopConfig()
	cfg.credentialsFile = serviceCredentialsPath()
	if c, err := loadCredentials(cfg.credentialsFile); err != nil {
		log.Printf("service: no usable credentials: %v", err)
	} else {
		cfg.serverURL = c.Endpoint
		cfg.machineID = c.MachineID
		cfg.token = c.Token
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		if err := runOutboundContext(ctx, cfg); err != nil {
			log.Printf("service: worker: %v", err)
		}
	}()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for c := range r {
		switch c.Cmd {
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			cancel()
			return false, 0
		}
	}
	return false, 0
}
