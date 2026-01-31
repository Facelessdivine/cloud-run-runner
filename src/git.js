import fs from "node:fs";
import simpleGit from "simple-git";

export async function cloneRepo(url, ref) {
  if (fs.existsSync("tests")) {
    console.log("🧹 Removing existing tests folder");
    fs.rmSync("tests", { recursive: true, force: true });
  }

  console.log(`📥 Cloning ${url} (${ref})`);
  await simpleGit().clone(url, "tests");
  process.chdir("tests");
  await simpleGit().checkout(ref);
}
