//go:build linux

package main

import "os"

// replayDirGlobs covers the usual SC2-under-Wine layouts: Lutris prefixes
// under ~/Games, plain Wine, Steam Proton, and Bottles (flatpak).
func replayDirGlobs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	const tail = "/StarCraft II/Accounts/*/*/Replays/Multiplayer"
	return []string{
		home + "/Games/*/drive_c/users/*/Documents" + tail,
		home + "/Games/*/drive_c/users/*/My Documents" + tail,
		home + "/.wine/drive_c/users/*/Documents" + tail,
		home + "/.wine/drive_c/users/*/My Documents" + tail,
		home + "/.local/share/Steam/steamapps/compatdata/*/pfx/drive_c/users/*/Documents" + tail,
		home + "/.var/app/com.usebottles.bottles/data/bottles/bottles/*/drive_c/users/*/Documents" + tail,
	}
}
