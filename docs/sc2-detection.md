# SC2 presence detection — what we can see and how

Everything UAR Companion knows about the running StarCraft II client, verified
live on 2026-07-26 (SC2 under Wine, EU, during real UAR lobbies and games).
This is also the reference for the website's presence feature.

## Sources

### 1. Local client API — `http://localhost:6119` (JSON, plain HTTP)

Only responds while SC2 runs (connection refused otherwise). No CORS
headers → must be polled from a Node/main process, not a browser. Two
endpoints only; **no identifiers of any kind** (no lobby id, no map name).

#### `GET /ui` → `{ activeScreens: string[] }`

| State | `activeScreens` |
| --- | --- |
| in menus | screen names (`ScreenHome/ScreenHome`, …) |
| in a lobby | contains `ScreenBattleLobby/ScreenBattleLobby` (verified, private + public) |
| in game (or watching a replay) | `[]` |

- **Public and private lobbies are byte-identical** on both endpoints
  (verified by diff) — lobby privacy is not detectable locally. Word
  badges neutrally: "in a lobby", never "joinable".

#### `GET /game` → `{ isReplay, displayTime, players[] }`

- `players[]`: `{ id, name, type: 'user'|'computer', race, result }` —
  `result` is always `"Undecided"` in arcade.
- **Empty while in a lobby** (verified) — roster only exists in-game.
- `displayTime`: game clock in seconds (float).
- `name` is the display name, not the battletag (no `#1234`).

**UAR fingerprint (in-game):** the map name is not exposed, but a UAR game
always carries the computer slots `UT Army` + `Undead` (Zerg) + `PMC`
(players 13/14/15 — the map script's NPC/hostile/PMC owners). Verified in
a 12-human public game and a 1-human solo game. Replays are excluded via
`isReplay`.

### 2. Lobby temp file — `replay.server.battlelobby`

**Not present while a lobby is open.** Verified 2026-07-26, sitting in a
joined UAR lobby (`ScreenBattleLobby` active): no `battlelobby` file
anywhere on disk, no `StarCraft II/TempWriteReplayP*` directory in the
live Proton prefix, and no temp/replay descriptor among SC2's 618 open
files. An earlier version of this doc claimed it was written when the
lobby forms; that was wrong.

It is believed to appear at game start — the directory is where the
replay is written, and our captures came from somewhere — then
**deleted when the game ends**. Not yet observed directly; the session
that verified the lobby case ended before a game started.

Consequence: `lobbyId` is unavailable for lobbies. The app reads the file
whenever status is not `menus` (lobby and in-game) and keeps the last
parse sticky, so an id can only ever arrive from game start onward.

Locations (newest wins; Wine user dirs may be symlinked duplicates):

- Windows: `%LOCALAPPDATA%\Temp\StarCraft II\TempWriteReplayP*\`
- Wine/Proton: `<prefix>/drive_c/users/*/AppData/Local/Temp/StarCraft II/TempWriteReplayP*/`
- macOS (unverified): `~/Library/Caches/Blizzard/StarCraft II/Temp…`

Content (~48 KB): the lobby's `initData` sync state in a **variant
encoding** — bit-packed overall, but everything we need happens to be
byte-aligned. `parseBattleLobby()` in `src/core/sc2.ts` extracts, without
any protocol decoding:

- **UAR identity**: the map's Battle.net cache paths (s2ma content hashes)
  in plain ASCII. All 8 UAR hashes (map + 7 dependency mods) matched a
  live lobby; any-of-8 matching survives map patches
  (`UAR_CACHE_HASHES`).
- **The lobbyId** (`m_randomValue` — the id the replay pipeline dedupes
  by): big-endian uint32, located 14 bytes before the fixed structure
  marker `02 00 14 cc 02 00 00 00 01 00`. Calibrated by bit-hunting each
  capture's ground-truth id (decoded from that lobby's replay): the marker
  occurs exactly once per file and the id matched in all three samples —
  two solo lobbies and one 12-player public game. A zero-run heuristic is
  kept as fallback in case a map/patch update moves the marker; it cannot
  read ids whose high byte is 0x00, the signature anchor can.
- **The roster as battletags** (`Name#1234`, plain bytes) — scoped to
  offsets after the id block, because the map-info section earlier in the
  file embeds the map AUTHOR's tags (Znimu#743, Finite#521 in UAR).
  Members appear in (profile name+code, account battletag) pairs — the two
  can differ completely (`DynamiteHero#725` → `BttlTgsSuxxx#2914`), and
  the account battletag is what site accounts key on. Verified complete
  and correctly paired for all 12 players of a real public game. ASCII
  names only — unicode names don't match the pattern (known v1 limit).
- **Still locked (needs original reverse-engineering — researched
  2026-07-26: no public decoder or type tables exist anywhere; Blizzard's
  s2protocol skips the file, HotS parsers use battletag-regex workarounds
  like ours):** toon handles, clan tags, exact slot/team layout, host,
  game options. Groundwork done: the file shares verbatim byte regions
  with replay.initData at piecewise shifts (800 bytes at +969 on the solo
  pair — static map/settings content), so a same-lobby multiplayer
  pair (capture + its replay) may allow slice-decoding without full type
  tables.
- **Not in it**: the lobby privacy flag, the map title string.

Validation status: calibrated and regression-tested against three real
captures (two solo lobbies, one 12-player public game) — fixtures live in
`testdata/battlelobby-*.bin`.

## What the app derives (`SC2Presence`)

```ts
{
  status: 'menus' | 'lobby' | 'ingame',
  uar: boolean,        // in-game: computer fingerprint; lobby: cache-hash match
  players?: number,    // humans in the game (in-game only)
  displayTime?: number,// game clock, whole seconds (in-game only)
  roster?: string[]    // sorted human display names (in-game only)
}
```

Poll cadence: 4 s while SC2 answers, 30 s backoff while it doesn't.

## Server contract (heartbeat)

- `POST /api/presence` (cookie-auth): the `SC2Presence` object, on change
  + every 60 s. Stale after ~2 min. `DELETE /api/presence` on SC2 exit /
  app quit.
- Side effects (server): `lobby`/`ingame` clears the account's ready flag;
  while fresh, `POST /api/ready` → 409.
- `GET /api/presence` (public): active lobby/game entries for badges.

### Grouping heartbeats into games and lobbies

- **Primary key: `lobbyId`** (from the battlelobby file, kept sticky
  through the game since SC2 deletes the file at game end). Groups game
  members exactly and hard-links a live game to the replay uploaded
  afterwards (same `m_randomValue`). It does **not** group lobbies: the
  file does not exist yet while a lobby is open (see above).
- **Lobbies: one at a time.** With no id to key on, lobby reporters would
  fall back to matching their exact roster set — but rosters differ by a
  few seconds of joins and leaves, so one lobby appeared as several. An
  id-less lobby reporter now joins the single visible lobby, or they form
  one group together; only when several identified lobbies are live does
  each stand alone (uar-shared `groupPresence`).
- **Fallback: the roster name-set.** Every member of the same game
  reports the identical sorted `/game` roster, so in-game entries with a
  null lobbyId group by `(uar, hash(roster))`; `displayTime` similarity
  is a sanity check.
- The server should log lobbyId-vs-replay mismatches (both are known
  server-side once the replay uploads) — free telemetry on extractor
  accuracy across SC2 patches.

## Open follow-ups

1. Full battlelobby decoder for the leftovers (toon handles, clan tags,
   slots/teams, host) — original reverse-engineering, see above.
2. Capture a menus `/ui` payload as a fixture (only lobby + ingame are
   frozen in tests so far).
3. Verify the macOS battlelobby path on a real Mac.
4. Privacy flag: unproven either way in the file (the public/private pair
   we captured differed in size, so the diff was inconclusive); a solo
   public vs solo private pair would settle it.
