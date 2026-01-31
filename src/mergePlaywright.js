// src/mergePlaywright.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function mergePlaywrightReports({ allBlobDir, mergedDir }) {
  if (!allBlobDir || !mergedDir) {
    throw new Error(
      `mergePlaywrightReports: missing allBlobDir or mergedDir (allBlobDir=${allBlobDir}, mergedDir=${mergedDir})`,
    );
  }

  fs.mkdirSync(allBlobDir, { recursive: true });
  fs.mkdirSync(mergedDir, { recursive: true });

  console.log("🖥️ Generating HTML report...");
  execSync(`npx playwright merge-reports --reporter html "${allBlobDir}"`, {
    stdio: "inherit",
    cwd: mergedDir, // output goes into mergedDir/playwright-report
  });

  console.log("📄 Generating JUnit report...");
  const junit = execSync(
    `npx playwright merge-reports --reporter junit "${allBlobDir}"`,
    {
      encoding: "utf8",
      cwd: mergedDir,
    },
  );

  const junitPath = path.join(mergedDir, "results.xml");
  fs.writeFileSync(
    junitPath,
    junit || '<?xml version="1.0" encoding="UTF-8"?><testsuites></testsuites>',
  );
  console.log(`✅ Wrote ${junitPath}`);

  const htmlDir = path.join(mergedDir, "playwright-report");
  if (!fs.existsSync(htmlDir)) {
    throw new Error(`HTML output folder not found: ${htmlDir}`);
  }

  return { htmlDir, junitPath };
}
