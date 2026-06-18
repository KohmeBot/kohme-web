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
//
// Stream conventions:
//   - "bot": the bot binary's own stdout/stderr. These are the only log lines
//     shown in the page's bottom console and replayed to new tabs.
//   - "op":  build output plus lifecycle/progress messages (start/stop/restart,
//     build began/succeeded/failed). These drive the operation popup, not the
//     bottom console.
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
// Only "bot" log lines are kept in the replay ring (so a freshly opened tab
// sees the recent bot console, not stale build output). Every log line is
// mirrored to `mirror` (the admin's own stdout) regardless of stream.
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
	for _, e := range h.ring { // replay recent bot history
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
		if e.Stream == "bot" { // only bot output is replayed to new subscribers
			h.ring = append(h.ring, e)
			if len(h.ring) > 400 {
				h.ring = h.ring[len(h.ring)-400:]
			}
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
		_ = s.runBuild()
		_, err = os.Stat(s.botBin)
		if err != nil {
			return fmt.Errorf("找不到 bot 二进制 %q，请先构建一次", s.botBin)
		}
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
		s.hub.log("op", "[bot 进程已退出]")
		s.publishStatus()
	}()
	s.hub.log("op", "[bot 已启动]")
	go s.publishStatus()
	return nil
}

func (s *Supervisor) stopBotLocked() {
	if s.cmd == nil || s.cmd.Process == nil {
		return
	}
	s.hub.log("op", "[正在停止 bot ...]")
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

// BuildAndRestart runs the build script synchronously, streaming every line of
// build output to the "op" stream (the operation popup), and on success
// restarts the bot. It returns an error if the build (or the subsequent
// restart) fails. A broken build never swaps the running bot: on failure the
// currently running bot is left untouched.
//
// Unlike the old fire-and-forget Rebuild, this blocks until the build (and
// restart) finish, so the HTTP handler that triggered it can report the final
// outcome to the browser.
func (s *Supervisor) BuildAndRestart() error {
	s.mu.Lock()
	if s.building {
		s.mu.Unlock()
		s.hub.log("op", "[已有构建在进行中]")
		return fmt.Errorf("已有构建在进行中")
	}
	s.building = true
	s.lastBuild = ""
	s.mu.Unlock()
	s.publishStatus()

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

	if !ok {
		s.hub.log("op", "[构建失败，保持原 bot 不变]")
		s.publishStatus()
		return fmt.Errorf("构建失败，请查看构建输出")
	}

	s.hub.log("op", "[构建成功，正在重启 bot]")
	if err := s.RestartBot(); err != nil {
		s.hub.log("op", "[重启失败] "+err.Error())
		s.publishStatus()
		return err
	}
	s.publishStatus()
	return nil
}

func (s *Supervisor) runBuild() bool {
	s.hub.log("op", "[开始构建] "+fmtCmd(s.buildCmd)+"  (cwd: "+s.repoDir+")")
	cmd := exec.Command(s.buildCmd[0], s.buildCmd[1:]...)
	cmd.Dir = s.repoDir
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		s.hub.log("op", "[无法启动构建] "+err.Error())
		return false
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); s.scan("op", stdout) }()
	go func() { defer wg.Done(); s.scan("op", stderr) }()
	wg.Wait()
	if err := cmd.Wait(); err != nil {
		s.hub.log("op", "[构建退出] "+err.Error())
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
		return []string{"cmd", "/c", "chcp 65001 > nul && build.bat"}
	}
	return []string{"sh", "build.sh"}
}

// DefaultBuildBin
func DefaultBuildBin() string {
	if runtime.GOOS == "windows" {
		return "./kohme.exe"
	}
	return "./kohme"
}

func jsonBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
