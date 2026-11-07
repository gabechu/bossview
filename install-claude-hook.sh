#!/bin/bash
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
settings="$HOME/.claude/settings.json"
hook="$repo/hooks/boss-hook.mjs"

cp "$settings" "$settings.bak-$(date +%Y%m%d-%H%M%S)"
node - "$settings" "$hook" <<'EOF'
const fs = require("fs");
const [settingsPath, hook] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
settings.hooks ??= {};
for (const event of ["Stop", "Notification", "UserPromptSubmit", "SessionEnd"]) {
  const groups = (settings.hooks[event] ??= []);
  const installed = groups.some((g) => (g.hooks ?? []).some((h) => h.command === hook));
  if (!installed) groups.push({ hooks: [{ type: "command", command: hook }] });
}
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
EOF

echo "Installed $hook for Stop, Notification, UserPromptSubmit, SessionEnd"
echo "Restart Claude sessions to pick it up."
