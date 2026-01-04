import type { Message } from "../types/message";
import type { Env } from "../types/env";

/**
 * Forward a poll request to upstream server (ntfy.sh) for iOS push notifications.
 *
 * The upstream server will send via Firebase → APNs to the iOS app.
 * The iOS app receives the notification with a poll ID, then polls
 * OUR server directly to retrieve the actual message content.
 *
 * Privacy: Only the message ID and topic hash are sent to the upstream server.
 * The actual message content never leaves our server.
 */
export async function forwardPollRequest(
  env: Env,
  message: Message,
): Promise<void> {
  if (!env.NTFY_UPSTREAM_BASE_URL || !env.NTFY_BASE_URL) {
    return; // Upstream not configured
  }

  // Create topic hash: SHA256(base_url/topic)
  // Testing with full URL including protocol prefix
  const topicUrl = `${env.NTFY_BASE_URL}/${message.topic}`;
  const topicHash = await sha256(topicUrl);

  // Forward poll request to upstream
  const upstreamUrl = `${env.NTFY_UPSTREAM_BASE_URL}/${topicHash}`;

  // Match the original ntfy server's poll request format
  const headers: Record<string, string> = {
    "User-Agent": "ntfy/worker",
    "X-Poll-ID": message.id,
  };

  if (env.NTFY_UPSTREAM_ACCESS_TOKEN) {
    headers["Authorization"] = `Bearer ${env.NTFY_UPSTREAM_ACCESS_TOKEN}`;
  }

  try {
    // Original ntfy sends empty body for poll requests
    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: "",
    });

    if (!response.ok) {
      console.error(
        `Upstream poll request failed: ${response.status} ${response.statusText}`,
      );
    }
  } catch (err) {
    console.error("Failed to forward poll request to upstream:", err);
  }
}

/**
 * Compute SHA256 hash of a string, returning hex-encoded result.
 */
async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
