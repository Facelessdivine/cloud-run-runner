import { execSync } from "node:child_process";
import fs from "node:fs";

export async function discoverTests() {
  console.log("🔍 Discovering tests");
  const testRoot = (process.env.TEST_FILE || process.env.TEST_PATH || "").trim();
  const cmd = testRoot
    ? `npx playwright test "${testRoot}" --list --reporter=json > manifest.json`
    : "npx playwright test --list --reporter=json > manifest.json";
  execSync(cmd, {
    stdio: "inherit",
  });

  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf-8"));

  const files = new Set();

  function walkSuites(suites = []) {
    for (const suite of suites) {
      if (suite.file) files.add(suite.file);
      if (suite.suites) walkSuites(suite.suites);
      if (suite.tests) {
        for (const test of suite.tests) {
          if (test.location?.file) files.add(test.location.file);
        }
      }
    }
  }

  walkSuites(manifest.suites);
  return [...files];
}
