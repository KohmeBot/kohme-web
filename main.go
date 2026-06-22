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
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

//go:embed web
var webFS embed.FS

var (
	store       *ConfigStore
	driverStore *DriverStore
	sup         *Supervisor
	hub         *Hub
	token       string
	schemasPath string
	authStore   *AuthStore

	// opMu serializes any operation that mutates config and/or rebuilds, so a
	// build, restart, add-plugin, save-config, etc. can never overlap.
	opMu sync.Mutex
)

func main() {
	var (
		addr       = flag.String("addr", "0.0.0.0:8787", "监听地址。")
		repoDir    = flag.String("repo", ".", "kohme 仓库根目录")
		pluginsRel = flag.String("plugins", "conf/plugins.yaml", "plugins.yaml 相对仓库根目录的路径")
		configRel  = flag.String("config", "conf/config.json", "config.json（ZeroBot 驱动配置）相对仓库根目录的路径")
		botBin     = flag.String("bin", "", "构建产出的 bot 二进制路径（相对仓库根目录）。kohme 的 build.sh 产出 ./kohme，默认即此")
		botArgs    = flag.String("bot-args", "", "传给 bot 的额外参数，空格分隔")
		buildStr   = flag.String("build", "", "构建命令，默认 linux/mac 用 build.sh、windows 用 build.bat")
		tok        = flag.String("token", "", "首次初始化账户用的一次性口令。留空则自动随机生成并打印到终端")
		authPath   = flag.String("auth", "kadmin-auth.json", "存放账户密码（已加盐哈希）的文件路径")
		resetAuth  = flag.Bool("reset-auth", false, "清除已设置的账户，重新走首次初始化流程")
		autostart  = flag.Bool("autostart", true, "启动后台时若已有 bot 二进制则自动拉起 bot")
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
	schemasPath = filepath.Join(filepath.Dir(pluginsPath), ".schemas.json")

	buildCmd := DefaultBuildCmd()
	if strings.TrimSpace(*buildStr) != "" {
		buildCmd = strings.Fields(*buildStr)
	}
	bin := *botBin
	if bin == "" {
		bin = DefaultBuildBin()
	}
	absBin := bin
	if !filepath.IsAbs(absBin) {
		absBin = filepath.Join(absRepo, bin)
	}

	token = *tok
	if token == "" {
		token = randToken()
	}

	authStore = NewAuthStore(*authPath)
	if *resetAuth {
		if err := authStore.Reset(); err != nil {
			log.Printf("重置账户失败: %v", err)
		} else {
			log.Println("已清除账户，将重新进行首次初始化")
		}
	}

	hub = NewHub()
	store = NewConfigStore(pluginsPath)
	driverStore = NewDriverStore(filepath.Join(absRepo, *configRel))
	sup = NewSupervisor(absRepo, buildCmd, absBin, splitArgs(*botArgs), hub, store)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/auth/state", handleAuthState)
	mux.HandleFunc("POST /api/auth/setup", handleSetup)
	mux.HandleFunc("POST /api/login", handleLogin)
	mux.HandleFunc("POST /api/logout", auth(handleLogout))
	mux.HandleFunc("POST /api/auth/change", auth(handleChangePassword))
	mux.HandleFunc("GET /api/config", auth(handleConfig))
	mux.HandleFunc("PUT /api/plugins", auth(handlePluginsBulk))
	mux.HandleFunc("GET /api/global", auth(handleGlobalGet))
	mux.HandleFunc("PUT /api/global", auth(handleGlobalPut))
	mux.HandleFunc("GET /api/driver", auth(handleDriverGet))
	mux.HandleFunc("PUT /api/driver", auth(handleDriverPut))
	mux.HandleFunc("GET /api/status", auth(handleStatus))
	mux.HandleFunc("GET /api/schemas", auth(handleSchemas))
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
	if authStore.Configured() {
		fmt.Printf("  登录:   使用账户密码（账户: %s）。忘记密码用 -reset-auth 重置\n", authStore.Username())
	} else {
		fmt.Printf("  初始化: 首次打开网页用此一次性口令创建账户密码: %s\n", token)
	}
	fmt.Println("──────────────────────────────────────────────")

	if *autostart {
		if err := sup.StartBot(); err != nil {
			log.Printf("自动启动 bot 跳过：%v（构建一次后即可运行）", err)
		}
	}

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
	c, err := r.Cookie("kadmin")
	if err != nil {
		return false
	}
	return authStore.ValidSession(c.Value)
}

func setSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: "kadmin", Value: authStore.NewSession(), Path: "/",
		HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Expires: time.Now().Add(30 * 24 * time.Hour),
	})
}

// handleAuthState tells the UI whether an account exists yet, so it can show
// either the first-run setup form or the normal login form.
func handleAuthState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"configured": authStore.Configured(),
		"username":   authStore.Username(),
	})
}

// handleSetup runs once: the operator uses the startup token to create the
// account and password. Refused if an account already exists.
func handleSetup(w http.ResponseWriter, r *http.Request) {
	if authStore.Configured() {
		http.Error(w, "账户已存在，请直接登录", http.StatusConflict)
		return
	}
	var body struct{ Token, Username, Password string }
	_ = json.NewDecoder(r.Body).Decode(&body)
	if subtle.ConstantTimeCompare([]byte(body.Token), []byte(token)) != 1 {
		http.Error(w, "初始化口令错误（见后台启动时的终端输出）", http.StatusUnauthorized)
		return
	}
	if err := authStore.SetCredentials(strings.TrimSpace(body.Username), body.Password); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	setSession(w)
	writeJSON(w, map[string]any{"ok": true})
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	if !authStore.Configured() {
		http.Error(w, "尚未初始化账户", http.StatusConflict)
		return
	}
	var body struct{ Username, Password string }
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !authStore.Verify(strings.TrimSpace(body.Username), body.Password) {
		http.Error(w, "账号或密码错误", http.StatusUnauthorized)
		return
	}
	setSession(w)
	writeJSON(w, map[string]any{"ok": true})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("kadmin"); err == nil {
		authStore.DropSession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: "kadmin", Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, map[string]any{"ok": true})
}

func handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var body struct{ OldPassword, NewPassword string }
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := authStore.ChangePassword(body.OldPassword, body.NewPassword); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// ---- config API ----

type pluginDTO struct {
	Name      string          `json:"name"`
	Repo      string          `json:"repo"`
	Version   string          `json:"version"`
	Seq       int64           `json:"seq"`
	Exclude   bool            `json:"exclude"`
	Disable   bool            `json:"disable"`
	Groups    []int64         `json:"groups"`
	ConfYAML  string          `json:"confYaml"`
	ConfValue json.RawMessage `json:"confValue,omitempty"`
}

// confFromDTO builds the conf node from a structured form value when present,
// otherwise from the raw-YAML editor text.
func confFromDTO(d pluginDTO) (map[string]any, error) {
	if len(d.ConfValue) > 0 && string(d.ConfValue) != "null" {
		var v map[string]any
		if err := json.Unmarshal(d.ConfValue, &v); err != nil {
			return nil, fmt.Errorf("conf 表单数据非法: %w", err)
		}
		return v, nil
	}

	var n yaml.Node
	n, err := yamlToConf(d.ConfYAML)
	if err != nil {
		return nil, err
	}

	var v map[string]any
	if err := n.Decode(&v); err != nil {
		return nil, err
	}

	return v, nil
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	c, err := store.Load()
	if err != nil {
		httpErr(w, err)
		return
	}
	plugins := make([]pluginDTO, 0, len(c.Plugins))
	for name, p := range c.Plugins {
		cv, _ := json.Marshal(confToValue(p.Conf))
		plugins = append(plugins, pluginDTO{
			Name: name, Repo: p.Repo, Version: p.Version, Seq: p.Seq,
			Exclude: p.Exclude, Disable: p.Disable, Groups: p.Groups,
			ConfYAML: confToYAML(p.Conf), ConfValue: cv,
		})
	}
	writeJSON(w, map[string]any{
		"path": c.Path,

		"groups":  c.Groups,
		"plugins": plugins,
	})
}

// mutatePluginsAndBuild applies a change to plugins.yaml, then synchronously
// rebuilds and restarts the bot. The build output streams to the operation
// popup via the "op" stream. If the build fails, the config change is rolled
// back so a broken edit can never be left on disk, and the running bot (built
// from the previous config) is left untouched.
//
// Validation errors returned by mutate (e.g. duplicate plugin name) abort
// before any build happens and surface as a 400 to the browser.
func mutatePluginsAndBuild(w http.ResponseWriter, r *http.Request, mutate func(*Config) error) {
	opMu.Lock()
	defer opMu.Unlock()
	// url?rebuild=true
	rebuild := false
	if v := r.URL.Query().Get("rebuild"); v == "true" {
		rebuild = true
	}

	prev, err := store.Load()
	if err != nil {
		httpErr(w, err)
		return
	}
	if err := store.Update(mutate); err != nil {
		httpErr(w, err) // bad input / duplicate / not found — nothing built
		return
	}

	if rebuild {
		err = sup.BuildAndRestart()
	} else {
		err = sup.RestartBot()
	}

	if err != nil {
		if rbErr := store.Save(prev); rbErr != nil {
			hub.log("op", "[配置回滚失败] "+rbErr.Error())
		} else {
			hub.log("op", "[已回滚本次配置更改]")
		}

		sup.publishStatus()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handlePluginsBulk replaces the entire plugin set in one request, then builds
// and restarts exactly once. The UI batches any number of add / delete / edit
// operations locally and commits them here together, so the bot is rebuilt a
// single time instead of once per change. All the usual guarantees still hold:
// bad input fails (400) before anything is written, and a failed build rolls
// the whole plugins.yaml back to its previous contents.
func handlePluginsBulk(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Plugins []pluginDTO `json:"plugins"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpErr(w, err)
		return
	}
	// Materialize the whole map up front so any validation error aborts before
	// we touch disk or kick off a build.
	next := make(map[string]PluginEntry, len(body.Plugins))
	for _, d := range body.Plugins {
		d.Name = strings.TrimSpace(d.Name)
		if d.Name == "" {
			http.Error(w, "插件名不能为空", http.StatusBadRequest)
			return
		}
		if _, dup := next[d.Name]; dup {
			http.Error(w, "插件名重复: "+d.Name, http.StatusBadRequest)
			return
		}
		cv, err := confFromDTO(d)
		if err != nil {
			http.Error(w, fmt.Sprintf("插件 %s 的 conf 非法: %v", d.Name, err), http.StatusBadRequest)
			return
		}
		next[d.Name] = PluginEntry{
			Repo: d.Repo, Version: d.Version, Seq: d.Seq,
			Exclude: d.Exclude, Disable: d.Disable, Groups: d.Groups, Conf: cv,
		}
	}
	mutatePluginsAndBuild(w, r, func(c *Config) error {
		c.Plugins = next
		return nil
	})
}

func handleGlobalGet(w http.ResponseWriter, r *http.Request) {
	c, err := store.Load()
	if err != nil {
		httpErr(w, err)
		return
	}
	writeJSON(w, map[string]any{
		"path":   c.Path,
		"groups": c.Groups,
		"env":    c.Other,
	})

}

func handleGlobalPut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path   string  `json:"path"`
		Groups []int64 `json:"groups"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpErr(w, err)
		return
	}
	mutatePluginsAndBuild(w, r, func(c *Config) error {
		c.Path = body.Path
		c.Groups = body.Groups
		return nil
	})
}

// ---- driver config (config.json) ----

func handleDriverGet(w http.ResponseWriter, r *http.Request) {
	d, err := driverStore.Load()
	if err != nil {
		httpErr(w, err)
		return
	}
	writeJSON(w, d)
}

// handleDriverPut writes config.json then rebuilds and restarts. config.json is
// read by the bot at startup, so a restart is required to apply it; the rebuild
// keeps the apply path identical to every other config save. On build failure
// the driver config is rolled back and the running bot is left untouched.
func handleDriverPut(w http.ResponseWriter, r *http.Request) {
	var d driverDTO
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		httpErr(w, err)
		return
	}
	opMu.Lock()
	defer opMu.Unlock()

	prev, _ := driverStore.Load()
	if err := driverStore.Save(d); err != nil {
		httpErr(w, err)
		return
	}
	if err := sup.BuildAndRestart(); err != nil {
		_ = driverStore.Save(prev)
		hub.log("op", "[已回滚驱动配置更改]")
		sup.publishStatus()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// ---- actions ----

func handleStatus(w http.ResponseWriter, r *http.Request) { writeJSON(w, sup.Status()) }

// handleSchemas serves the .schemas.json the bot writes at startup. Missing
// file just means no plugin declared a schema yet — return an empty object.
func handleSchemas(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(schemasPath)
	w.Header().Set("Content-Type", "application/json")
	if err != nil || len(b) == 0 {
		_, _ = w.Write([]byte("{}"))
		return
	}
	_, _ = w.Write(b)
}

func handleRebuild(w http.ResponseWriter, r *http.Request) {
	opMu.Lock()
	defer opMu.Unlock()
	if err := sup.BuildAndRestart(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func handleRestart(w http.ResponseWriter, r *http.Request) {
	opMu.Lock()
	defer opMu.Unlock()
	if err := sup.RestartBot(); err != nil {
		httpErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func handleStart(w http.ResponseWriter, r *http.Request) {
	opMu.Lock()
	defer opMu.Unlock()
	if err := sup.StartBot(); err != nil {
		httpErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func handleStop(w http.ResponseWriter, r *http.Request) {
	opMu.Lock()
	defer opMu.Unlock()
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
