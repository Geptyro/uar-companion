package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestExists(t *testing.T) {
	var gotSha string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSha = r.URL.Query().Get("sha256")
		json.NewEncoder(w).Encode(map[string]bool{"exists": true})
	}))
	defer srv.Close()

	exists, err := NewClient(srv.URL, "test").Exists("abc123")
	if err != nil || !exists {
		t.Fatalf("exists=%v err=%v", exists, err)
	}
	if gotSha != "abc123" {
		t.Errorf("sha query param = %q", gotSha)
	}
}

func TestUploadOutcomes(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   OutcomeKind
	}{
		{200, `{"ok":true,"message":"Replay accepted — profiles are live now."}`, Accepted},
		{409, `{"message":"This exact replay file is already ingested."}`, Duplicate},
		{429, `{"message":"Too many uploads — try again later."}`, RateLimited},
		{400, `{"message":"Not a readable StarCraft II replay."}`, Rejected},
		{413, `{"message":"Replay too large."}`, Rejected},
		{500, `boom`, Transient},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if err := r.ParseMultipartForm(32 << 20); err != nil {
				t.Errorf("not a multipart form: %v", err)
			}
			f, _, err := r.FormFile("replay")
			if err != nil {
				t.Errorf(`no "replay" form field: %v`, err)
			} else {
				raw, _ := io.ReadAll(f)
				if string(raw) != "replaydata" {
					t.Errorf("field bytes = %q", raw)
				}
			}
			w.WriteHeader(c.status)
			w.Write([]byte(c.body))
		}))
		out := NewClient(srv.URL, "test").Upload("x.SC2Replay", []byte("replaydata"))
		if out.Kind != c.want {
			t.Errorf("status %d: outcome %v, want %v (msg %q)", c.status, out.Kind, c.want, out.Message)
		}
		if c.status == 400 && out.Message != "Not a readable StarCraft II replay." {
			t.Errorf("message extraction failed: %q", out.Message)
		}
		srv.Close()
	}
}

func TestReadyCount(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"me":false,"until":null,"players":[{"battletag":"Foo#123"},{"battletag":"Bar#456"}]}`))
	}))
	defer srv.Close()
	n, names, err := NewClient(srv.URL, "test").ReadyCount()
	if err != nil || n != 2 || names[0] != "Foo#123" {
		t.Fatalf("n=%d names=%v err=%v", n, names, err)
	}
}

// TestWatcherOnce runs the full pipeline against a fake server: settle
// detection, MPQ sniff, sha pre-check, upload, state record.
func TestWatcherOnce(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join("testdata", "20260723-1808.SC2Replay"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	replay := filepath.Join(dir, "Undead Assault reborn.SC2Replay")
	junk := filepath.Join(dir, "Other Map.SC2Replay")
	os.WriteFile(replay, fixture, 0o644)
	os.WriteFile(junk, []byte("not a real replay"), 0o644)
	old := time.Now().Add(-time.Minute)
	os.Chtimes(replay, old, old)
	os.Chtimes(junk, old, old)

	var posts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(map[string]bool{"exists": false})
			return
		}
		posts++
		w.Write([]byte(`{"ok":true,"message":"accepted"}`))
	}))
	defer srv.Close()

	state := LoadState(filepath.Join(dir, "state.json"))
	cfg := Config{Server: srv.URL, Dirs: []string{dir}, Once: true, PostSpacing: time.Millisecond}
	w := NewWatcher(cfg, NewClient(srv.URL, "test"), state, &consoleUI{})
	done := make(chan struct{})
	go func() {
		w.Run(context.Background())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("watcher -once did not finish")
	}

	if posts != 1 {
		t.Errorf("expected exactly 1 upload POST, got %d", posts)
	}
	if rec := state.Files[replay]; rec.Status != "done" || rec.Reason != "uploaded" {
		t.Errorf("replay record = %+v", rec)
	}
	if rec := state.Files[junk]; rec.Status != "skip" {
		t.Errorf("junk record = %+v", rec)
	}

	// second run: nothing new, no further posts
	w2 := NewWatcher(cfg, NewClient(srv.URL, "test"), LoadState(filepath.Join(dir, "state.json")), &consoleUI{})
	w2.Run(context.Background())
	if posts != 1 {
		t.Errorf("re-run must not re-upload; posts=%d", posts)
	}
}
