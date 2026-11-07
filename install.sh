#!/bin/bash
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
sidebars="$HOME/.config/cmux/sidebars"
settings="$HOME/.claude/settings.json"
hook="$repo/hooks/boss-hook.mjs"
board="✻ Boss"

require() {
  command -v "$1" >/dev/null || { echo "bossview needs '$1' on your PATH: $2" >&2; exit 1; }
}

check_requirements() {
  require cmux "install cmux and run this from a cmux terminal"
  require claude "install Claude Code and log in"
  require node "install Node 18 or newer"
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' \
    || { echo "bossview needs Node 18 or newer" >&2; exit 1; }
}

link_sidebar() {
  mkdir -p "$sidebars"
  ln -sfn "$repo/sidebar/bossview.js" "$sidebars/bossview.js"
  cmux sidebar validate bossview
  echo "Linked $sidebars/bossview.js -> $repo/sidebar/bossview.js"
}

install_hook() {
  mkdir -p "$(dirname "$settings")"
  [[ -f "$settings" ]] && cp "$settings" "$settings.bak-$(date +%Y%m%d-%H%M%S)"
  node - "$settings" "$hook" <<'EOF'
const fs = require("fs");
const [settingsPath, hook] = process.argv.slice(2);
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
settings.hooks ??= {};
for (const event of ["Stop", "Notification", "UserPromptSubmit", "SessionEnd"]) {
  const groups = (settings.hooks[event] ??= []);
  const installed = groups.some((g) => (g.hooks ?? []).some((h) => h.command === hook));
  if (!installed) groups.push({ hooks: [{ type: "command", command: hook }] });
}
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
EOF
  echo "Installed $hook for Stop, Notification, UserPromptSubmit, SessionEnd"
}

board_exists() {
  cmux workspace list --json | node -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const found = (list.workspaces ?? list).some((w) => w.custom_title === process.argv[1]);
    process.exit(found ? 0 : 1);
  ' "$board"
}

# The terminal has to outlive `sidebar open`: cmux closes a workspace once its last terminal exits.
open_board() {
  if board_exists; then
    echo "Board workspace '$board' already exists"
    return
  fi
  local ref
  ref=$(cmux workspace create --name "$board" --description "What Claude needs from you" --cwd "$HOME" \
    --command 'cmux sidebar open bossview; exec "$SHELL" -l' | grep -o 'workspace:[0-9]*' | head -1)
  cmux workspace-action --workspace "$ref" --action set-color --color "#D97757" >/dev/null
  cmux workspace-action --workspace "$ref" --action pin >/dev/null
  cmux workspace-action --workspace "$ref" --action move-top >/dev/null
  echo "Created pinned board workspace '$board'"
}

check_requirements
link_sidebar
install_hook
open_board
echo "Restart running Claude sessions so they pick up the hook."
