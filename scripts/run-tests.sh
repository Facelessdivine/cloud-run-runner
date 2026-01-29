#!/usr/bin/env bash
set -euo pipefail

IDX=$(( ${CLOUD_RUN_TASK_INDEX:-0} + 1 ))
CNT=${TOTAL_SHARDS:-1}
RUN_ID="${RUN_ID:?}"
BUCKET="${BUCKET:?}"

echo "🧪 Running shard $IDX/$CNT"

npx playwright test \
  --shard="$IDX/$CNT" \
  --workers=1 \
  --reporter=blob

echo "📤 Uploading shard blob..."
node /runner/scripts/gcs.js upload ./blob-report "runs/$RUN_ID/blob/shard-$IDX"

#############################################
# Coordinator shard (1) merges
#############################################

if [[ "$IDX" -eq 1 ]]; then
  echo "👑 Coordinator waiting for $CNT shards..."

  node /runner/scripts/gcs.js wait "runs/$RUN_ID/blob/" "$CNT"

  echo "📥 Downloading blobs..."
  node /runner/scripts/gcs.js download "runs/$RUN_ID/blob/" ./blob

  mkdir -p ./all-blob
  find ./blob -name '*.zip' -exec cp {} ./all-blob/ \;

  echo "🖥️ Merging reports..."
  npx playwright merge-reports --reporter html ./all-blob
  npx playwright merge-reports --reporter junit ./all-blob > ./results.xml

  echo "📤 Uploading final reports..."
  node /runner/scripts/gcs.js upload ./playwright-report "runs/$RUN_ID/final/html"
  node /runner/scripts/gcs.js upload ./results.xml "runs/$RUN_ID/final/junit.xml"

  echo "🧹 Cleaning up blobs..."
  node /runner/scripts/gcs.js delete-prefix "runs/$RUN_ID/blob/"
  echo "HTML report: https://storage.googleapis.com/$BUCKET/runs/$RUN_ID/final/html/index.html"
  echo "JUnit report: https://storage.googleapis.com/$BUCKET/runs/$RUN_ID/final/junit.xml"
fi