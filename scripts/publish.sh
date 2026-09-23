#!/usr/bin/env bash
# Same as publish.cmd for macOS/Linux: mirror the working branch onto the history-free "public" branch and push it.
# The local "public" branch is always rebuilt from the remote first, so a push made from elsewhere never diverges it.
set -euo pipefail
WORK=${1:-claude/new-session-vm4l3e}
CUR=$(git rev-parse --abbrev-ref HEAD)
git fetch public main
git checkout -B public refs/remotes/public/main
git read-tree -u --reset "$WORK"
git add -A
git commit -m "sync from $WORK ($(date '+%Y-%m-%d %H:%M'))" || echo "(no changes)"
git push public public:main
git checkout "$CUR"
