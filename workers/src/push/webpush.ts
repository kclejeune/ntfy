import type { Env } from "../types/env";
import type { Message } from "../types/message";

/**
 * Web Push implementation for Cloudflare Workers
 * Implements RFC 8291 (Message Encryption) and RFC 8292 (VAPID)
 */

/**
 * ECDH key derivation parameters for crypto.subtle.deriveBits
 * Not defined in standard TypeScript DOM types but required for Web Push
 */
interface EcdhKeyDeriveParams {
  name: "ECDH";
  public: CryptoKey;
}

interface PushSubscription {
  id: string;
  endpoint: string;
  keys: {
    p256dh: string; // Base64url-encoded client public key
    auth: string; // Base64url-encoded auth secret
  };
}

interface WebPushPayload {
  topic: string;
  title: string;
  body: string;
  icon?: string;
  url: string;
  messageId: string;
}

/**
 * Base64url decode to Uint8Array
 */
function base64urlDecode(str: string): Uint8Array {
  // Add padding if needed
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  // Convert base64url to base64
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Base64url encode from Uint8Array
 */
function base64urlEncode(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Concatenate multiple Uint8Arrays
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * HKDF (RFC 5869) - Extract and Expand
 */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  // Extract
  const extractKey = await crypto.subtle.importKey(
    "raw",
    salt.length > 0 ? salt : new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", extractKey, ikm));

  // Expand
  const expandKey = await crypto.subtle.importKey(
    "raw",
    prk,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const infoWithCounter = concatBytes(info, new Uint8Array([1]));
  const okm = new Uint8Array(
    await crypto.subtle.sign("HMAC", expandKey, infoWithCounter),
  );

  return okm.slice(0, length);
}

/**
 * Create info for HKDF in aes128gcm content encoding
 */
function createInfo(
  type: string,
  clientPublicKey: Uint8Array,
  serverPublicKey: Uint8Array,
): Uint8Array {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(type);

  // "Content-Encoding: <type>\0P-256\0"
  const header = encoder.encode("Content-Encoding: ");
  const p256 = encoder.encode("P-256");
  const nul = new Uint8Array([0]);

  // Client public key length (2 bytes, big endian) + key
  const clientKeyLen = new Uint8Array([0, clientPublicKey.length]);

  // Server public key length (2 bytes, big endian) + key
  const serverKeyLen = new Uint8Array([0, serverPublicKey.length]);

  return concatBytes(
    header,
    typeBytes,
    nul,
    p256,
    nul,
    clientKeyLen,
    clientPublicKey,
    serverKeyLen,
    serverPublicKey,
  );
}

/**
 * Encrypt payload using aes128gcm content encoding (RFC 8291)
 */
async function encryptPayload(
  payload: string,
  clientPublicKeyB64: string,
  authSecretB64: string,
): Promise<{ encrypted: Uint8Array; serverPublicKey: Uint8Array }> {
  const clientPublicKey = base64urlDecode(clientPublicKeyB64);
  const authSecret = base64urlDecode(authSecretB64);
  const plaintext = new TextEncoder().encode(payload);

  // Generate server ECDH key pair
  const serverKeyPair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;

  // Export server public key in uncompressed format
  const serverPublicKeyRaw = new Uint8Array(
    (await crypto.subtle.exportKey(
      "raw",
      serverKeyPair.publicKey,
    )) as ArrayBuffer,
  );

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // ECDH shared secret
  const ecdhParams: EcdhKeyDeriveParams = { name: "ECDH", public: clientKey };
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhParams, serverKeyPair.privateKey, 256),
  );

  // Generate random salt (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive IKM from shared secret and auth secret
  const ikmInfo = concatBytes(
    new TextEncoder().encode("WebPush: info\0"),
    clientPublicKey,
    serverPublicKeyRaw,
  );
  const ikm = await hkdf(authSecret, sharedSecret, ikmInfo, 32);

  // Derive content encryption key (CEK) and nonce
  const cekInfo = createInfo("aes128gcm", clientPublicKey, serverPublicKeyRaw);
  const nonceInfo = createInfo("nonce", clientPublicKey, serverPublicKeyRaw);

  const cek = await hkdf(salt, ikm, cekInfo, 16);
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  // Import CEK for AES-GCM
  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  // Add padding delimiter (0x02 for last record)
  const paddedPlaintext = concatBytes(plaintext, new Uint8Array([2]));

  // Encrypt with AES-128-GCM
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aesKey,
      paddedPlaintext,
    ),
  );

  // Build aes128gcm header: salt (16) + rs (4) + idlen (1) + keyid (65)
  const rs = new Uint8Array([0, 0, 16, 0]); // record size = 4096
  const idlen = new Uint8Array([serverPublicKeyRaw.length]);

  const encrypted = concatBytes(
    salt,
    rs,
    idlen,
    serverPublicKeyRaw,
    ciphertext,
  );

  return { encrypted, serverPublicKey: serverPublicKeyRaw };
}

/**
 * Create VAPID JWT token (RFC 8292)
 */
async function createVapidJwt(
  privateKeyB64: string,
  audience: string,
  subject: string,
  expiration: number,
): Promise<string> {
  const privateKeyBytes = base64urlDecode(privateKeyB64);

  // Import ECDSA private key for signing
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  // JWT header
  const header = { typ: "JWT", alg: "ES256" };
  const headerB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  );

  // JWT payload
  const payload = {
    aud: audience,
    exp: expiration,
    sub: subject,
  };
  const payloadB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  // Sign
  const signatureInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureRaw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      signatureInput,
    ),
  );

  // Convert DER signature to raw r||s format (64 bytes)
  // crypto.subtle returns raw format already for P-256
  const signatureB64 = base64urlEncode(signatureRaw);

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Create VAPID headers for Web Push request
 */
async function createVapidHeaders(
  env: Env,
  audience: string,
): Promise<{ Authorization: string; "Crypto-Key"?: string }> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
    throw new Error("VAPID keys not configured");
  }

  const subject =
    env.VAPID_SUBJECT ||
    `mailto:admin@${new URL(env.NTFY_BASE_URL || "https://ntfy.sh").hostname}`;
  const expiration = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours

  const jwt = await createVapidJwt(
    env.VAPID_PRIVATE_KEY,
    audience,
    subject,
    expiration,
  );

  // vapid scheme: Authorization: vapid t=<jwt>, k=<public-key>
  return {
    Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
  };
}

/**
 * Send a Web Push notification to a single subscription
 */
export async function sendWebPush(
  env: Env,
  subscription: PushSubscription,
  message: Message,
): Promise<{ success: boolean; status?: number; error?: string }> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
    return { success: false, error: "VAPID keys not configured" };
  }

  try {
    const payload: WebPushPayload = {
      topic: message.topic,
      title: message.title || message.topic,
      body: message.message || "",
      icon: message.icon,
      url: `${env.NTFY_BASE_URL || ""}/${message.topic}`,
      messageId: message.id,
    };

    const payloadJson = JSON.stringify(payload);

    // Encrypt the payload
    const { encrypted } = await encryptPayload(
      payloadJson,
      subscription.keys.p256dh,
      subscription.keys.auth,
    );

    // Get the push service origin for VAPID audience
    const endpoint = new URL(subscription.endpoint);
    const audience = endpoint.origin;

    // Create VAPID headers
    const vapidHeaders = await createVapidHeaders(env, audience);

    // Send the push
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "Content-Length": encrypted.length.toString(),
        TTL: "86400", // 24 hours
        ...vapidHeaders,
      },
      body: encrypted,
    });

    // 201 = created (success)
    // 410 = gone (subscription expired, should be removed)
    // 404 = not found (subscription invalid, should be removed)
    if (response.status === 201) {
      return { success: true, status: 201 };
    }

    return {
      success: false,
      status: response.status,
      error: await response.text(),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Get all subscriptions for a given topic
 */
async function getSubscriptionsForTopic(
  db: D1Database,
  topic: string,
): Promise<PushSubscription[]> {
  // Query subscriptions where topics JSON array contains this topic
  // D1/SQLite JSON functions: json_each to search array
  const result = await db
    .prepare(
      `SELECT id, endpoint, key_p256dh, key_auth
       FROM web_push_subscriptions
       WHERE EXISTS (
         SELECT 1 FROM json_each(topics) WHERE value = ?
       )`,
    )
    .bind(topic)
    .all<{
      id: string;
      endpoint: string;
      key_p256dh: string;
      key_auth: string;
    }>();

  return (result.results || []).map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    keys: {
      p256dh: row.key_p256dh,
      auth: row.key_auth,
    },
  }));
}

/**
 * Update subscription status after push attempt
 */
async function updateSubscriptionStatus(
  db: D1Database,
  subscriptionId: string,
  success: boolean,
  httpStatus?: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  if (success) {
    await db
      .prepare(
        `UPDATE web_push_subscriptions
         SET last_success = ?, failure_count = 0
         WHERE id = ?`,
      )
      .bind(now, subscriptionId)
      .run();
  } else if (httpStatus === 410 || httpStatus === 404) {
    // Subscription is gone, delete it
    await db
      .prepare("DELETE FROM web_push_subscriptions WHERE id = ?")
      .bind(subscriptionId)
      .run();
  } else {
    // Increment failure count
    await db
      .prepare(
        `UPDATE web_push_subscriptions
         SET failure_count = failure_count + 1
         WHERE id = ?`,
      )
      .bind(subscriptionId)
      .run();
  }
}

/**
 * Send Web Push notifications to all subscriptions for a topic
 */
export async function broadcastWebPush(
  env: Env,
  message: Message,
): Promise<{ sent: number; failed: number }> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
    return { sent: 0, failed: 0 };
  }

  const subscriptions = await getSubscriptionsForTopic(env.DB, message.topic);

  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  // Send in parallel batches of 10 to avoid overwhelming
  const batchSize = 10;
  for (let i = 0; i < subscriptions.length; i += batchSize) {
    const batch = subscriptions.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (sub) => {
        const result = await sendWebPush(env, sub, message);
        await updateSubscriptionStatus(
          env.DB,
          sub.id,
          result.success,
          result.status,
        );
        return result;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.success) {
        sent++;
      } else {
        failed++;
      }
    }
  }

  return { sent, failed };
}

/**
 * Check if Web Push is enabled (VAPID keys configured)
 */
export function isWebPushEnabled(env: Env): boolean {
  return !!(env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY);
}
