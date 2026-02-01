// src/playwright.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Runs Playwright tests for a shard and produces a blob report artifact that can be merged later.
 *
 * Returns:
 * - a .zip file path if Playwright produced a zip
 * - otherwise returns the blobDir (directory) where blob files exist
 */
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

  const testDir = path.join(repoDir, "tests");
  const cfgPath = path.join(reportDir, "pw.blob.config.cjs");

  fs.writeFileSync(
    cfgPath,
    `
/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: ${JSON.stringify(testDir)},

  // ✅ shard tests even if they're all in one file
  fullyParallel: true,

  // shard at process-level; keep internal workers minimal
  workers: 1,

  reporter: [
    ['line'],
    ['blob', { outputDir: ${JSON.stringify(blobDir)} }],
  ],
};
`.trim() + "\n",
    "utf-8",
  );

  console.log(`▶️ Running shard ${shardId}: ${shardIndex1Based}/${shardCount}`);
  console.log(`   repoDir=${repoDir}`);
  console.log(`   testDir=${testDir}`);
  console.log(`   reportDir=${reportDir}`);
  console.log(`   blobDir=${blobDir}`);
  console.log(`   cfgPath=${cfgPath}`);

  const cmd = `npx playwright test --config="${cfgPath}" --shard=${shardIndex1Based}/${shardCount}`;

  try {
    execSync(cmd, {
      stdio: "inherit",
      cwd: repoDir,
      env: { ...process.env, CI: "1" },
    });
  } catch (e) {
    console.error("❌ Playwright command failed:", cmd);
    if (e?.stdout) console.error("---- stdout ----\n" + e.stdout.toString());
    if (e?.stderr) console.error("---- stderr ----\n" + e.stderr.toString());
    throw e;
  }

  const blobFiles = fs.existsSync(blobDir) ? fs.readdirSync(blobDir) : [];
  if (blobFiles.length === 0) {
    throw new Error(`Blob report directory is empty: ${blobDir}`);
  }

  // Prefer zip if present (easiest to upload + merge).
  const zips = blobFiles.filter((f) => f.endsWith(".zip"));
  if (zips.length > 0) {
    const zipPath = path.join(blobDir, zips[0]);
    console.log(`✅ Shard ${shardId} produced blob zip: ${zipPath}`);
    return zipPath;
  }

  console.log(`✅ Shard ${shardId} produced blob files: ${blobFiles.length}`);
  return blobDir; // directory case
}
