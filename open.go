package main

import (
	"log"
	"os/exec"
	"runtime"
)

// openExternal hands a URL or file path to the OS default handler.
func openExternal(target string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// rundll32 is a GUI-subsystem binary: no console window flashes up
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("open %s failed: %v", target, err)
	}
}
