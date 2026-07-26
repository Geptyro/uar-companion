//go:build windows || linux

package main

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"

	"fyne.io/systray"
)

type trayUI struct {
	status *systray.MenuItem
	ready  *systray.MenuItem
}

func (t *trayUI) Status(line string) {
	t.status.SetTitle(line)
}

func (t *trayUI) Ready(count int, names []string, ok bool) {
	if !ok {
		t.ready.SetTitle("Ready to play: –")
		systray.SetTooltip("UAR Tray — replay uploader")
		return
	}
	t.ready.SetTitle("Ready to play: " + strconv.Itoa(count))
	tip := "UAR Tray — replay uploader"
	if count > 0 {
		tip = "Ready to play: " + strings.Join(names, ", ")
	}
	systray.SetTooltip(tip)
}

func runTray(ctx context.Context, stop func(), cfg Config, client *Client, state *State) {
	onReady := func() {
		systray.SetIcon(trayIcon())
		systray.SetTooltip("UAR Tray — replay uploader")

		status := systray.AddMenuItem("Starting…", "")
		status.Disable()
		ready := systray.AddMenuItem("Ready to play: –", "who flagged themselves ready on the website")
		ready.Disable()
		systray.AddSeparator()
		site := systray.AddMenuItem("Open uar.cedricdessalles.dev", "")
		logItem := systray.AddMenuItem("Open log file", "")
		systray.AddSeparator()
		quit := systray.AddMenuItem("Quit", "")

		ui := &trayUI{status: status, ready: ready}
		w := NewWatcher(cfg, client, state, ui)
		go w.Run(ctx)
		go readyLoop(ctx, client, ui)

		go func() {
			for {
				select {
				case <-site.ClickedCh:
					openExternal(cfg.Server)
				case <-logItem.ClickedCh:
					openExternal(filepath.Join(configDir(), "uar-tray.log"))
				case <-quit.ClickedCh:
					systray.Quit()
				case <-ctx.Done():
					systray.Quit()
					return
				}
			}
		}()
	}
	systray.Run(onReady, stop)
}
