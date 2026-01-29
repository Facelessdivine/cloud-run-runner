import simpleGit from "simple-git";

export async function cloneRepo(url, ref) {
  console.log(`📥 Cloning ${url} (${ref})`);
  await simpleGit().clone(url, "tests");
  process.chdir("tests");
  await simpleGit().checkout(ref);
}
