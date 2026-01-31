import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function runTests(outDir, shardIndex1Based, shardCount, shardId) {
  fs.mkdirSync(outDir, { recursive: true });

  // Ensure each shard generates a unique blob zip name
  // (This env var is supported by Playwright blob reporter)
  const blobName = `shard-${shardId}-of-${shardCount}.zip`;

  execSync(
    `npx playwright test --shard=${shardIndex1Based}/${shardCount} --workers=1 --reporter=blob`,
    {
      stdio: "inherit",
      env: { ...process.env, PWTEST_BLOB_REPORT_NAME: blobName },
    },
  );

  // Playwright blob reporter writes to ./blob-report by default (near package.json)
  const blobDir = path.join(process.cwd(), "blob-report");
  const blobPath = path.join(blobDir, blobName);

  if (!fs.existsSync(blobPath)) {
    // fallback: if Playwright used the default report.zip name
    const fallback = path.join(blobDir, "report.zip");
    if (!fs.existsSync(fallback)) {
      throw new Error(
        `Blob report not found. Expected ${blobPath} (or ${fallback}).`,
      );
    }
    fs.copyFileSync(fallback, path.join(outDir, blobName));
    return path.join(outDir, blobName);
  }

  // Copy blob into outDir so the uploader can grab it reliably
  const dest = path.join(outDir, blobName);
  fs.copyFileSync(blobPath, dest);
  return dest;
}
