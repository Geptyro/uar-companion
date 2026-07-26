package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSniffRecognizesUARFixtures(t *testing.T) {
	for _, name := range []string{"20260723-1802.SC2Replay", "20260723-1808.SC2Replay"} {
		data, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		uar, err := isUARReplay(data)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !uar {
			t.Errorf("%s: expected UAR title to be found", name)
		}
	}
}

func TestSniffRejectsJunk(t *testing.T) {
	if _, err := isUARReplay([]byte("this is definitely not an MPQ archive, not even close")); err == nil {
		t.Error("junk bytes should not parse as a replay")
	}
	if _, err := isUARReplay([]byte{}); err == nil {
		t.Error("empty input should not parse as a replay")
	}
	// truncated real replay: valid magic, tables point past the end
	data, err := os.ReadFile(filepath.Join("testdata", "20260723-1808.SC2Replay"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := isUARReplay(data[:200]); err == nil {
		t.Error("truncated replay should error, not crash")
	}
}
