---
title: Wayland popups come from your desktop
type: fix
area: window
---
Rather than forcing the app through XWayland — which broke hardware
acceleration on some drivers — Wayland sessions now get a normal desktop
notification, which KDE and GNOME already anchor near the tray.
