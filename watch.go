package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Server-side limits are 20 POST attempts and 5 accepted ingests per hour
// per IP; the spacing below keeps a big backfill safely under the attempt
// cap and lets the 429 backoff absorb the accept cap.
const (
	scanInterval       = 30 * time.Second
	defaultPostSpacing = 3*time.Minute + 30*time.Second
	rateLimitBackoff   = 15 * time.Minute
	transientBackoff   = 2 * time.Minute
	settleAge          = 5 * time.Second
)

type FileRecord struct {
	Status string `json:"status"` // "done" | "skip"
	Sha    string `json:"sha,omitempty"`
	Reason string `json:"reason,omitempty"`
	At     string `json:"at"`
}

// State remembers per-file outcomes across restarts so old replays are not
// re-hashed and re-checked on every launch.
type State struct {
	path  string
	Files map[string]FileRecord `json:"files"`
}

func LoadState(path string) *State {
	s := &State{path: path, Files: map[string]FileRecord{}}
	raw, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(raw, s)
		if s.Files == nil {
			s.Files = map[string]FileRecord{}
		}
	}
	return s
}

func (s *State) Set(file, status, sha, reason string) {
	s.Files[file] = FileRecord{Status: status, Sha: sha, Reason: reason, At: time.Now().UTC().Format(time.RFC3339)}
	raw, err := json.MarshalIndent(s, "", "\t")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		log.Printf("state save failed: %v", err)
		return
	}
	if err := os.Rename(tmp, s.path); err != nil {
		log.Printf("state save failed: %v", err)
	}
}

type scanInfo struct {
	size  int64
	mtime time.Time
}

type pendItem struct {
	path string
	sha  string
}

type Config struct {
	Server      string
	Dirs        []string
	NoBackfill  bool
	Once        bool
	PostSpacing time.Duration
}

type Watcher struct {
	cfg      Config
	client   *Client
	ui       UI
	state    *State
	dirs     []string
	prev     map[string]scanInfo
	pending  []pendItem
	nextPost time.Time
	pauseCls time.Time // classify pause after a failed server check
	uploaded int
	firstRun bool
	scans    int
}

func NewWatcher(cfg Config, client *Client, state *State, ui UI) *Watcher {
	return &Watcher{
		cfg: cfg, client: client, state: state, ui: ui,
		dirs: cfg.Dirs, prev: map[string]scanInfo{}, firstRun: true,
	}
}

func (w *Watcher) Run(ctx context.Context) {
	if len(w.dirs) == 0 {
		log.Print("no replay folder found — pass -dir <path to Replays/Multiplayer>")
	} else {
		for _, d := range w.dirs {
			log.Printf("watching %s", d)
		}
	}
	interval := scanInterval
	if w.cfg.Once {
		interval = time.Second
	}
	for {
		w.tick()
		// -once: exit as soon as everything present is settled and shipped
		if w.cfg.Once && w.scans >= 2 && len(w.pending) == 0 && len(w.prev) == 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func (w *Watcher) tick() {
	w.scan()
	w.maybeUpload()
	w.updateStatus()
}

func (w *Watcher) scan() {
	pendingPaths := map[string]bool{}
	pendingShas := map[string]bool{}
	for _, p := range w.pending {
		pendingPaths[p.path] = true
		pendingShas[p.sha] = true
	}
	for _, dir := range w.dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".sc2replay") {
				continue
			}
			path := filepath.Join(dir, e.Name())
			if _, known := w.state.Files[path]; known || pendingPaths[path] {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			now := scanInfo{size: info.Size(), mtime: info.ModTime()}
			if w.firstRun && w.cfg.NoBackfill {
				w.state.Set(path, "skip", "", "existed before first run (backfill disabled)")
				continue
			}
			old, seen := w.prev[path]
			// only touch files that stopped growing — SC2 writes the replay
			// at game end, but never race a write in progress
			if seen && old.size == now.size && old.mtime.Equal(now.mtime) &&
				time.Since(now.mtime) > settleAge {
				w.classify(path, pendingShas)
				delete(w.prev, path)
			} else {
				w.prev[path] = now
			}
		}
	}
	w.firstRun = false
	w.scans++
}

func (w *Watcher) classify(path string, pendingShas map[string]bool) {
	if !w.pauseCls.IsZero() && time.Now().Before(w.pauseCls) {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("cannot read %s: %v", path, err)
		return
	}
	name := filepath.Base(path)
	if len(data) > maxUploadSize {
		w.state.Set(path, "skip", "", "larger than the 16 MB upload limit")
		log.Printf("skip %s: larger than the 16 MB upload limit", name)
		return
	}
	uar, err := isUARReplay(data)
	if err != nil {
		w.state.Set(path, "skip", "", "unreadable replay: "+err.Error())
		log.Printf("skip %s: unreadable replay: %v", name, err)
		return
	}
	if !uar {
		w.state.Set(path, "skip", "", "not an Undead Assault Reborn replay")
		log.Printf("skip %s: not a UAR replay", name)
		return
	}
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	if pendingShas[sha] {
		w.state.Set(path, "skip", sha, "identical file already queued")
		return
	}
	exists, err := w.client.Exists(sha)
	if err != nil {
		// server unreachable — leave the file unclassified and retry later
		log.Printf("server check failed for %s: %v (retrying later)", name, err)
		w.prev[path] = scanInfo{} // force a fresh look next settled scan
		w.pauseCls = time.Now().Add(transientBackoff)
		return
	}
	if exists {
		w.state.Set(path, "done", sha, "already on the server")
		log.Printf("%s is already on the server", name)
		return
	}
	w.pending = append(w.pending, pendItem{path: path, sha: sha})
	pendingShas[sha] = true
	log.Printf("queued %s", name)
}

func (w *Watcher) maybeUpload() {
	if len(w.pending) == 0 || time.Now().Before(w.nextPost) {
		return
	}
	it := w.pending[0]
	name := filepath.Base(it.path)
	data, err := os.ReadFile(it.path)
	if err != nil {
		w.state.Set(it.path, "skip", it.sha, "file disappeared before upload")
		w.pending = w.pending[1:]
		return
	}
	w.ui.Status("Uploading " + name + "…")
	out := w.client.Upload(name, data)
	switch out.Kind {
	case Accepted:
		w.uploaded++
		w.state.Set(it.path, "done", it.sha, "uploaded")
		w.pending = w.pending[1:]
		w.nextPost = time.Now().Add(w.cfg.PostSpacing)
		log.Printf("uploaded %s: %s", name, out.Message)
	case Duplicate:
		w.state.Set(it.path, "done", it.sha, "already ingested: "+out.Message)
		w.pending = w.pending[1:]
		w.nextPost = time.Now().Add(45 * time.Second)
		log.Printf("%s: %s", name, out.Message)
	case Rejected:
		w.state.Set(it.path, "skip", it.sha, "rejected: "+out.Message)
		w.pending = w.pending[1:]
		w.nextPost = time.Now().Add(45 * time.Second)
		log.Printf("rejected %s: %s", name, out.Message)
	case RateLimited:
		w.nextPost = time.Now().Add(rateLimitBackoff)
		log.Printf("rate limited, retrying %s in %s", name, rateLimitBackoff)
	case Transient:
		w.nextPost = time.Now().Add(transientBackoff)
		log.Printf("upload of %s failed (%s), retrying in %s", name, out.Message, transientBackoff)
	}
}

func (w *Watcher) updateStatus() {
	folders := "folders"
	if len(w.dirs) == 1 {
		folders = "folder"
	}
	s := fmt.Sprintf("Watching %d %s", len(w.dirs), folders)
	if len(w.dirs) == 0 {
		s = "No replay folder found (use -dir)"
	}
	if w.uploaded > 0 {
		s += fmt.Sprintf(" — %d uploaded", w.uploaded)
	}
	if n := len(w.pending); n > 0 {
		s += fmt.Sprintf(" — %d queued", n)
		if wait := time.Until(w.nextPost); wait > time.Minute {
			s += fmt.Sprintf(" (next in %dm)", int(wait.Minutes()))
		}
	}
	w.ui.Status(s)
}
