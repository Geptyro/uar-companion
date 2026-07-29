---
title: It stays out of your game
type: performance
area: window
impact: major
---
A player reported the companion making League of Legends stutter, and the
measurements said it was not the processor — the app idles at well under one
percent of a core. It was everything else:

- Notifications came as a transparent, always-on-top window drawn over
  whatever was running. On Windows that pulls a game out of fullscreen, which
  you feel as a freeze. They are your desktop's own notifications now, which
  your system already knows to hold back while you are playing.
- Hardware acceleration is off. The interface is a list; it does not need a
  graphics device, and not holding one leaves it to the game.
- Closing the window really closes it, freeing the couple of hundred megabytes
  it used to keep resident to show nobody anything. It reopens from the tray
  in a moment.
