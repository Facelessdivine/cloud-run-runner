import { execSync } from "node:child_process";
import fs from "node:fs";

export async function runTests(testFiles, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const args = testFiles.join(" ");
  execSync(
    `npx playwright test ${args} --reporter=html,junit --output=${outDir}`,
    { stdio: "inherit" },
  );
}
