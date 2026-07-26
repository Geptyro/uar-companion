//go:build windows

package main

import _ "embed"

//go:embed assets/icon.ico
var iconICO []byte

func trayIcon() []byte { return iconICO }
