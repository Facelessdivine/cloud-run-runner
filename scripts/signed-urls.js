import { Storage } from "@google-cloud/storage";

const storage = new Storage();

export async function signedUrl(bucket, object, minutes = 60) {
  const [url] = await storage
    .bucket(bucket)
    .file(object)
    .getSignedUrl({
      action: "read",
      expires: Date.now() + minutes * 60 * 1000,
    });
  return url;
}
