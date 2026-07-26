//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// replayDirGlobs resolves the real Documents folder (which OneDrive often
// redirects away from %USERPROFILE%\Documents) and adds plain fallbacks.
func replayDirGlobs() []string {
	const tail = `\StarCraft II\Accounts\*\*\Replays\Multiplayer`
	var globs []string
	if docs, err := windows.KnownFolderPath(windows.FOLDERID_Documents, 0); err == nil && docs != "" {
		globs = append(globs, docs+tail)
	}
	if profile := os.Getenv("USERPROFILE"); profile != "" {
		globs = append(globs,
			profile+`\Documents`+tail,
			profile+`\OneDrive\Documents`+tail,
		)
	}
	return globs
}
