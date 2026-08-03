---
title: 'Fixed: games dropped when the site was busy'
type: fix
area: uploads
impact: major
---
When the site was too busy to read an upload, it answered "Not a readable
StarCraft II replay" — the same thing it says about a genuinely broken file.
This app took that at its word: it marked the game as rejected and never
offered it again. Nothing looked wrong, the game simply never appeared on your
profile.

It hit hardest on a first run, when hundreds of past replays are uploaded one
after another — exactly when the site was most likely to fall behind.

The site no longer gives that answer (it says it is busy, and this app now waits
and retries), and on your next launch every game dropped this way is queued
again automatically. You will see them upload in the activity list. Nothing on
disk was lost — only the record saying not to bother with them.
