#!/bin/bash
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
sidebars="$HOME/.config/cmux/sidebars"

mkdir -p "$sidebars"
ln -sfn "$repo/sidebar/bossview.js" "$sidebars/bossview.js"
cmux sidebar validate bossview
echo "Linked $sidebars/bossview.js -> $repo/sidebar/bossview.js"
