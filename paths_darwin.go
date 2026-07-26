//go:build darwin

package main

import "os"

func replayDirGlobs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{
		home + "/Library/Application Support/Blizzard/StarCraft II/Accounts/*/*/Replays/Multiplayer",
	}
}
