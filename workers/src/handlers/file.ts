import type { Context } from "hono";
import type { AppContext } from "../router";
import { getAttachment } from "../storage/attachments";

// Valid file key pattern: SHA-256 hash (64 hex chars) + optional extension
const FILE_KEY_REGEX = /^[a-fA-F0-9]{64}(\.[a-zA-Z0-9]+)?$/;

export async function handleFileDownload(
  c: Context<AppContext>,
): Promise<Response> {
  const key = c.req.param("key");

  if (!key || !FILE_KEY_REGEX.test(key)) {
    return c.json({ code: 40001, error: "Invalid file key" }, 400);
  }

  const result = await getAttachment(c.env, key);

  if (!result) {
    return c.json({ code: 40401, error: "File not found or expired" }, 404);
  }

  const headers = new Headers();
  headers.set("Content-Type", result.contentType);
  headers.set("Content-Length", result.size.toString());
  headers.set("Content-Disposition", result.contentDisposition);

  // Cache for remaining expiry time
  const now = Math.floor(Date.now() / 1000);
  const maxAge = Math.max(0, result.expires - now);
  headers.set("Cache-Control", `public, max-age=${maxAge}`);

  // CORS headers for cross-origin downloads
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "Content-Disposition");

  return new Response(result.body, { headers });
}
