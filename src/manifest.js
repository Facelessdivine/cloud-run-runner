import { execSync } from "node:child_process";
import fs from "node:fs";

export async function discoverTests() {
  console.log("🔍 Discovering tests");

  execSync("npx playwright test --list --reporter=json > manifest.json", {
    stdio: "inherit",
  });

  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf-8"));

  return manifest.tests.map((t) => t.location.file);
}
