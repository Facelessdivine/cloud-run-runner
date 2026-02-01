// src/playwright.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function elog(...args) {
  console.error(...args);
}

function listDirDetailed(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    return {
      name,
      bytes: st.size,
      isDir: st.isDirectory(),
      isFile: st.isFile(),
    };
  });
}

function findRepoConfig(repoDir) {
  const candidates = [
    "playwright.config.ts",
    "playwright.config.mts",
    "playwright.config.js",
    "playwright.config.mjs",
    "playwright.config.cjs",
  ].map((f) => path.join(repoDir, f));

  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * Runs tests for a shard producing a blob report that can be merged later.
 * Also enforces artifact capture on failures (trace/video/screenshot).
 *
 * Returns: blob zip path OR blobDir (directory)
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

  const artifactsDir = path.join(reportDir, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  // Keep this stable across shards (important for merge)
  const testDir = path.join(repoDir, "tests");

  const repoConfigPath = findRepoConfig(repoDir);

  const cfgPath = path.join(reportDir, "pw.overlay.config.cjs");
  fs.writeFileSync(
    cfgPath,
    `
const fs = require('fs');
const path = require('path');

const repoDir = ${JSON.stringify(repoDir)};
const testDir = ${JSON.stringify(testDir)};
const blobDir = ${JSON.stringify(blobDir)};
const artifactsDir = ${JSON.stringify(artifactsDir)};
const repoConfigPath = ${JSON.stringify(repoConfigPath || "")};

// Try to load repo config if present, else use empty base.
let base = {};
if (repoConfigPath && fs.existsSync(repoConfigPath)) {
  // require() supports .js/.cjs; for .ts/.mjs this may fail.
  // If it fails, we fall back to empty base and rely on our forced config.
  try { base = require(repoConfigPath); } catch (e) { base = {}; }
}

module.exports = {
  ...base,

  // ✅ enforce consistent testDir for merge stability
  testDir,

  // ✅ shard at test-case level even if single file
  fullyParallel: true,

  // keep 1 worker per shard process
  workers: 1,

  // ✅ artifacts on failure (your request)
  use: {
    ...(base.use || {}),
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Keep outputs under our shard folder
    outputDir: artifactsDir,
  },

  // ✅ ensure blob reporter exists for merge
  reporter: [
    ['line'],
    ['blob', { outputDir: blobDir }],
  ],
};
`.trim() + "\n",
    "utf-8",
  );

  elog(`▶️ Running shard ${shardId}: ${shardIndex1Based}/${shardCount}`);
  elog(`repoDir=${repoDir}`);
  elog(`testDir=${testDir}`);
  elog(`reportDir=${reportDir}`);
  elog(`blobDir=${blobDir}`);
  elog(`artifactsDir=${artifactsDir}`);
  elog(`cfgPath=${cfgPath}`);
  if (repoConfigPath) elog(`repoConfigDetected=${repoConfigPath}`);
  else elog(`repoConfigDetected=NONE`);

  const cmd = `npx playwright test --config="${cfgPath}" --shard=${shardIndex1Based}/${shardCount}`;

  try {
    execSync(cmd, {
      stdio: "inherit",
      cwd: repoDir,
      env: { ...process.env, CI: "1", PW_TEST_NO_COLOR: "1" },
    });
  } catch (e) {
    elog("❌ Playwright command failed:", cmd);
    if (e?.stdout) elog("---- stdout ----\n" + e.stdout.toString());
    if (e?.stderr) elog("---- stderr ----\n" + e.stderr.toString());
    throw e;
  }

  elog("✅ Playwright finished; inspecting blob output...");
  const detailed = listDirDetailed(blobDir);
  elog(`📂 blobDir entries (${detailed.length}):`, detailed);

  if (detailed.length === 0)
    throw new Error(`Blob report directory is empty: ${blobDir}`);

  const zipEntry = detailed.find((e) => e.isFile && e.name.endsWith(".zip"));
  if (zipEntry) {
    const zipPath = path.join(blobDir, zipEntry.name);
    elog(`✅ Shard ${shardId} produced blob zip: ${zipPath}`);
    return zipPath;
  }

  elog(
    `✅ Shard ${shardId} produced blob files (no zip). Returning directory: ${blobDir}`,
  );
  return blobDir;
}
