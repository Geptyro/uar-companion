package main

import (
	"log"
	"strconv"
	"strings"
	"sync"
)

// UI is where the watcher and the ready-poller report; implemented by the
// tray menu and by a console fallback.
type UI interface {
	Status(line string)
	Ready(count int, names []string, ok bool)
}

type consoleUI struct {
	mu         sync.Mutex
	lastStatus string
	lastReady  string
}

func (c *consoleUI) Status(line string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if line == c.lastStatus {
		return
	}
	c.lastStatus = line
	log.Print(line)
}

func (c *consoleUI) Ready(count int, names []string, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	line := "ready to play: unavailable"
	if ok {
		line = "ready to play: " + readyLine(count, names)
	}
	if line == c.lastReady {
		return
	}
	c.lastReady = line
	log.Print(line)
}

func readyLine(count int, names []string) string {
	if count == 0 {
		return "0"
	}
	return strconv.Itoa(count) + " (" + strings.Join(names, ", ") + ")"
}
