---
title: Players are named by their SC2 profile, not their battletag
type: fix
area: presence
---
The ready roster, the tray tooltip and the notifications all read out Battle.net
battletags, which is rarely the name anyone knows you by. They now use the
StarCraft II profile name — the one you read in the lobby — and fall back to the
battletag only when the site has no profile linked.

The lobby roster this app reports also carried the character code SC2 appends to
a profile name (`Name#451`). Nothing else spells it that way, so the website
could not tell that a roster line and the player reporting it were the same
person, and listed them twice.
