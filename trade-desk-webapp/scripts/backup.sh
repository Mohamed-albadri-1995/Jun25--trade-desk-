#!/usr/bin/env bash
# Daily data backup — called by server.js at 16:30 ET on weekdays.
# Commits JSON files written by server.js into the trade-desk-data repo and pushes.
# Set DATA_BACKUP_DIR env var to the path of the trade-desk-data clone.
set -e

DATA_REPO="${DATA_BACKUP_DIR:-/home/ec2-user/trade-desk-data}"
DATE=$(date +%Y-%m-%d)

if [ ! -d "$DATA_REPO/.git" ]; then
  echo "[backup] DATA_REPO not a git repo: $DATA_REPO"
  exit 1
fi

cd "$DATA_REPO"

git add .

if git diff --cached --quiet; then
  echo "[backup] nothing new for $DATE"
  exit 0
fi

git commit -m "data backup $DATE"
git push origin HEAD
echo "[backup] pushed to trade-desk-data for $DATE"
