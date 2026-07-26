//go:build linux

package main

import _ "embed"

//go:embed assets/icon.png
var iconPNG []byte

func trayIcon() []byte { return iconPNG }
