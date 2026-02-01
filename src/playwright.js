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

/**
 * Force a stable Playwright config for sharding + blob merge.
 * We do NOT load the repo config to avoid reporter override / TS/ESM issues.
 *
 * Returns: blob zip path OR blobDir (directory).
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

  // IMPORTANT: stable testDir across shards for merge stability
  const testDir = path.join(repoDir, "tests");

  // Force config file
  const cfgPath = path.join(reportDir, "pw.forced.config.cjs");
  fs.writeFileSync(
    cfgPath,
    `
/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: ${JSON.stringify(testDir)},

  // shard at test-case level even if all tests are in one spec
  fullyParallel: true,

  // one worker per shard process
  workers: 1,

  // artifacts on failure (your requirement)
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    outputDir: ${JSON.stringify(artifactsDir)},
  },

  // REQUIRED for merge
  reporter: [
    ['line'],
    ['blob', { outputDir: ${JSON.stringify(blobDir)} }],
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

  // Force config usage explicitly
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

  if (detailed.length === 0) {
    // Extra debugging to see where Playwright wrote output
    const reportDirEntries = listDirDetailed(reportDir);
    elog(
      `🧩 reportDir entries (${reportDirEntries.length}):`,
      reportDirEntries,
    );
    throw new Error(`Blob report directory is empty: ${blobDir}`);
  }

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
