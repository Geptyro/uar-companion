//go:build darwin

package main

import "context"

// The macOS build is console-only: the tray library needs cgo/AppKit there,
// which would complicate cross-compiled releases for a tiny audience.
func runTray(ctx context.Context, stop func(), cfg Config, client *Client, state *State) {
	ui := &consoleUI{}
	w := NewWatcher(cfg, client, state, ui)
	go readyLoop(ctx, client, ui)
	w.Run(ctx)
}
