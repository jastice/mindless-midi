#!/usr/bin/env bash
# Renders the link-preview cards (1200x630) with headless Chrome:
#   tools/social/card.html     -> src/app/social.png
#   tools/social/claudia.html  -> src/claudia/social.png
# and DJ Claudia's touch icon, src/claudia/favicon.svg -> src/claudia/apple-touch-icon.png.
# Set CHROME to use a different browser binary.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

shot() { # <width> <height> <out> <file>
  "$chrome" --headless=new --disable-gpu --hide-scrollbars \
    --allow-file-access-from-files \
    --force-device-scale-factor=1 --window-size="$1,$2" \
    --virtual-time-budget=3000 \
    --default-background-color=00000000 \
    --screenshot="$root/$3" \
    "file://$root/$4"
}

shot 1200 630 src/app/social.png tools/social/card.html
shot 1200 630 src/claudia/social.png tools/social/claudia.html
shot 180 180 src/claudia/apple-touch-icon.png tools/social/touch-icon.html
