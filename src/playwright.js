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
 * Parse browsers selection for Playwright projects.
 *
 * Supported:
 *  - "chromium" | "firefox" | "webkit"
 *  - "all" (default)
 *  - "chromium,firefox" / "chromium firefox" etc.
 */
function parseBrowsersEnv(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return ["chromium"];
  if (raw === "all") return ["chromium", "firefox", "webkit"];

  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set(["chromium", "firefox", "webkit"]);
  const selected = parts.filter((p) => allowed.has(p));

  // If user provided invalid values, fallback to all
  return selected.length ? selected : ["chromium", "firefox", "webkit"];
}

/**
 * Force stable config for sharding + blob merge.
 * - Does NOT fail worker on test failures (non-zero exit).
 * - Produces blob report regardless of failures.
 *
 * Returns: { blob: string, junit: string, exitCode: number }
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
  fs.mkdirSync(artifactsDir, { recursive: true });

  const junitFile = path.join(reportDir, `results-shard-${shardId}.xml`);
  const testDir = path.join(repoDir, "tests");

  // ✅ Prefer the repo's own Playwright config, but override ONLY what the runner needs:
  // - ensure shard-stable JUnit output per shard (so shards don't overwrite each other)
  // - ensure blob reporter output (required for merge-reports)
  // - force workers=1 inside each Cloud Run task
  // - force use.outputDir into reportDir/artifacts to keep traces/videos with the shard payload
  const cfgCandidates = ["playwright.config.ts"];

  const baseCfgFile = cfgCandidates.find((f) =>
    fs.existsSync(path.join(repoDir, f)),
  );
  let cfgPath = "";

  if (baseCfgFile) {
    const wrapperExt = /\.(ts|mts|cts)$/i.test(baseCfgFile) ? "ts" : "mjs";
    cfgPath = path.join(repoDir, `.pw.runner.config.${wrapperExt}`);

    // Create a thin wrapper config that imports the team's config and overrides only runner-required bits.
    fs.writeFileSync(
      cfgPath,
      `
import baseConfig from "./${baseCfgFile}";
import { defineConfig } from "@playwright/test";

const reportDir = process.env.PW_REPORT_DIR || ".";
const shardId = process.env.PW_SHARD_ID || "0";

const junitFile = \`\${reportDir}/results-shard-\${shardId}.xml\`;
const blobDir = \`\${reportDir}/blob-report\`;
const artifactsDir = \`\${reportDir}/artifacts\`;

function normalizeReporter(r) {
  if (!r) return [];
  if (typeof r === "string") return [[r]];
  if (Array.isArray(r)) return r;
  return [];
}

const base = baseConfig?.default ?? baseConfig;
const baseReporter = normalizeReporter(base?.reporter);

let nextReporter = baseReporter.map((entry) => {
  // entry can be: ["junit", { outputFile: "..." }] or ["list"] etc.
  if (!Array.isArray(entry) || entry.length === 0) return entry;

  const name = entry[0];
  const opts = entry[1] ?? {};

  if (name === "junit") {
    return ["junit", { ...opts, outputFile: junitFile }];
  }
  return entry;
});

const hasJunit = nextReporter.some((e) => Array.isArray(e) && e[0] === "junit");
const hasBlob = nextReporter.some((e) => Array.isArray(e) && e[0] === "blob");

// Ensure JUnit exists even if the base config didn't include it
if (!hasJunit) nextReporter.push(["junit", { outputFile: junitFile }]);
// Ensure blob exists for merge-reports
if (!hasBlob) nextReporter.push(["blob", { outputDir: blobDir }]);

export default defineConfig({
  ...base,
  // Runner requirement: keep each shard stable in Cloud Run
  workers: 1,
  // Preserve team's config, override only what we need
  reporter: nextReporter,
  use: {
    ...(base?.use ?? {}),
    // Runner requirement: collect artifacts into the shard report directory
    outputDir: artifactsDir,
  },
});
`.trim() + "\n",
      "utf-8",
    );
  } else {
    // Fallback: no config found in repo. Use a minimal stable config.
    cfgPath = path.join(reportDir, "pw.forced.config.cjs");
    fs.writeFileSync(
      cfgPath,
      `
/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: ${JSON.stringify(testDir)},
  fullyParallel: true,
  workers: 1,
  retries: 1,
  
  use: {
  /* Maximum time each action can take */
    actionTimeout: 5000,
    
    /* Maximum time to wait for element */
    navigationTimeout: 15000,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    outputDir: ${JSON.stringify(artifactsDir)},
  },
  reporter: [
    ['line'],
    ['junit', { outputFile: ${JSON.stringify(junitFile)} }],
    ['blob', { outputDir: ${JSON.stringify(blobDir)} }],
  ],
};
`.trim() + "\n",
      "utf-8",
    );
  }

  // ✅ Browser parametrization via Playwright projects:
  // PW_BROWSERS examples:
  //   chromium
  //   firefox
  //   webkit
  //   all
  //   chromium,firefox
  const browsers = parseBrowsersEnv(
    process.env.PW_BROWSERS || process.env.BROWSERS,
  );

  elog(
    `▶️ Running shard ${shardId}: ${shardIndex1Based}/${shardCount} | browsers=${browsers.join(",")}`,
  );

  const args = [
    "playwright",
    "test",
    `--config=${cfgPath}`,
    `--shard=${shardIndex1Based}/${shardCount}`,
    ...browsers.map((b) => `--project=${b}`),
  ];

  // Use npx so it picks the installed Playwright in the cloned repo
  const result = spawnSync("npx", args, {
    cwd: repoDir,
    env: {
      ...process.env,
      CI: "1",
      PW_TEST_NO_COLOR: "1",
      PW_REPORT_DIR: reportDir,
      PW_SHARD_ID: String(shardId),
    },
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
