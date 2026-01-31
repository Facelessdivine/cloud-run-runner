import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function mergePlaywrightReports({ allBlobDir, mergedDir, repoTestDir }) {
  const htmlDir = path.join(mergedDir, "final-html");
  const junitPath = path.join(mergedDir, "junit.xml");

  fs.mkdirSync(htmlDir, { recursive: true });

  const mergeCfg = path.join(mergedDir, "pw.merge.config.cjs");
  fs.writeFileSync(
    mergeCfg,
    `
      module.exports = {
        testDir: ${JSON.stringify(repoTestDir)},
      };
    `,
    "utf-8",
  );

  execSync(
    `npx playwright merge-reports -c ${mergeCfg} --reporter html "${allBlobDir}"`,
    { stdio: "inherit" },
  );

  // If you generate junit separately, keep it here. Or generate with merge reporter combos.

  return { htmlDir, junitPath };
}
