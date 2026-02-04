import { spawnSync } from "node:child_process";
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
 * Force stable config for sharding + blob merge.
 * - Does NOT fail worker on test failures (non-zero exit).
 * - Retries failed tests 2 times.
 * - Produces blob report regardless of failures.
 *
 * Returns: { blob: string, exitCode: number }
 *   blob is a zip path OR blobDir.
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

  const junitFile = path.join(reportDir, `results-shard-${shardId}.xml`);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const testDir = path.join(repoDir, "tests");

  const cfgPath = path.join(reportDir, "pw.forced.config.cjs");
  fs.writeFileSync(
    cfgPath,
    `
/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: ${JSON.stringify(testDir)},

  fullyParallel: true,
  workers: 1,

  retries: 2,

  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    outputDir: ${JSON.stringify(artifactsDir)},
  },

  // ✅ required for merge
  reporter: [
    ['line'],
    ['junit', { outputFile: ${JSON.stringify(junitFile)} }],
    ['blob', { outputDir: ${JSON.stringify(blobDir)} }],
  ],
};
`.trim() + "\n",
    "utf-8",
  );

  elog(`▶️ Running shard ${shardId}: ${shardIndex1Based}/${shardCount}`);

  const args = [
    "playwright",
    "test",
    `--config=${cfgPath}`,
    `--shard=${shardIndex1Based}/${shardCount}`,
  ];

  // Use npx so it picks the installed Playwright in the cloned repo
  const result = spawnSync("npx", args, {
    cwd: repoDir,
    env: { ...process.env, CI: "1", PW_TEST_NO_COLOR: "1" },
    stdio: "inherit",
  });

  // spawnSync returns null code if terminated by signal
  const exitCode = typeof result.status === "number" ? result.status : 1;

  if (result.error) {
    // This is a REAL infra error (can't spawn process)
    elog("❌ Failed to start Playwright process:", result.error);
    throw result.error;
  }

  if (result.signal) {
    // Also infra-level (killed)
    throw new Error(`Playwright terminated by signal: ${result.signal}`);
  }

  // ✅ IMPORTANT: non-zero exitCode can be just test failures.
  // We DO NOT throw here. We still generate/upload blob and let merge happen.
  if (exitCode !== 0) {
    elog(
      `⚠️ Playwright shard exitCode=${exitCode} (likely test failures). Continuing to upload blob...`,
    );
  } else {
    elog(`✅ Playwright shard exitCode=0`);
  }

  const detailed = listDirDetailed(blobDir);

  if (detailed.length === 0) {
    const reportDirEntries = listDirDetailed(reportDir);
    elog(
      `🧩 reportDir entries (${reportDirEntries.length}):`,
      reportDirEntries,
    );
    throw new Error(`Blob report directory is empty: ${blobDir}`);
  }

  const zipEntry = detailed.find((e) => e.isFile && e.name.endsWith(".zip"));
  const blob = zipEntry ? path.join(blobDir, zipEntry.name) : blobDir;

  if (zipEntry) elog(`✅ Blob zip: ${blob}`);
  else elog(`✅ Blob dir: ${blob}`);

  return { blob, junit: junitFile, exitCode };
}
