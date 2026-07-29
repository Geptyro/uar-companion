---
title: A replay cannot unpack to more than it should
type: fix
area: uploads
---
The reader that identifies a UAR replay now caps how much it will decompress,
matching the limit the server enforces.
