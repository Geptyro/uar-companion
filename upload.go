package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// mapTitle mirrors MAP_TITLE in the website's upload endpoint.
const mapTitle = "Undead Assault reborn"

const maxUploadSize = 16 << 20

// isUARReplay opens the replay archive and looks for the map title in the
// small replay.details entry — patch-proof (no versioned protocol decode)
// and cheap enough to run on every new file.
func isUARReplay(data []byte) (bool, error) {
	a, err := NewMPQArchive(data)
	if err != nil {
		return false, err
	}
	details, err := a.ReadFile("replay.details")
	if err != nil {
		return false, err
	}
	if details == nil {
		return false, errors.New("replay.details missing from archive")
	}
	return bytes.Contains(details, []byte(mapTitle)), nil
}

type OutcomeKind int

const (
	Accepted OutcomeKind = iota
	Duplicate
	Rejected
	RateLimited
	Transient
)

type Outcome struct {
	Kind    OutcomeKind
	Message string
}

type Client struct {
	server string
	http   *http.Client
	ua     string
}

func NewClient(server, version string) *Client {
	return &Client{
		server: strings.TrimRight(server, "/"),
		http:   &http.Client{Timeout: 90 * time.Second},
		ua:     "uar-tray/" + version,
	}
}

// Exists asks the server whether it already stores this exact file
// (GET /api/replays?sha256=...) so known replays never spend an upload.
func (c *Client) Exists(sha256hex string) (bool, error) {
	req, err := http.NewRequest("GET", c.server+"/api/replays?sha256="+sha256hex, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", c.ua)
	resp, err := c.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("sha check: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Exists bool `json:"exists"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body); err != nil {
		return false, err
	}
	return body.Exists, nil
}

// Upload POSTs the replay as multipart field "replay" and maps the server's
// answer onto what the queue should do next.
func (c *Client) Upload(filename string, data []byte) Outcome {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("replay", filename)
	if err == nil {
		_, err = part.Write(data)
	}
	if err == nil {
		err = mw.Close()
	}
	if err != nil {
		return Outcome{Transient, err.Error()}
	}

	req, err := http.NewRequest("POST", c.server+"/api/replays", &buf)
	if err != nil {
		return Outcome{Transient, err.Error()}
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("User-Agent", c.ua)
	// SvelteKit renders errors as HTML pages unless JSON is asked for
	req.Header.Set("Accept", "application/json")
	// adapter-node rejects cross-site form posts without an Origin it trusts
	req.Header.Set("Origin", c.server)

	resp, err := c.http.Do(req)
	if err != nil {
		return Outcome{Transient, err.Error()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	msg := serverMessage(raw)

	switch {
	case resp.StatusCode == http.StatusOK:
		return Outcome{Accepted, msg}
	case resp.StatusCode == http.StatusConflict:
		return Outcome{Duplicate, msg}
	case resp.StatusCode == http.StatusTooManyRequests:
		return Outcome{RateLimited, msg}
	case resp.StatusCode == http.StatusBadRequest ||
		resp.StatusCode == http.StatusRequestEntityTooLarge:
		return Outcome{Rejected, msg}
	default:
		return Outcome{Transient, fmt.Sprintf("HTTP %d: %s", resp.StatusCode, msg)}
	}
}

// ReadyCount polls the site's "ready to play" widget (GET /api/ready).
func (c *Client) ReadyCount() (int, []string, error) {
	req, err := http.NewRequest("GET", c.server+"/api/ready", nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("User-Agent", c.ua)
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var body struct {
		Players []struct {
			Battletag string `json:"battletag"`
		} `json:"players"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&body); err != nil {
		return 0, nil, err
	}
	names := make([]string, 0, len(body.Players))
	for _, p := range body.Players {
		names = append(names, p.Battletag)
	}
	return len(names), names, nil
}

// serverMessage extracts the human-readable part of a SvelteKit response
// ({"message": ...} on errors, {"message"/"ok"} on success), falling back
// to the raw body.
func serverMessage(raw []byte) string {
	var body struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &body); err == nil && body.Message != "" {
		return body.Message
	}
	s := strings.TrimSpace(string(raw))
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
