#!/usr/bin/env bash
set -euo pipefail

: "${REPO_URL:?REPO_URL required}"
REPO_REF="${REPO_REF:-main}"
RUN_ID="${RUN_ID:-run-$(date +%s)}"
BUCKET="${BUCKET:?BUCKET required}"

echo "🚀 Playwright Cloud Run Runner"
echo "Repo: $REPO_URL"
echo "Ref: $REPO_REF"
echo "Run ID: $RUN_ID"
echo "Bucket: $BUCKET"

WORKDIR="/work"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

echo "📥 Cloning repo..."
git clone --depth=1 --branch "$REPO_REF" "$REPO_URL" repo
cd repo

echo "📦 Installing dependencies..."
npm ci

echo "🧠 Discovering shards..."
export TOTAL_SHARDS=$(node /runner/scripts/shard-discovery.js)

echo "➡️ Total shards: $TOTAL_SHARDS"

echo "🧪 Running shard ${CLOUD_RUN_TASK_INDEX:-0}/${TOTAL_SHARDS}"
/runner/scripts/run-tests.sh