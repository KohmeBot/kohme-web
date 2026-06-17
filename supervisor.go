package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

// Event is what gets pushed to the browser over SSE.
type Event struct {
	Type   string  `json:"type"` // "log" | "status"
	Stream string  `json:"stream,omitempty"`
	Line   string  `json:"line,omitempty"`
	Status *Status `json:"status,omitempty"`
	Time   string  `json:"time,omitempty"`
}

// Status is the live state the UI header reflects.
type Status struct {
	BotRunning bool   `json:"botRunning"`
	Building   bool   `json:"building"`
	LastBuild  string `json:"lastBuild"`  // "ok" | "failed" | ""
	NeedAction string `json:"needAction"` // "" | "restart" | "rebuild"
}

// Hub is a tiny fan-out broadcaster with a replay buffer for new subscribers.
// Every log line is also mirrored to `mirror` (the admin's own stdout) so the
// running bot's output is visible in the terminal and the browser at once.
type Hub struct {
	mu     sync.Mutex
	subs   map[chan Event]struct{}
	ring   []Event
	mirror io.Writer
}

func NewHub() *Hub {
	return &Hub{subs: map[chan Event]struct{}{}, mirror: os.Stdout}
}

func (h *Hub) Subscribe() (chan Event, func()) {
	ch := make(chan Event, 256)
	h.mu.Lock()
	for _, e := range h.ring { // replay recent history
		select {
		case ch <- e:
		default:
		}
	}
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
		close(ch)
	}
}

func (h *Hub) Publish(e Event) {
	e.Time = time.Now().Format("15:04:05")
	h.mu.Lock()
	if e.Type == "log" {
		h.ring = append(h.ring, e)
		if len(h.ring) > 400 {
			h.ring = h.ring[len(h.ring)-400:]
		}
		if h.mirror != nil {
			fmt.Fprintf(h.mirror, "%s [%s] %s\n", e.Time, e.Stream, e.Line)
		}
	}
	for ch := range h.subs {
		select {
		case ch <- e:
		default: // drop for slow clients rather than block
		}
	}
	h.mu.Unlock()
}

func (h *Hub) log(stream, line string) {
	h.Publish(Event{Type: "log", Stream: stream, Line: line})
}

// Supervisor owns the bot child process and the build pipeline.
type Supervisor struct {
	mu       sync.Mutex
	repoDir  string
	buildCmd []string
	botBin   string
	botArgs  []string

	hub      *Hub
	store    *ConfigStore
	cmd      *exec.Cmd
	cancel   context.CancelFunc
	building bool

	lastBuild   string // "ok" | "failed" | ""
	builtSig    string // build signature at last successful build
	builtBotBin string
}

func NewSupervisor(repoDir string, buildCmd []string, botBin string, botArgs []string, hub *Hub, store *ConfigStore) *Supervisor {
	return &Supervisor{
		repoDir: repoDir, buildCmd: buildCmd, botBin: botBin, botArgs: botArgs,
		hub: hub, store: store,
	}
}

func (s *Supervisor) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

func (s *Supervisor) statusLocked() Status {
	st := Status{
		BotRunning: s.cmd != nil && s.cmd.Process != nil,
		Building:   s.building,
		LastBuild:  s.lastBuild,
	}
	if c, err := s.store.Load(); err == nil {
		sig := buildSignature(c)
		if s.builtSig == "" || sig != s.builtSig {
			st.NeedAction = "rebuild"
		}
	}
	return st
}

func (s *Supervisor) publishStatus() {
	st := s.Status()
	s.hub.Publish(Event{Type: "status", Status: &st})
}

// StartBot launches the already-built binary.
func (s *Supervisor) StartBot() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil {
		return fmt.Errorf("bot 已在运行")
	}
	if _, err := os.Stat(s.botBin); err != nil {
		return fmt.Errorf("找不到 bot 二进制 %q，请先构建一次", s.botBin)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, s.botBin, s.botArgs...)
	cmd.Dir = s.repoDir
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		cancel()
		return err
	}
	s.cmd = cmd
	s.cancel = cancel
	go s.pump("bot", stdout)
	go s.pump("bot", stderr)
	go func() {
		_ = cmd.Wait()
		s.mu.Lock()
		if s.cmd == cmd {
			s.cmd = nil
		}
		s.mu.Unlock()
		s.hub.log("bot", "[bot 进程已退出]")
		s.publishStatus()
	}()
	s.hub.log("bot", "[bot 已启动]")
	go s.publishStatus()
	return nil
}

func (s *Supervisor) stopBotLocked() {
	if s.cmd == nil || s.cmd.Process == nil {
		return
	}
	s.hub.log("bot", "[正在停止 bot ...]")
	_ = s.cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	cmd := s.cmd
	go func() { _ = cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		if s.cancel != nil {
			s.cancel() // hard kill via context
		}
	}
	s.cmd = nil
}

func (s *Supervisor) StopBot() {
	s.mu.Lock()
	s.stopBotLocked()
	s.mu.Unlock()
	s.publishStatus()
}

func (s *Supervisor) RestartBot() error {
	s.mu.Lock()
	s.stopBotLocked()
	s.mu.Unlock()
	return s.StartBot()
}

// Rebuild runs the build script, and on success restarts the bot. It streams
// every line of build output to the browser and never swaps a broken build:
// if the build fails the running bot is left untouched.
func (s *Supervisor) Rebuild() {
	s.mu.Lock()
	if s.building {
		s.mu.Unlock()
		s.hub.log("build", "[已有构建在进行中]")
		return
	}
	s.building = true
	s.lastBuild = ""
	s.mu.Unlock()
	s.publishStatus()

	go func() {
		ok := s.runBuild()
		s.mu.Lock()
		s.building = false
		if ok {
			s.lastBuild = "ok"
			if c, err := s.store.Load(); err == nil {
				s.builtSig = buildSignature(c)
			}
		} else {
			s.lastBuild = "failed"
		}
		s.mu.Unlock()

		if ok {
			s.hub.log("build", "[构建成功，正在重启 bot]")
			if err := s.RestartBot(); err != nil {
				s.hub.log("build", "[重启失败] "+err.Error())
			}
		} else {
			s.hub.log("build", "[构建失败，保持原 bot 不变]")
		}
		s.publishStatus()
	}()
}

func (s *Supervisor) runBuild() bool {
	s.hub.log("build", "[开始构建] "+fmtCmd(s.buildCmd)+"  (cwd: "+s.repoDir+")")
	cmd := exec.Command(s.buildCmd[0], s.buildCmd[1:]...)
	cmd.Dir = s.repoDir
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		s.hub.log("build", "[无法启动构建] "+err.Error())
		return false
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); s.scan("build", stdout) }()
	go func() { defer wg.Done(); s.scan("build", stderr) }()
	wg.Wait()
	if err := cmd.Wait(); err != nil {
		s.hub.log("build", "[构建退出] "+err.Error())
		return false
	}
	return true
}

func (s *Supervisor) scan(stream string, r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		s.hub.log(stream, sc.Text())
	}
}

func (s *Supervisor) pump(stream string, r io.Reader) { s.scan(stream, r) }

func fmtCmd(c []string) string {
	out := ""
	for i, p := range c {
		if i > 0 {
			out += " "
		}
		out += p
	}
	return out
}

// DefaultBuildCmd picks build.bat on Windows and ./build.sh elsewhere.
func DefaultBuildCmd() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd", "/c", "build.bat"}
	}
	return []string{"sh", "build.sh"}
}

func jsonBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
