---
title: Launch entries work without FUSE
type: fix
area: packaging
---
Systems with no FUSE can only run an AppImage in extract-and-run mode. The
menu and autostart entries the app writes now carry that flag through, instead
of pointing at a launch that could not work.
