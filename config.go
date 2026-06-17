package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/kohmebot/kohme/pkg/conf"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// PluginEntry mirrors one entry under `plugins:` in plugins.yaml.
// Conf is kept as a raw YAML node so the plugin's own config block
// round-trips with its key order and inline comments intact.
type PluginEntry = conf.CustomPluginConf

// Config mirrors the top level of plugins.yaml.
type Config conf.PluginConf

// ConfigStore guards concurrent access to the on-disk plugins.yaml.
type ConfigStore struct {
	mu   sync.Mutex
	path string
}

func NewConfigStore(path string) *ConfigStore {
	return &ConfigStore{path: path}
}

func (s *ConfigStore) Load() (*Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return loadConfig(s.path)
}

func loadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 %s 失败: %w", path, err)
	}
	var c Config
	if err := yaml.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("解析 plugins.yaml 失败: %w", err)
	}
	if c.Plugins == nil {
		c.Plugins = map[string]PluginEntry{}
	}
	return &c, nil
}

// Save writes the config back, taking a timestamped backup first so a bad
// edit can never lose the original file.
func (s *ConfigStore) Save(c *Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, err := os.Stat(s.path); err == nil {
		if err := backup(s.path); err != nil {
			return fmt.Errorf("备份失败: %w", err)
		}
	}

	out, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Update loads, applies fn, then saves — all under the same lock.
func (s *ConfigStore) Update(fn func(*Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := loadConfig(s.path)
	if err != nil {
		return err
	}
	if err := fn(c); err != nil {
		return err
	}
	if _, err := os.Stat(s.path); err == nil {
		if err := backup(s.path); err != nil {
			return fmt.Errorf("备份失败: %w", err)
		}
	}
	out, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func backup(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	stamp := time.Now().Format("20060102-150405")
	if err := os.WriteFile(path+".bak."+stamp, b, 0o644); err != nil {
		return err
	}
	pruneBackups(path, 20)
	return nil
}

func pruneBackups(path string, keep int) {
	dir := filepath.Dir(path)
	base := filepath.Base(path) + ".bak."
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var baks []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), base) {
			baks = append(baks, filepath.Join(dir, e.Name()))
		}
	}
	if len(baks) <= keep {
		return
	}
	sort.Strings(baks) // timestamp suffix sorts chronologically
	for _, old := range baks[:len(baks)-keep] {
		_ = os.Remove(old)
	}
}

// confToYAML renders a plugin's conf value back to a YAML string for the editor.
func confToYAML(v map[string]any) string {
	if len(v) == 0 {
		return ""
	}

	b, err := yaml.Marshal(v)
	if err != nil {
		return ""
	}

	return string(b)
}

// yamlToConf parses editor text back into a node. Empty text means "no conf".
func yamlToConf(text string) (yaml.Node, error) {
	var zero yaml.Node
	if strings.TrimSpace(text) == "" {
		return zero, nil
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return zero, fmt.Errorf("conf 不是合法的 YAML: %w", err)
	}
	if doc.Kind == yaml.DocumentNode && len(doc.Content) == 1 {
		return *doc.Content[0], nil
	}
	return doc, nil
}

// confToValue returns the plain Go value, for JSON / form use.
func confToValue(v map[string]any) any {
	if len(v) == 0 {
		return nil
	}
	return v
}

// buildSignature hashes only the fields that change which code is compiled in
// (repo, version, exclude). If this differs from the last successful build,
// a full rebuild is required; otherwise a plain restart applies the change.
func buildSignature(c *Config) string {
	names := make([]string, 0, len(c.Plugins))
	for name := range c.Plugins {
		names = append(names, name)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, name := range names {
		p := c.Plugins[name]
		if p.Exclude {
			continue
		}
		fmt.Fprintf(h, "%s|%s|%s\n", name, p.Repo, p.Version)
	}
	return hex.EncodeToString(h.Sum(nil))
}
