import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path from "path";

const storage = new Storage();

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) =>
      d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)],
    );
}

export async function uploadDir(src, bucket, prefix) {
  const files = walk(src);
  for (const f of files) {
    const rel = path.relative(src, f);
    const dest = `${prefix}/${rel}`;
    await storage.bucket(bucket).upload(f, { destination: dest });
    console.log("⬆️", dest);
  }
}

export async function uploadFile(file, bucket, dest) {
  await storage.bucket(bucket).upload(file, { destination: dest });
  console.log("⬆️", dest);
}

export async function downloadPrefix(bucket, prefix, dest) {
  const [files] = await storage.bucket(bucket).getFiles({ prefix });
  for (const f of files) {
    if (f.name.endsWith("/")) continue;
    const out = path.join(dest, f.name.replace(prefix, ""));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await f.download({ destination: out });
    console.log("⬇️", f.name);
  }
}

export async function deletePrefix(bucket, prefix) {
  const [files] = await storage.bucket(bucket).getFiles({ prefix });
  await Promise.all(files.map((f) => f.delete()));
  console.log(`🧹 Deleted ${files.length} files from ${prefix}`);
}
