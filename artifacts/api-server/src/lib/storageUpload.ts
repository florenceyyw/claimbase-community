import { objectStorageClient } from "./objectStorage";
import { logger } from "./logger";

export async function uploadBufferToStorage(
  buffer: Buffer,
  subPath: string,
  contentType: string
): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) {
    logger.warn("PRIVATE_OBJECT_DIR not set, skipping object storage upload");
    return "";
  }

  const fullPath = `${privateObjectDir}/${subPath}`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  const bucketName = parts[0]!;
  const objectName = parts.slice(1).join("/");

  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);

  await file.save(buffer, {
    contentType,
    resumable: false,
  });

  return `/api/storage/objects/${subPath}`;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0] || url;
  }
}

export async function uploadFromUrlToStorage(
  sourceUrl: string,
  subPath: string,
  contentType: string
): Promise<string> {
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      logger.warn({ url: redactUrl(sourceUrl), status: response.status }, "Failed to download file for storage upload");
      return sourceUrl;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const storedPath = await uploadBufferToStorage(buffer, subPath, contentType);
    if (!storedPath) return sourceUrl;
    return storedPath;
  } catch (err) {
    logger.warn({ err, url: redactUrl(sourceUrl) }, "Failed to upload file to object storage, using original URL");
    return sourceUrl;
  }
}
