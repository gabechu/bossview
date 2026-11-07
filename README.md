# bossview

A cmux board of your Claude Code sessions, sorted by what each one needs from you.

A Claude Code hook asks Haiku for a few words on what the session needs from you, plus a triage label. The board shows that on each card, newest first:

| Column | Means |
|---|---|
| **Needs you** | Blocked, waiting for approval, or asking you to decide |
| **Review** | Changed code or produced work you should check |
| **Working** | Still running |
| **Safe to close** | You got your answer, nothing pending |

Click a card to jump to its tab.

## Requirements

- macOS with cmux (Custom Sidebars beta enabled)
- Claude Code, logged in
- Node 18+

## Install

```sh
git clone https://github.com/gabechu/bossview.git ~/code/bossview
cd ~/code/bossview
./install.sh               # links the board into ~/.config/cmux/sidebars
./install-claude-hook.sh   # adds the hook to ~/.claude/settings.json (backs it up first)
```

Restart running Claude sessions so they pick up the hook.

## Use

In the workspace you want as your board:

```sh
cmux sidebar open bossview
```

Edits to `sidebar/bossview.js` hot-reload. Hook errors go to `~/.bossview/hook.log`.

If `claude` isn't at `/opt/homebrew/bin/claude`, set `BOSSVIEW_CLAUDE` to its path.

## Uninstall

```sh
rm ~/.config/cmux/sidebars/bossview.js
```

Then remove the `boss-hook.mjs` entries from `~/.claude/settings.json`.
