import { execSync } from "child_process";

const out = execSync("npx playwright test --list --reporter=json", {
  encoding: "utf8",
});

const data = JSON.parse(out);
const testCount =
  data.suites?.reduce((acc, s) => acc + (s.tests?.length || 0), 0) || 1;

const shards = Math.min(Math.max(1, Math.ceil(testCount / 5)), 50);
console.log(shards);
