#!/usr/bin/env bash
# Daily data backup — called by server.js at 16:30 ET on weekdays.
# Commits any new files in trade-desk-webapp/backups/ and pushes to origin.
set -e

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
DATE=$(date +%Y-%m-%d)

cd "$REPO"

git add trade-desk-webapp/backups/

if git diff --cached --quiet; then
  echo "[backup] nothing new to commit for $DATE"
  exit 0
fi

git commit -m "data backup $DATE"
git push origin HEAD
echo "[backup] pushed backup for $DATE"
