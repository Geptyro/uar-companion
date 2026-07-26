// uar-tray watches the local StarCraft II replay folder and uploads new
// Undead Assault Reborn replays to uar.cedricdessalles.dev, with a system
// tray icon showing status and how many players are flagged ready to play.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"syscall"
	"time"
)

var version = "dev"

const defaultServer = "https://uar.cedricdessalles.dev"

type dirList []string

func (d *dirList) String() string { return fmt.Sprint(*d) }
func (d *dirList) Set(v string) error {
	*d = append(*d, v)
	return nil
}

func main() {
	var dirs dirList
	server := flag.String("server", defaultServer, "UAR website base URL")
	noTray := flag.Bool("no-tray", false, "run in the console without a tray icon")
	noBackfill := flag.Bool("no-backfill", false, "skip replays that already exist on first run")
	once := flag.Bool("once", false, "scan and upload once, then exit (implies -no-tray)")
	spacing := flag.Duration("spacing", 0, "minimum delay between uploads (default 3m30s)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Var(&dirs, "dir", "replay folder to watch (repeatable; default: auto-detect)")
	flag.Parse()

	if *showVersion {
		fmt.Println("uar-tray", version)
		return
	}

	cfgDir := configDir()
	setupLog(cfgDir)
	log.Printf("uar-tray %s starting (server %s)", version, *server)

	watchDirs := []string(dirs)
	if len(watchDirs) == 0 {
		watchDirs = discoverReplayDirs()
	}

	cfg := Config{
		Server:      *server,
		Dirs:        watchDirs,
		NoBackfill:  *noBackfill,
		Once:        *once,
		PostSpacing: *spacing,
	}
	if cfg.PostSpacing <= 0 {
		cfg.PostSpacing = defaultPostSpacing
	}

	client := NewClient(cfg.Server, version)
	state := LoadState(filepath.Join(cfgDir, "state.json"))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *once || *noTray {
		ui := &consoleUI{}
		w := NewWatcher(cfg, client, state, ui)
		if !*once {
			go readyLoop(ctx, client, ui)
		}
		w.Run(ctx)
		return
	}
	runTray(ctx, stop, cfg, client, state)
}

// discoverReplayDirs expands the per-OS glob candidates into the set of
// Replays/Multiplayer folders that actually exist.
func discoverReplayDirs() []string {
	seen := map[string]bool{}
	var out []string
	for _, pattern := range replayDirGlobs() {
		matches, _ := filepath.Glob(pattern)
		for _, m := range matches {
			if info, err := os.Stat(m); err == nil && info.IsDir() && !seen[m] {
				seen[m] = true
				out = append(out, m)
			}
		}
	}
	sort.Strings(out)
	return out
}

func configDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	dir := filepath.Join(base, "uar-tray")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// setupLog writes to uar-tray.log next to the state file (the Windows build
// has no console at all) and mirrors to stderr for terminal runs.
func setupLog(cfgDir string) {
	path := filepath.Join(cfgDir, "uar-tray.log")
	if info, err := os.Stat(path); err == nil && info.Size() > 1<<20 {
		_ = os.Rename(path, path+".old")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return // stderr only
	}
	log.SetOutput(io.MultiWriter(os.Stderr, f))
}

func readyLoop(ctx context.Context, client *Client, ui UI) {
	for {
		n, names, err := client.ReadyCount()
		ui.Ready(n, names, err == nil)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Minute):
		}
	}
}
