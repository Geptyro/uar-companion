---
title: Finds the lobby file wherever Windows puts it
type: fix
area: presence
impact: minor
---
Windows redirects the temp directory often enough — group policy, a second
drive, a RAM disk — that missing it cost players the lobby id the site groups
games by. Every candidate location is tried now.
