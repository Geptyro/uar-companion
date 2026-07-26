# UAR Tray

Companion app for **[Undead Assault Reborn](https://uar.cedricdessalles.dev)**
(StarCraft II arcade, EU). It sits in your system tray and:

- **auto-uploads your UAR replays** to [uar.cedricdessalles.dev](https://uar.cedricdessalles.dev),
  so your profile, XP history and the leaderboards stay up to date — no manual
  uploads after every game;
- **shows who is "ready to play"** right in the tray, with an optional
  notification when someone flags themselves on the website.

## Install

Grab the latest build from the
[releases page](https://github.com/Geptyro/uar-tray/releases/latest):

| OS | File | Notes |
| --- | --- | --- |
| Windows | `UAR-Tray-Setup-<version>.exe` | one-click installer; SmartScreen may warn (unsigned) — “More info → Run anyway” |
| Linux | `UAR-Tray-<version>.AppImage` | `chmod +x`, then run |
| macOS | `UAR-Tray-<version>-mac.zip` | unzip, right-click → Open the first time (unsigned) |

On first launch the app finds your `Replays/Multiplayer` folder by itself
(Windows, macOS, and Lutris / Wine / Steam Proton layouts on Linux). If yours
is somewhere unusual, add it under **Watched folders**. Turn on **Start with
the computer** in the settings and forget about it.

## What it uploads (and what it doesn't)

Every new replay is checked **on your machine** first: only files whose map
title is *Undead Assault reborn* are ever sent, everything else is ignored.
A hash pre-check skips replays the server already knows, and uploads are
spaced out to respect the server's rate limits (a large backlog simply takes
a few hours to trickle in — 409 "already ingested" answers are normal when a
teammate's recording of the same game got there first).

Replays contain the same save-data every player in the lobby already
broadcasts in-game; the website uses it for the public player profiles.

## Development

```bash
npm install
npm run dev        # electron-vite dev with hot reload
npm test           # unit tests (node:test over the core modules)
npm run e2e        # full-stack test against a local uar-website + docker rig
npm run dist:linux # package an AppImage (dist:win / dist:mac likewise)
```

The core logic (MPQ title sniff, upload queue, folder discovery) lives in
`src/core/` as plain dependency-light TypeScript — `src/cli.ts` runs it
headless without Electron. `src/core/mpq.ts` is vendored from the website's
TS port of [mpyq](https://github.com/arkx/mpyq) (MIT, Aku Kotkavuo).

Releases: tag `v*` → GitHub Actions builds all three platforms and attaches
them to a GitHub release.
