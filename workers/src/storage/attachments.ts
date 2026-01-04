import type { Env } from "../types/env";
import type { Attachment } from "../types/message";

// Default attachment configuration
const DEFAULT_FILE_SIZE_LIMIT = 15 * 1024 * 1024; // 15MB
const DEFAULT_EXPIRY_DURATION = 3 * 60 * 60; // 3 hours

/**
 * Create a transform stream that counts bytes and aborts if limit exceeded.
 * This allows streaming uploads while enforcing size limits.
 */
function createSizeLimitStream(
  maxSize: number,
): TransformStream<Uint8Array, Uint8Array> & { bytesWritten: number } {
  let bytesWritten = 0;

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesWritten += chunk.length;
      if (bytesWritten > maxSize) {
        controller.error(
          new Error(`Attachment exceeds size limit of ${maxSize} bytes`),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  // Attach bytesWritten as a property for access after streaming
  return Object.assign(stream, {
    get bytesWritten() {
      return bytesWritten;
    },
  });
}

// MIME type to extension mapping
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/css": ".css",
  "text/javascript": ".js",
  "application/json": ".json",
  "application/xml": ".xml",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

/**
 * Get file extension from filename or content type
 */
function getExtension(filename: string, contentType: string): string {
  // Try from filename first
  const match = filename.match(/\.[a-zA-Z0-9]+$/);
  if (match) {
    return match[0].toLowerCase();
  }

  // Fall back to content type
  return MIME_TO_EXT[contentType] || "";
}

/**
 * Get filename from a URL
 */
export function getFilenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/");
    const last = segments[segments.length - 1];
    return last || "attachment";
  } catch {
    return "attachment";
  }
}

/**
 * Check if content appears to be binary (not text)
 */
export function isBinaryContent(contentType: string): boolean {
  if (!contentType) return false;

  const textTypes = [
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-www-form-urlencoded",
  ];

  return !textTypes.some((t) => contentType.startsWith(t));
}

/**
 * Compute SHA-256 hash of data and return as hex string.
 */
async function computeHash(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Buffer a stream with size limit check.
 */
async function bufferStream(
  body: ReadableStream<Uint8Array>,
  maxSize: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalSize += value.length;
    if (totalSize > maxSize) {
      throw new Error(`Attachment exceeds size limit of ${maxSize} bytes`);
    }
    chunks.push(value);
  }

  // Combine chunks into single buffer
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Store an attachment in R2 with content-based deduplication.
 * Uses SHA-256 hash of content as the storage key.
 * If the same content already exists, reuses it and extends expiry if needed.
 */
export async function storeAttachment(
  env: Env,
  messageId: string,
  body: ReadableStream<Uint8Array>,
  filename: string,
  contentType: string,
  contentLength?: number,
): Promise<Attachment> {
  if (!env.ATTACHMENTS) {
    throw new Error("Attachments not configured - R2 bucket not bound");
  }

  const fileSizeLimit = parseInt(
    env.NTFY_ATTACHMENT_FILE_SIZE_LIMIT || String(DEFAULT_FILE_SIZE_LIMIT),
    10,
  );
  const expiryDuration = parseInt(
    env.NTFY_ATTACHMENT_EXPIRY_DURATION || String(DEFAULT_EXPIRY_DURATION),
    10,
  );
  const now = Math.floor(Date.now() / 1000);
  const expires = now + expiryDuration;

  // Check Content-Length header if available for early rejection
  if (contentLength && contentLength > fileSizeLimit) {
    throw new Error(`Attachment exceeds size limit of ${fileSizeLimit} bytes`);
  }

  // Buffer content to compute hash (required for deduplication)
  const bodyData = await bufferStream(body, fileSizeLimit);

  // Compute SHA-256 hash of content
  const contentHash = await computeHash(bodyData);

  // Use hash + extension as key for content-addressed storage
  const ext = getExtension(filename, contentType);
  const key = `${contentHash}${ext}`;

  // Check if content already exists in R2
  const existing = await env.ATTACHMENTS.head(key);

  if (existing) {
    // Content already exists - check if we need to extend expiry
    const existingExpiry = parseInt(
      existing.customMetadata?.expires || "0",
      10,
    );

    if (expires > existingExpiry) {
      // Extend expiry by updating metadata (requires re-upload in R2)
      await env.ATTACHMENTS.put(key, bodyData, {
        httpMetadata: {
          contentType,
          contentDisposition: `attachment; filename="${filename}"`,
        },
        customMetadata: {
          originalName: filename,
          expires: expires.toString(),
          contentHash,
        },
      });
    }
    // Reuse existing content
  } else {
    // Upload new content
    const object = await env.ATTACHMENTS.put(key, bodyData, {
      httpMetadata: {
        contentType,
        contentDisposition: `attachment; filename="${filename}"`,
      },
      customMetadata: {
        originalName: filename,
        expires: expires.toString(),
        contentHash,
      },
    });

    if (!object) {
      throw new Error("Failed to upload attachment to R2");
    }
  }

  const baseUrl = env.NTFY_BASE_URL || "";

  return {
    name: filename,
    type: contentType,
    size: bodyData.byteLength,
    expires,
    url: `${baseUrl}/file/${key}`,
  };
}

/**
 * Get an attachment from R2
 */
export async function getAttachment(
  env: Env,
  key: string,
): Promise<{
  body: ReadableStream;
  contentType: string;
  contentDisposition: string;
  size: number;
  expires: number;
} | null> {
  if (!env.ATTACHMENTS) {
    return null;
  }

  const object = await env.ATTACHMENTS.get(key);
  if (!object) {
    return null;
  }

  // Check expiry
  const expires = parseInt(object.customMetadata?.expires || "0", 10);
  const now = Math.floor(Date.now() / 1000);
  if (expires > 0 && expires < now) {
    // Expired - delete and return null
    await env.ATTACHMENTS.delete(key);
    return null;
  }

  return {
    body: object.body,
    contentType: object.httpMetadata?.contentType || "application/octet-stream",
    contentDisposition:
      object.httpMetadata?.contentDisposition ||
      `attachment; filename="${key}"`,
    size: object.size,
    expires,
  };
}

/**
 * Delete an attachment from R2
 */
export async function deleteAttachment(env: Env, key: string): Promise<void> {
  if (!env.ATTACHMENTS) {
    return;
  }
  await env.ATTACHMENTS.delete(key);
}

/**
 * Delete expired attachments (called by scheduled handler)
 */
export async function deleteExpiredAttachments(env: Env): Promise<number> {
  if (!env.ATTACHMENTS) {
    return 0;
  }

  const now = Math.floor(Date.now() / 1000);
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const list = await env.ATTACHMENTS.list({ cursor, limit: 100 });

    for (const object of list.objects) {
      const expires = parseInt(object.customMetadata?.expires || "0", 10);
      if (expires > 0 && expires < now) {
        await env.ATTACHMENTS.delete(object.key);
        deleted++;
      }
    }

    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  return deleted;
}
