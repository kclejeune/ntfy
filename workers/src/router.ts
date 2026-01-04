import type { Env } from "./types/env";
import type { AuthContext } from "./types/user";

// Extended context with auth and optional parsed body
export type Variables = {
  auth: AuthContext;
  parsedBody?: Record<string, unknown>;
};

export type AppContext = {
  Bindings: Env;
  Variables: Variables;
};

// Topic name validation regex (matches Go implementation)
const topicRegex = /^[-_A-Za-z0-9]{1,64}$/;

export function isValidTopic(topic: string): boolean {
  return topicRegex.test(topic);
}

// Parse topic from URL path
export function parseTopic(path: string): string | null {
  // Remove leading slash and any file extension
  const cleaned = path.replace(/^\//, "").replace(/\.(json|sse|raw)$/, "");

  // Handle paths like /topic/ws, /topic/json, etc.
  const parts = cleaned.split("/");
  if (parts.length === 0) return null;

  const topic = parts[0];
  return isValidTopic(topic) ? topic : null;
}

// Parse subscription format from path
export type SubscriptionFormat = "json" | "sse" | "raw" | "ws";

export function parseSubscriptionFormat(path: string): SubscriptionFormat {
  if (path.endsWith("/ws")) return "ws";
  if (path.endsWith(".sse") || path.endsWith("/sse")) return "sse";
  if (path.endsWith(".raw") || path.endsWith("/raw")) return "raw";
  return "json";
}
