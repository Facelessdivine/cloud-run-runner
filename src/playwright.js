// src/playwright.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function elog(...args) {
  // Force logs to stderr so they appear under DEFAULT/ERROR views in Cloud Run logs
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
  fullyParallel: true,
  workers: 1,
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
  elog(`cfgPath=${cfgPath}`);

  const cmd = `npx playwright test --config="${cfgPath}" --shard=${shardIndex1Based}/${shardCount}`;

  try {
    execSync(cmd, {
      stdio: "inherit",
      cwd: repoDir,
      env: {
        ...process.env,
        CI: "1",
        // reduce terminal control chars
        PW_TEST_NO_COLOR: "1",
      },
    });
  } catch (e) {
    elog("❌ Playwright command failed:", cmd);
    if (e?.stdout) elog("---- stdout ----\n" + e.stdout.toString());
    if (e?.stderr) elog("---- stderr ----\n" + e.stderr.toString());
    throw e;
  }

  // ✅ This is the line you NEVER saw — now you will (stderr)
  elog("✅ Playwright finished; inspecting blob output...");

  const detailed = listDirDetailed(blobDir);
  elog(`📂 blobDir entries (${detailed.length}):`, detailed);

  if (detailed.length === 0) {
    throw new Error(`Blob report directory is empty after tests: ${blobDir}`);
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
