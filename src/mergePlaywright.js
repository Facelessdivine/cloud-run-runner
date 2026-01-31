import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function mergeReports(allBlobDir, mergedOutDir) {
  fs.mkdirSync(mergedOutDir, { recursive: true });

  execSync(`npx playwright merge-reports --reporter html "${allBlobDir}"`, {
    stdio: "inherit",
  });

  const generated = path.resolve("playwright-report");
  const targetHtml = path.join(mergedOutDir, "html-report");

  fs.rmSync(targetHtml, { recursive: true, force: true });
  fs.renameSync(generated, targetHtml);

  const junitFile = path.join(mergedOutDir, "results.xml");
  execSync(
    `npx playwright merge-reports --reporter junit "${allBlobDir}" > "${junitFile}"`,
    { stdio: "inherit", shell: true },
  );
}
