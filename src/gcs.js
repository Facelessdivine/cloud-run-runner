import { Storage } from "@google-cloud/storage";
import fs from "node:fs";
import path from "node:path";

const storage = new Storage();

export async function downloadDir(bucketName, prefix, localDir) {
  console.log(`📥 Downloading gs://${bucketName}/${prefix}`);

  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix });

  for (const file of files) {
    const rel = file.name.replace(prefix, "");
    const dest = path.join(localDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await file.download({ destination: dest });
  }
}

export async function uploadDir(bucketName, localPath, prefix) {
  console.log(`📤 Uploading ${localPath} → gs://${bucketName}/${prefix}`);

  const bucket = storage.bucket(bucketName);

  async function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = path.relative(localPath, full);

      if (fs.statSync(full).isDirectory()) await walk(full);
      else {
        await bucket.upload(full, { destination: `${prefix}/${rel}` });
      }
    }
  }

  await walk(localPath);
}
