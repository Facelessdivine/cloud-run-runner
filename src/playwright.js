import { execSync } from "node:child_process";
import fs from "node:fs";

export async function runTests(outDir, shardIndex1Based, shardCount) {
  fs.mkdirSync(outDir, { recursive: true });

  execSync(
    `npx playwright test --shard=${shardIndex1Based}/${shardCount} --workers=1 --reporter=blob --output="${outDir}"`,
    { stdio: "inherit" },
  );
}
