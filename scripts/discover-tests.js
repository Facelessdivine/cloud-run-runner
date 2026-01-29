import { execSync } from "child_process";

const output = execSync("npx playwright test --list", { encoding: "utf8" });
const testCount = output.split("\n").filter((l) => l.includes("›")).length;
console.log(testCount);
