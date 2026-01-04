import type { AuthContext } from "../types/user";

export interface AccessCheckResult {
  allowed: boolean;
  status: number;
  code: number;
  error: string;
}

// Check if a user has access to a topic
export async function checkTopicAccess(
  db: D1Database,
  topic: string,
  auth: AuthContext,
  permission: "read" | "write",
): Promise<AccessCheckResult> {
  // Admins have full access
  if (auth.user?.role === "admin") {
    return { allowed: true, status: 200, code: 0, error: "" };
  }

  // Check if topic is reserved
  const reservation = await db
    .prepare(
      "SELECT user_id, everyone_read, everyone_write FROM reservations WHERE topic = ?",
    )
    .bind(topic)
    .first<{
      user_id: string;
      everyone_read: number;
      everyone_write: number;
    }>();

  if (reservation) {
    // Topic is reserved
    const isOwner = auth.user?.id === reservation.user_id;

    if (isOwner) {
      // Owner has full access
      return { allowed: true, status: 200, code: 0, error: "" };
    }

    // Check everyone permissions on the reservation
    if (permission === "read" && reservation.everyone_read === 1) {
      return { allowed: true, status: 200, code: 0, error: "" };
    }
    if (permission === "write" && reservation.everyone_write === 1) {
      return { allowed: true, status: 200, code: 0, error: "" };
    }

    // Check user-specific access
    if (auth.user) {
      const userAccess = await db
        .prepare(
          "SELECT read, write FROM user_access WHERE user_id = ? AND topic = ?",
        )
        .bind(auth.user.id, topic)
        .first<{ read: number; write: number }>();

      if (userAccess) {
        if (permission === "read" && userAccess.read === 1) {
          return { allowed: true, status: 200, code: 0, error: "" };
        }
        if (permission === "write" && userAccess.write === 1) {
          return { allowed: true, status: 200, code: 0, error: "" };
        }
      }
    }

    // Access denied for reserved topic
    if (auth.anonymous) {
      return {
        allowed: false,
        status: 401,
        code: 40101,
        error: "Unauthorized: This topic requires authentication",
      };
    }
    return {
      allowed: false,
      status: 403,
      code: 40301,
      error: "Forbidden: You do not have access to this topic",
    };
  }

  // Topic is not reserved - check for explicit user access restrictions
  if (auth.user) {
    const userAccess = await db
      .prepare(
        "SELECT read, write FROM user_access WHERE user_id = ? AND topic = ?",
      )
      .bind(auth.user.id, topic)
      .first<{ read: number; write: number }>();

    if (userAccess) {
      // User has explicit access configured
      if (permission === "read" && userAccess.read === 1) {
        return { allowed: true, status: 200, code: 0, error: "" };
      }
      if (permission === "write" && userAccess.write === 1) {
        return { allowed: true, status: 200, code: 0, error: "" };
      }
      // Explicit access exists but doesn't grant this permission
      // Fall through to default behavior
    }
  }

  // Check for default access rules (e.g., deny-all for anonymous)
  // For now, allow all access to non-reserved topics
  // This matches ntfy's default behavior with auth-default-access=read-write
  return { allowed: true, status: 200, code: 0, error: "" };
}

// Reserve a topic for a user
export async function reserveTopic(
  db: D1Database,
  topic: string,
  userId: string,
  everyoneRead: boolean = true,
  everyoneWrite: boolean = false,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reservations (topic, user_id, everyone_read, everyone_write)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(topic) DO UPDATE SET user_id = ?, everyone_read = ?, everyone_write = ?`,
    )
    .bind(
      topic,
      userId,
      everyoneRead ? 1 : 0,
      everyoneWrite ? 1 : 0,
      userId,
      everyoneRead ? 1 : 0,
      everyoneWrite ? 1 : 0,
    )
    .run();
}

// Remove topic reservation
export async function unreserveTopic(
  db: D1Database,
  topic: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM reservations WHERE topic = ? AND user_id = ?")
    .bind(topic, userId)
    .run();

  return (result.meta.changes || 0) > 0;
}

// Get user's reserved topics
export async function getUserReservations(
  db: D1Database,
  userId: string,
): Promise<
  { topic: string; everyone_read: boolean; everyone_write: boolean }[]
> {
  const result = await db
    .prepare(
      "SELECT topic, everyone_read, everyone_write FROM reservations WHERE user_id = ?",
    )
    .bind(userId)
    .all<{
      topic: string;
      everyone_read: number;
      everyone_write: number;
    }>();

  return (result.results || []).map((r) => ({
    topic: r.topic,
    everyone_read: r.everyone_read === 1,
    everyone_write: r.everyone_write === 1,
  }));
}
