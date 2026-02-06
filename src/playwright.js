import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function normalizeSlashes(p) {
  return String(p).replace(/\\/g, "/");
}

function parseListLocations(output, expectedProject) {
  // Example line:
  //   [chromium] › regression\\foo.spec.ts:11:9 › Suite › test title
  // Or:
  //   regression/foo.spec.ts:11:9 › Suite › test title
  const lines = String(output || "").split(/\r?\n/);
  const locs = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Prefer the bracketed project prefix when present.
    // Capture location token right after the first "›".
    const m = line.match(/^\[([^\]]+)\]\s+›\s+([^›]+?)\s+›/);
    if (m) {
      const project = m[1].trim().toLowerCase();
      if (expectedProject && project !== expectedProject.toLowerCase())
        continue;
      locs.push(m[2].trim());
      continue;
    }

    // Fallback: some configs might not print [project]
    const m2 = line.match(/^([^›]+?)\s+›/);
    if (m2) locs.push(m2[1].trim());
  }
  return locs;
}

function resolveSelector(repoDir, location) {
  // location is like: regression/foo.spec.ts:11:9
  // Playwright CLI expects a path relative to repo root.
  // If the location is relative to testDir (commonly "tests"), prefix it.
  const loc = normalizeSlashes(location);
  const filePart = loc.split(":")[0];
  const suffix = loc.slice(filePart.length); // includes :line:col

  const cand1 = path.join(repoDir, filePart);
  const cand2 = path.join(repoDir, "tests", filePart);

  if (fs.existsSync(cand1)) return normalizeSlashes(filePart + suffix);
  if (fs.existsSync(cand2))
    return normalizeSlashes(path.join("tests", filePart) + suffix);

  // Best effort
  return normalizeSlashes(filePart + suffix);
}

function roundRobinAssign(items, shardIndex0, shardCount) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (i % shardCount === shardIndex0) out.push(items[i]);
  }
  return out;
}

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

  // Optional filter: folder OR single spec file
  const testRootRaw = (
    process.env.TEST_FILE ||
    process.env.TEST_PATH ||
    ""
  ).trim();
  const testRoot = testRootRaw ? normalizeSlashes(testRootRaw) : "";

  // Optional: enable native sharding via Playwright's --shard (no per-test selectors)
  const useNativeSharding =
    String(process.env.PW_NATIVE_SHARDING || "").trim() === "1";

  // ✅ Always runs in Cloud: force headless + stable flags via wrapper config
  const cfgCandidates = ["playwright.config.ts"];
  const baseCfgFile = cfgCandidates.find((f) =>
    fs.existsSync(path.join(repoDir, f)),
  );
  let cfgPath = "";

  if (baseCfgFile) {
    const wrapperExt = /\.(ts|mts|cts)$/i.test(baseCfgFile) ? "ts" : "mjs";
    cfgPath = path.join(repoDir, `.pw.runner.config.${wrapperExt}`);

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
  if (!Array.isArray(entry) || entry.length === 0) return entry;
  const name = entry[0];
  const opts = entry[1] ?? {};
  if (name === "junit") {
    return ["junit", { ...opts, outputFile: junitFile }];
  }
  return entry;
});

const hasJunit = nextReporter.some((e) => Array.isArray(e) && e[0] === "junit");
const hasBlob  = nextReporter.some((e) => Array.isArray(e) && e[0] === "blob");

// Ensure JUnit exists even if the base config didn't include it
if (!hasJunit) nextReporter.push(["junit", { outputFile: junitFile }]);
// Ensure blob exists for merge-reports
if (!hasBlob) nextReporter.push(["blob", { outputDir: blobDir }]);

export default defineConfig({
  ...base,

  // ✅ Runner requirement: keep each shard stable
  workers: 1,

  // Preserve team's config, override only what we need
  reporter: nextReporter,

  use: {
    ...(base?.use ?? {}),

    // ✅ Always headless in Cloud
    headless: true,

    // ✅ Runner requirement: collect artifacts into the shard report directory
    outputDir: artifactsDir,

    // ✅ Extra stability flags for Chromium in containers (helps reduce random SIGSEGV)
    launchOptions: {
      ...(base?.use?.launchOptions ?? {}),
      args: [
        ...((base?.use?.launchOptions?.args ?? [])),
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-features=VizDisplayCompositor",
        "--no-zygote",
      ],
    },
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
    headless: true,
    actionTimeout: 5000,
    navigationTimeout: 15000,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    outputDir: ${JSON.stringify(artifactsDir)},
    launchOptions: {
      args: [
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-features=VizDisplayCompositor",
        "--no-zygote",
      ],
    },
  },

  reporter: [
    ['line'],
    ['junit', { outputFile: ${JSON.stringify(junitFile)} }],
    ['blob',  { outputDir: ${JSON.stringify(blobDir)} }],
  ],
};
`.trim() + "\n",
      "utf-8",
    );
  }

  // Browser selection (projects)
  const browsers = parseBrowsersEnv(
    process.env.PW_BROWSERS || process.env.BROWSERS,
  );

  // ---------------------------
  // Native sharding mode (optional)
  // ---------------------------
  if (useNativeSharding) {
    const allResults = [];
    for (const project of browsers) {
      elog(
        `▶️ Shard ${shardId}: native sharding | project=${project} | shard=${shardIndex1Based}/${shardCount}${
          testRoot ? ` | TEST_FILE=${testRoot}` : ""
        }`,
      );

      const args = [
        "playwright",
        "test",
        `--config=${cfgPath}`,
        `--project=${project}`,
        `--shard=${shardIndex1Based}/${shardCount}`,
        ...(testRoot ? [testRoot] : []),
      ];

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

      allResults.push(result);
    }

    const signaled = allResults.find((r) => r?.signal);
    if (signaled?.signal) {
      throw new Error(`Playwright terminated by signal: ${signaled.signal}`);
    }

    const exitCode = allResults.some(
      (r) => (typeof r.status === "number" ? r.status : 1) !== 0,
    )
      ? 1
      : 0;

    const errored = allResults.find((r) => r?.error);
    if (errored?.error) {
      elog("❌ Failed to start Playwright process:", errored.error);
      throw errored.error;
    }

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

  // ---------------------------
  // Even distribution by per-test selectors (no overlap)
  // TEST_FILE is used ONLY for discovery (to reduce the universe),
  // and NOT passed to execution (to avoid Playwright UNION overlap).
  // ---------------------------
  const shardIndex0 = Math.max(0, Number(shardIndex1Based) - 1);

  const discovered = [];
  for (const project of browsers) {
    const list = spawnSync(
      "npx",
      [
        "playwright",
        "test",
        `--config=${cfgPath}`,
        `--project=${project}`,
        "--list",
        ...(testRoot ? [testRoot] : []), // ✅ filter discovery by TEST_FILE if provided
      ],
      {
        cwd: repoDir,
        env: {
          ...process.env,
          CI: "1",
          PW_TEST_NO_COLOR: "1",
          PW_REPORT_DIR: reportDir,
          PW_SHARD_ID: String(shardId),
        },
        encoding: "utf-8",
      },
    );

    const stdout = String(list.stdout || "");
    const stderr = String(list.stderr || "");
    const locs = parseListLocations(stdout + "\n" + stderr, project);
    for (const loc of locs) discovered.push({ project, location: loc });
  }

  elog(
    `🧮 Distributing tests evenly | shard=${shardIndex1Based}/${shardCount} | projects=${browsers.join(
      ",",
    )} | totalTests=${discovered.length}${testRoot ? ` | TEST_FILE=${testRoot}` : ""}`,
  );

  const assigned = roundRobinAssign(discovered, shardIndex0, shardCount);

  const byProject = new Map();
  for (const t of assigned) {
    const arr = byProject.get(t.project) || [];
    arr.push(t);
    byProject.set(t.project, arr);
  }

  const projectRuns = [];
  for (const [project, tests] of byProject.entries()) {
    const selectors = tests.map((t) => resolveSelector(repoDir, t.location));
    projectRuns.push({ project, selectors });
  }

  if (projectRuns.length === 0) {
    const fallbackProject = browsers[0] || "chromium";
    elog(
      `⚠️ No tests assigned to shard ${shardId}. Running no-op to still produce reports (project=${fallbackProject}).`,
    );
    projectRuns.push({ project: fallbackProject, selectors: [], noOp: true });
  }

  const allResults = [];
  for (const run of projectRuns) {
    const { project, selectors, noOp } = run;

    elog(
      `▶️ Shard ${shardId}: project=${project} | assigned=${selectors.length}${noOp ? " (no-op)" : ""}`,
    );

    // IMPORTANT: do NOT include testRoot here, or you'll cause overlap (UNION).
    const args = [
      "playwright",
      "test",
      `--config=${cfgPath}`,
      `--project=${project}`,
      ...(noOp ? ["--grep", "a^"] : selectors),
    ];

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

    allResults.push(result);
  }

  const signaled = allResults.find((r) => r?.signal);
  if (signaled?.signal) {
    throw new Error(`Playwright terminated by signal: ${signaled.signal}`);
  }

  const exitCode = allResults.some(
    (r) => (typeof r.status === "number" ? r.status : 1) !== 0,
  )
    ? 1
    : 0;

  const errored = allResults.find((r) => r?.error);
  if (errored?.error) {
    elog("❌ Failed to start Playwright process:", errored.error);
    throw errored.error;
  }

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
