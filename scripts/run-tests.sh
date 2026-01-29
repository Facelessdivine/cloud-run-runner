#!/usr/bin/env bash
set -euo pipefail

########################################
# ENV INPUTS
########################################

REPO_URL="${REPO_URL:?Missing REPO_URL}"
REPO_REF="${REPO_REF:-main}"
TEST_DIR="${TEST_DIR:-.}"
BUCKET="${BUCKET:?Missing BUCKET}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

IDX=$(( ${CLOUD_RUN_TASK_INDEX:-0} + 1 ))
CNT=${CLOUD_RUN_TASK_COUNT:-1}

echo "===================================================="
echo "🚀 Playwright shard ${IDX}/${CNT}"
echo "RUN_ID=${RUN_ID}"
echo "REPO=${REPO_URL}@${REPO_REF}"
echo "BUCKET=${BUCKET}"
echo "===================================================="

########################################
# 1️⃣ Clone repo dynamically
########################################

git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" /workspace
cd /workspace/$TEST_DIR

########################################
# 2️⃣ Install deps
########################################

npm ci

########################################
# 3️⃣ Run shard
########################################

echo "🧪 Running tests..."
npx playwright test --shard="${IDX}/${CNT}" --workers=1 --reporter=blob

########################################
# 4️⃣ Upload blob report
########################################

node /app/scripts/upload-blobs.js

########################################
# 5️⃣ Coordinator merges
########################################

if [[ "$IDX" -eq 1 ]]; then
  node /app/scripts/merge-and-publish.js
else
  echo "Shard ${IDX}/${CNT} finished."
fi