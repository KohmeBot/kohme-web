package main

import (
	"encoding/json"
	"os"
	"sync"
)

// wsDTO mirrors WsConf {url, token}.
type wsDTO struct {
	Url   string `json:"url"`
	Token string `json:"token"`
}

// zeroDTO mirrors zero.Config (only the JSON-serialized fields; Driver is
// `json:"-"` in the bot and never appears in config.json, so it's omitted).
type zeroDTO struct {
	Nickname        []string `json:"nickname"`
	CommandPrefix   string   `json:"command_prefix"`
	SuperUsers      []int64  `json:"super_users"`
	RingLen         uint     `json:"ring_len"`
	Latency         int64    `json:"latency"`          // time.Duration (纳秒)
	MaxProcessTime  int64    `json:"max_process_time"` // time.Duration (纳秒)
	MarkMessage     bool     `json:"mark_message"`
	KeepAtMeMessage bool     `json:"keep_at_me_message"`
}

// driverDTO mirrors ZeroConf {zero, ws, rws}.
type driverDTO struct {
	Zero zeroDTO `json:"zero"`
	Ws   wsDTO   `json:"ws"`
	Rws  wsDTO   `json:"rws"`
}

// DriverStore reads and writes conf/config.json. On write it overlays the
// known fields onto the existing file's JSON so any extra keys (and any zero.*
// keys this admin doesn't model) are preserved, with a backup taken first.
type DriverStore struct {
	mu   sync.Mutex
	path string
}

func NewDriverStore(path string) *DriverStore { return &DriverStore{path: path} }

func (s *DriverStore) Load() (driverDTO, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var d driverDTO
	b, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return d, nil // file not created yet -> empty defaults
		}
		return d, err
	}
	// Tolerant: a stray field type won't blank the whole panel.
	_ = json.Unmarshal(b, &d)
	return d, nil
}

func (s *DriverStore) Save(d driverDTO) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	top := map[string]any{}
	if b, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(b, &top)
		if err := backup(s.path); err != nil {
			return err
		}
	}

	zero, _ := top["zero"].(map[string]any)
	if zero == nil {
		zero = map[string]any{}
	}
	nick := d.Zero.Nickname
	if nick == nil {
		nick = []string{}
	}
	supers := d.Zero.SuperUsers
	if supers == nil {
		supers = []int64{}
	}
	zero["nickname"] = nick
	zero["command_prefix"] = d.Zero.CommandPrefix
	zero["super_users"] = supers
	zero["ring_len"] = d.Zero.RingLen
	zero["latency"] = d.Zero.Latency
	zero["max_process_time"] = d.Zero.MaxProcessTime
	zero["mark_message"] = d.Zero.MarkMessage
	zero["keep_at_me_message"] = d.Zero.KeepAtMeMessage
	top["zero"] = zero
	top["ws"] = map[string]any{"url": d.Ws.Url, "token": d.Ws.Token}
	top["rws"] = map[string]any{"url": d.Rws.Url, "token": d.Rws.Token}

	out, err := json.MarshalIndent(top, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
