import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path from "path";

const storage = new Storage();
const bucket = storage.bucket(process.env.BUCKET);

function walk(dir) {
  if (!fs.statSync(dir).isDirectory()) return [dir];
  return fs.readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return fs.statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export async function uploadDir(src, prefix) {
  const files = walk(src);
  for (const f of files) {
    const rel = path.relative(src, f);
    const dest = prefix.endsWith(".xml") ? prefix : `${prefix}/${rel}`;
    await bucket.upload(f, { destination: dest });
    console.log("Uploaded:", dest);
  }
}

export async function downloadPrefix(prefix, dest) {
  const [files] = await bucket.getFiles({ prefix });
  for (const f of files) {
    if (f.name.endsWith("/")) continue;
    const out = path.join(dest, f.name.replace(prefix, ""));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await f.download({ destination: out });
  }
}

export async function waitForShards(prefix, count) {
  while (true) {
    const [files] = await bucket.getFiles({ prefix });
    const shards = new Set(files.map((f) => f.name.split("/")[3]));
    if (shards.size >= count) break;
    console.log(`⏳ Waiting for ${count - shards.size} shards...`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function deletePrefix(prefix) {
  const [files] = await bucket.getFiles({ prefix });
  await Promise.all(files.map((f) => f.delete()));
  console.log("🧹 Deleted:", prefix);
}

const [, , cmd, a, b] = process.argv;

if (cmd === "upload") await uploadDir(a, b);
if (cmd === "download") await downloadPrefix(a, b);
if (cmd === "wait") await waitForShards(a, Number(b));
if (cmd === "delete-prefix") await deletePrefix(a);
