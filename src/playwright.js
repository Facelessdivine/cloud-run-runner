// src/playwright.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function runTests(
  reportDir,
  shardIndex1Based,
  shardCount,
  shardId,
  repoDir,
) {
  fs.mkdirSync(reportDir, { recursive: true });

  const blobDir = path.join(reportDir, "blob-report");
  fs.mkdirSync(blobDir, { recursive: true });

  const cfgPath = path.join(reportDir, "pw.blob.config.cjs");

  fs.writeFileSync(
    cfgPath,
    `
      /** @type {import('@playwright/test').PlaywrightTestConfig} */
      module.exports = {
        testDir: ${JSON.stringify(path.join(repoDir, "tests"))},
        fullyParallel: true,
        workers: 1,
        reporter: [
          ['line'],
          ['blob', { outputDir: ${JSON.stringify(blobDir)} }],
        ],
      };
    `,
    "utf-8",
  );

  console.log(`▶️ Running shard ${shardId}: ${shardIndex1Based}/${shardCount}`);
  console.log(`   repoDir=${repoDir}`);
  console.log(`   testDir=${path.join(repoDir, "tests")}`);
  console.log(`   blobDir=${blobDir}`);

  execSync(
    `npx playwright test --config=${cfgPath} --shard=${shardIndex1Based}/${shardCount}`,
    { stdio: "inherit", cwd: repoDir },
  );

  // ✅ Blob reporter might not produce a .zip; it always produces files in blobDir.
  const blobFiles = fs.existsSync(blobDir) ? fs.readdirSync(blobDir) : [];
  if (blobFiles.length === 0) {
    throw new Error(`Blob report directory is empty: ${blobDir}`);
  }

  console.log(`✅ Shard ${shardId} produced blob files: ${blobFiles.length}`);
  return blobDir; // return directory path
}
