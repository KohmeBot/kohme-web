package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

var (
	store *ConfigStore
	sup   *Supervisor
	hub   *Hub
	token string
)

func main() {
	var (
		addr       = flag.String("addr", "127.0.0.1:8787", "监听地址。默认只听本机，切勿直接暴露公网")
		repoDir    = flag.String("repo", ".", "kohme 仓库根目录")
		pluginsRel = flag.String("plugins", "conf/plugins.yaml", "plugins.yaml 相对仓库根目录的路径")
		botBin     = flag.String("bin", "", "构建产出的 bot 二进制路径（相对仓库根目录），如 ./bot 或 ./kohme")
		botArgs    = flag.String("bot-args", "", "传给 bot 的额外参数，空格分隔")
		buildStr   = flag.String("build", "", "构建命令，默认 linux/mac 用 build.sh、windows 用 build.bat")
		tok        = flag.String("token", "", "登录口令。留空则自动随机生成并打印到终端")
	)
	flag.Parse()

	absRepo, err := filepath.Abs(*repoDir)
	if err != nil {
		log.Fatal(err)
	}
	pluginsPath := filepath.Join(absRepo, *pluginsRel)
	if _, err := os.Stat(pluginsPath); err != nil {
		log.Fatalf("找不到 %s ：请用 -repo 指向 kohme 仓库根目录，或用 -plugins 指定路径", pluginsPath)
	}

	buildCmd := DefaultBuildCmd()
	if strings.TrimSpace(*buildStr) != "" {
		buildCmd = strings.Fields(*buildStr)
	}
	bin := *botBin
	if bin == "" {
		bin = "./bot"
	}
	absBin := bin
	if !filepath.IsAbs(absBin) {
		absBin = filepath.Join(absRepo, bin)
	}

	token = *tok
	if token == "" {
		token = randToken()
	}

	hub = NewHub()
	store = NewConfigStore(pluginsPath)
	sup = NewSupervisor(absRepo, buildCmd, absBin, splitArgs(*botArgs), hub, store)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", handleLogin)
	mux.HandleFunc("GET /api/config", auth(handleConfig))
	mux.HandleFunc("POST /api/plugins", auth(handleAddPlugin))
	mux.HandleFunc("PUT /api/plugins/{name}", auth(handleUpdatePlugin))
	mux.HandleFunc("DELETE /api/plugins/{name}", auth(handleDeletePlugin))
	mux.HandleFunc("PUT /api/global", auth(handleGlobal))
	mux.HandleFunc("GET /api/status", auth(handleStatus))
	mux.HandleFunc("POST /api/actions/rebuild", auth(handleRebuild))
	mux.HandleFunc("POST /api/actions/restart", auth(handleRestart))
	mux.HandleFunc("POST /api/actions/start", auth(handleStart))
	mux.HandleFunc("POST /api/actions/stop", auth(handleStop))
	mux.HandleFunc("GET /api/stream", auth(handleStream))

	sub, _ := fs.Sub(webFS, "web")
	mux.Handle("GET /", http.FileServer(http.FS(sub)))

	fmt.Println("──────────────────────────────────────────────")
	fmt.Println("  kohme 管理后台已启动")
	fmt.Printf("  地址:   http://%s\n", *addr)
	fmt.Printf("  仓库:   %s\n", absRepo)
	fmt.Printf("  配置:   %s\n", pluginsPath)
	fmt.Printf("  构建:   %s\n", fmtCmd(buildCmd))
	fmt.Printf("  bot:    %s\n", absBin)
	fmt.Printf("  口令:   %s\n", token)
	fmt.Println("──────────────────────────────────────────────")

	log.Fatal(http.ListenAndServe(*addr, mux))
}

// ---- auth ----

func auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r) {
			http.Error(w, "未授权", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func authorized(r *http.Request) bool {
	if c, err := r.Cookie("kadmin"); err == nil {
		if subtle.ConstantTimeCompare([]byte(c.Value), []byte(token)) == 1 {
			return true
		}
	}
	h := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(h), []byte(token)) == 1
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if subtle.ConstantTimeCompare([]byte(body.Token), []byte(token)) != 1 {
		http.Error(w, "口令错误", http.StatusUnauthorized)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: "kadmin", Value: token, Path: "/",
		HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Expires: time.Now().Add(30 * 24 * time.Hour),
	})
	writeJSON(w, map[string]any{"ok": true})
}

// ---- config API ----

type pluginDTO struct {
	Name     string  `json:"name"`
	Repo     string  `json:"repo"`
	Version  string  `json:"version"`
	Seq      int     `json:"seq"`
	Exclude  bool    `json:"exclude"`
	Disable  bool    `json:"disable"`
	Groups   []int64 `json:"groups"`
	ConfYAML string  `json:"confYaml"`
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	c, err := store.Load()
	if err != nil {
		httpErr(w, err)
		return
	}
	plugins := make([]pluginDTO, 0, len(c.Plugins))
	for name, p := range c.Plugins {
		plugins = append(plugins, pluginDTO{
			Name: name, Repo: p.Repo, Version: p.Version, Seq: p.Seq,
			Exclude: p.Exclude, Disable: p.Disable, Groups: p.Groups,
			ConfYAML: confToYAML(p.Conf),
		})
	}
	writeJSON(w, map[string]any{
		"path":    c.Path,
		"groups":  c.Groups,
		"plugins": plugins,
	})
}

func handleAddPlugin(w http.ResponseWriter, r *http.Request) {
	var d pluginDTO
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		httpErr(w, err)
		return
	}
	d.Name = strings.TrimSpace(d.Name)
	if d.Name == "" {
		http.Error(w, "插件名不能为空", http.StatusBadRequest)
		return
	}
	conf, err := yamlToConf(d.ConfYAML)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	err = store.Update(func(c *Config) error {
		if _, ok := c.Plugins[d.Name]; ok {
			return fmt.Errorf("插件 %s 已存在", d.Name)
		}
		c.Plugins[d.Name] = &PluginEntry{
			Repo: d.Repo, Version: d.Version, Seq: d.Seq,
			Exclude: d.Exclude, Disable: d.Disable, Groups: d.Groups, Conf: conf,
		}
		return nil
	})
	if err != nil {
		httpErr(w, err)
		return
	}
	sup.publishStatus()
	writeJSON(w, map[string]any{"ok": true})
}

func handleUpdatePlugin(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var d pluginDTO
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		httpErr(w, err)
		return
	}
	conf, err := yamlToConf(d.ConfYAML)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	err = store.Update(func(c *Config) error {
		p, ok := c.Plugins[name]
		if !ok {
			return fmt.Errorf("插件 %s 不存在", name)
		}
		p.Repo, p.Version, p.Seq = d.Repo, d.Version, d.Seq
		p.Exclude, p.Disable, p.Groups, p.Conf = d.Exclude, d.Disable, d.Groups, conf
		return nil
	})
	if err != nil {
		httpErr(w, err)
		return
	}
	sup.publishStatus()
	writeJSON(w, map[string]any{"ok": true})
}

func handleDeletePlugin(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	err := store.Update(func(c *Config) error {
		if _, ok := c.Plugins[name]; !ok {
			return fmt.Errorf("插件 %s 不存在", name)
		}
		delete(c.Plugins, name)
		return nil
	})
	if err != nil {
		httpErr(w, err)
		return
	}
	sup.publishStatus()
	writeJSON(w, map[string]any{"ok": true})
}

func handleGlobal(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path   string  `json:"path"`
		Groups []int64 `json:"groups"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpErr(w, err)
		return
	}
	err := store.Update(func(c *Config) error {
		c.Path = body.Path
		c.Groups = body.Groups
		return nil
	})
	if err != nil {
		httpErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// ---- actions ----

func handleStatus(w http.ResponseWriter, r *http.Request) { writeJSON(w, sup.Status()) }

func handleRebuild(w http.ResponseWriter, r *http.Request) {
	sup.Rebuild()
	writeJSON(w, map[string]any{"ok": true})
}

func handleRestart(w http.ResponseWriter, r *http.Request) {
	if err := sup.RestartBot(); err != nil {
		httpErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func handleStart(w http.ResponseWriter, r *http.Request) {
	if err := sup.StartBot(); err != nil {
		httpErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func handleStop(w http.ResponseWriter, r *http.Request) {
	sup.StopBot()
	writeJSON(w, map[string]any{"ok": true})
}

func handleStream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "不支持流式响应", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch, cancel := hub.Subscribe()
	defer cancel()

	st := sup.Status()
	fmt.Fprintf(w, "data: %s\n\n", jsonBytes(Event{Type: "status", Status: &st}))
	fl.Flush()

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", jsonBytes(e))
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, err error) {
	http.Error(w, err.Error(), http.StatusBadRequest)
}

func randToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func splitArgs(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return strings.Fields(s)
}
