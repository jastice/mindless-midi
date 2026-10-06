#!/usr/bin/env bash
# Renders tools/social/card.html to src/app/social.png (1200x630) with headless
# Chrome. Set CHROME to use a different browser binary.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

"$chrome" --headless=new --disable-gpu --hide-scrollbars \
  --allow-file-access-from-files \
  --force-device-scale-factor=1 --window-size=1200,630 \
  --virtual-time-budget=3000 \
  --screenshot="$root/src/app/social.png" \
  "file://$root/tools/social/card.html"
