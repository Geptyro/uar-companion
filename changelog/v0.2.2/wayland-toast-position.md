---
title: Popups appear near the tray on Wayland
type: fix
area: window
impact: minor
---
A first attempt, superseded in v0.2.3: the app asked to run through XWayland
so it could place its own popups. That turned out to cost more than it bought
— see the next release.
