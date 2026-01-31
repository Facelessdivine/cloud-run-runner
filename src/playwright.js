import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function runTests(outDir, shardIndex1Based, shardCount, shardId) {
  fs.mkdirSync(outDir, { recursive: true });

  const blobDir = path.join(outDir, "blob-report");
  fs.mkdirSync(blobDir, { recursive: true });

  const blobName = `shard-${shardId}-of-${shardCount}.zip`;

  // ✅ Create a tiny config that FORCES blob reporter output into outDir/blob-report
  const cfgPath = path.join(outDir, "pw.blob.config.cjs");
  fs.writeFileSync(
    cfgPath,
    `
      /** @type {import('@playwright/test').PlaywrightTestConfig} */
      module.exports = {
        reporter: [['blob', { outputDir: ${JSON.stringify(blobDir)} }]],
      };
    `,
    "utf-8",
  );

  // ✅ Run shard with forced config
  execSync(
    `npx playwright test --config=${cfgPath} --shard=${shardIndex1Based}/${shardCount} --workers=1`,
    { stdio: "inherit" },
  );

  // ✅ Find the produced zip inside blobDir
  const files = fs.readdirSync(blobDir).filter((f) => f.endsWith(".zip"));

  if (files.length === 0) {
    throw new Error(`Blob report not found. No .zip files in ${blobDir}`);
  }

  // If Playwright generates a generic name, rename it deterministically
  const produced = path.join(blobDir, files[0]);
  const dest = path.join(outDir, blobName);
  fs.copyFileSync(produced, dest);

  return dest;
}
