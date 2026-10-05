#!/usr/bin/env bash
# Stamp a built site with the commit it was built from: fills the
# <!-- @BUILD@ --> marker in index.html with a link to that commit on GitHub.
# Usage: stamp-site.sh <site-dir> <commit-sha> <owner/repo>
set -euo pipefail

dir="${1:?site dir}"
sha="${2:?commit sha}"
repo="${3:?owner/repo}"
short="${sha:0:7}"
index="$dir/index.html"

link="<p class=\"build\">Build <a href=\"https://github.com/$repo/commit/$sha\"><code>$short</code></a></p>"
grep -q '<!-- @BUILD@ -->' "$index" || { echo "no build marker in $index" >&2; exit 1; }
sed "s|<!-- @BUILD@ -->|$link|" "$index" > "$index.tmp"
mv "$index.tmp" "$index"
