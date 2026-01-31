// src/playwright.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function runTests(
  outDir,
  shardIndex1Based,
  shardCount,
  shardId,
  repoDir,
) {
  fs.mkdirSync(outDir, { recursive: true });

  const blobDir = path.join(outDir, "blob-report");
  fs.mkdirSync(blobDir, { recursive: true });

  const blobName = `shard-${shardId}-of-${shardCount}.zip`;

  const cfgPath = path.join(outDir, "pw.blob.config.cjs");
  fs.writeFileSync(
    cfgPath,
    `
      /** @type {import('@playwright/test').PlaywrightTestConfig} */
      module.exports = {
        // ✅ Force a consistent testDir for ALL shards
        testDir: ${JSON.stringify(path.join(repoDir, "tests"))},
        reporter: [['blob', { outputDir: ${JSON.stringify(blobDir)} }]],
      };
    `,
    "utf-8",
  );

  console.log(`▶️ Running shard ${shardId}: ${shardIndex1Based}/${shardCount}`);
  console.log(`   repoDir=${repoDir}`);
  console.log(`   testDir=${path.join(repoDir, "tests")}`);
  console.log(`   blobDir=${blobDir}`);

  execSync(
    `npx playwright test --config=${cfgPath} --shard=${shardIndex1Based}/${shardCount} --workers=1`,
    { stdio: "inherit", cwd: repoDir }, // ✅ run from repoDir
  );

  const files = fs.readdirSync(blobDir).filter((f) => f.endsWith(".zip"));
  if (files.length === 0) {
    throw new Error(`Blob report not found. No .zip files in ${blobDir}`);
  }

  const produced = path.join(blobDir, files[0]);
  const dest = path.join(outDir, blobName);
  fs.copyFileSync(produced, dest);

  console.log(`✅ Shard ${shardId} produced blob: ${dest}`);
  return dest;
}
