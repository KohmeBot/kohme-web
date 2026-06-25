package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// authFile is the on-disk credential record. The password is never stored;
// only a PBKDF2-HMAC-SHA256 hash with a per-account random salt.
type authFile struct {
	Username string `json:"username"`
	Salt     string `json:"salt"`
	Hash     string `json:"hash"`
	Iter     int    `json:"iter"`
}

// AuthStore manages the single admin account and active browser sessions.
type AuthStore struct {
	mu       sync.Mutex
	path     string
	cur      *authFile
	sessions map[string]bool
}

func NewAuthStore(path string) *AuthStore {
	a := &AuthStore{path: path, sessions: map[string]bool{}}
	a.load()
	return a
}

func (a *AuthStore) load() {
	_ = os.MkdirAll(filepath.Dir(a.path), 0700)
	b, err := os.ReadFile(a.path)
	if err != nil {
		return
	}
	var f authFile
	if json.Unmarshal(b, &f) == nil && f.Hash != "" {
		a.cur = &f
	}
}

// Reset wipes the stored account so the first-run setup flow runs again.
func (a *AuthStore) Reset() error {
	a.mu.Lock()
	a.cur = nil
	a.sessions = map[string]bool{}
	a.mu.Unlock()
	if err := os.Remove(a.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (a *AuthStore) Configured() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cur != nil
}

func (a *AuthStore) Username() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cur == nil {
		return ""
	}
	return a.cur.Username
}

// pbkdf2SHA256 derives one 32-byte block (enough for SHA-256 output length).
func pbkdf2SHA256(password, salt []byte, iter int) []byte {
	mac := hmac.New(sha256.New, password)
	mac.Write(salt)
	mac.Write([]byte{0, 0, 0, 1}) // INT(1)
	u := mac.Sum(nil)
	out := make([]byte, len(u))
	copy(out, u)
	for i := 1; i < iter; i++ {
		mac.Reset()
		mac.Write(u)
		u = mac.Sum(nil)
		for j := range out {
			out[j] ^= u[j]
		}
	}
	return out
}

func (a *AuthStore) SetCredentials(username, password string) error {
	if username == "" || password == "" {
		return errors.New("账号和密码不能为空")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	const iter = 200000
	hash := pbkdf2SHA256([]byte(password), salt, iter)
	f := authFile{
		Username: username,
		Salt:     hex.EncodeToString(salt),
		Hash:     hex.EncodeToString(hash),
		Iter:     iter,
	}
	b, _ := json.MarshalIndent(f, "", "  ")
	if err := os.WriteFile(a.path, b, 0o600); err != nil {
		return err
	}
	a.mu.Lock()
	a.cur = &f
	a.mu.Unlock()
	return nil
}

func (a *AuthStore) Verify(username, password string) bool {
	a.mu.Lock()
	f := a.cur
	a.mu.Unlock()
	if f == nil {
		return false
	}
	salt, _ := hex.DecodeString(f.Salt)
	want, _ := hex.DecodeString(f.Hash)
	got := pbkdf2SHA256([]byte(password), salt, f.Iter)
	userOK := subtle.ConstantTimeCompare([]byte(username), []byte(f.Username)) == 1
	passOK := subtle.ConstantTimeCompare(got, want) == 1
	return userOK && passOK
}

func (a *AuthStore) ChangePassword(oldPw, newPw string) error {
	u := a.Username()
	if u == "" {
		return errors.New("尚未设置账户")
	}
	if !a.Verify(u, oldPw) {
		return errors.New("原密码不正确")
	}
	return a.SetCredentials(u, newPw)
}

func (a *AuthStore) NewSession() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	a.mu.Lock()
	a.sessions[id] = true
	a.mu.Unlock()
	return id
}

func (a *AuthStore) ValidSession(id string) bool {
	if id == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[id]
}

func (a *AuthStore) DropSession(id string) {
	a.mu.Lock()
	delete(a.sessions, id)
	a.mu.Unlock()
}
