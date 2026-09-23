#!/usr/bin/env bash
# Same as publish.cmd for macOS/Linux: mirror the working branch onto the history-free "public" branch and push it.
set -euo pipefail
WORK=${1:-claude/new-session-vm4l3e}
CUR=$(git rev-parse --abbrev-ref HEAD)
git checkout public
git read-tree -u --reset "$WORK"
git add -A
git commit -m "sync from $WORK ($(date '+%Y-%m-%d %H:%M'))" || echo "(no changes)"
git push public public:main
git checkout "$CUR"
