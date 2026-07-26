#!/usr/bin/env bash
# Generates the count-badged tray icons (resources/badges/badge-{1..9,9plus}.{png,ico})
# from build/icon.png. Needs ImageMagick; output is committed, so this only
# runs when the badge design changes.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources/badges

FONT="DejaVu-Sans-Bold"
GOLD="#e8b34b"
INK="#181510"

for n in 1 2 3 4 5 6 7 8 9 9plus; do
	label=${n/9plus/9+}
	size=52
	[ "$n" = "9plus" ] && size=40
	magick build/icon.png -resize 128x128 \
		-fill "$GOLD" -stroke '#14171c' -strokewidth 4 -draw 'circle 90,90 90,53' \
		-font "$FONT" -pointsize "$size" -fill "$INK" -stroke none \
		-gravity center -annotate +26+28 "$label" \
		"resources/badges/badge-$n.png"
	magick "resources/badges/badge-$n.png" -define icon:auto-resize=48,32,24,16 \
		"resources/badges/badge-$n.ico"
done
echo "badges written to resources/badges/"
