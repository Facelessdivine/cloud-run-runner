import { execSync } from "node:child_process";
import fs from "node:fs";

export async function mergeReports(rootDir) {
  console.log("🧬 Running playwright merge-reports");

  const shardDirs = fs
    .readdirSync(rootDir)
    .map((d) => `${rootDir}/${d}`)
    .join(" ");

  const outDir = `${rootDir}/merged`;
  fs.mkdirSync(outDir, { recursive: true });

  execSync(
    `npx playwright merge-reports ${shardDirs} --reporter html,junit --output=${outDir}`,
    { stdio: "inherit" },
  );

  return {
    htmlDir: `${outDir}/playwright-report`,
    junitFile: `${outDir}/results.xml`,
  };
}
