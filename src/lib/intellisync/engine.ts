/**
 * IntelliSync core engine: pure, framework-agnostic event and retry logic.
 * Persistence and authorization enforcement belong in trusted server-side services.
 */

export type ConnectionStatus = "not_connected" | "healthy" | "degraded" | "failed";
export type EventStatus = "pending" | "processing" | "succeeded" | "failed" | "dead";

export const SYNC_EVENT_TYPES = [
  "user.created",
  "user.updated",
  "user.offboarded",
  "device.assigned",
  "device.unassigned",
  "group.membership_changed",
  "role.changed",
  "license.assigned",
  "license.revoked",
  "ticket.created",
  "ticket.updated",
] as const;

export type SyncEventType = (typeof SYNC_EVENT_TYPES)[ umber];

export type SyncEvent = {
  id: string;
  connection_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  payload: unknown;
  status: EventStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
};

/** Exponential backoff: 30s, 60s, 120s ... capped at 1h. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

/** State transition after a handler attempt. */
export function nextState(
  event: Pick&lt;SyncEvent, "attempts" | "max_attempts"&gt;,
  succeeded: boolean,
  now = Date.now(),
) {
  const attempts = event.attempts + 1;
  if (succeeded) return { status: "succeeded" as const, attempts, next_attempt_at: new Date(now).toISOString() };
  if (attempts &gt;= event.max_attempts) return { status: "dead" as const, attempts, next_attempt_at: new Date(now).toISOString() };
  return { status: "failed" as const, attempts, next_attempt_at: new Date(now + backoffMs(attempts)).toISOString() };
}

/** Derive connection health from recent event outcomes. */
export function deriveHealth(recent: { status: EventStatus }[]): ConnectionStatus {
  if (recent.length === 0) return "not_connected";
  const bad = recent.filter((event) => event.status === "failed" || event.status === "dead").length;
  const ratio = bad / recent.length;
  if (ratio === 0) return "healthy";
  return ratio &lt; 0.25 ? "degraded" : "failed";
}

/** Select pending or retryable events whose scheduled retry time has arrived. */
export function dueEvents&lt;T extends Pick&lt;SyncEvent, "status" | "next_attempt_at"&gt;&gt;(events: T[], now = Date.now()): T[] {
  return events.filter((event) => (event.status === "pending" || event.status === "failed") &amp;&amp; Date.parse(event.next_attempt_at) &lt;= now);
}

/** UI/domain hint only, never an authorization boundary. Server-side permissions and RLS remain authoritative. */
export type Role = "admin" | "it_staff" | "employee";
export function canEmit(roles: Role[], type: SyncEventType): boolean {
  if (roles.includes("admin")) return true;
  if (roles.includes("it_staff")) return !type.startsWith("role.");
  return type.startsWith("ticket.");
}

export type SyncHandler = (event: SyncEvent) =&gt; Promise&lt;void&gt;;
/** In-memory handler registry for local dispatch composition only. */
export const handlers = new Map&lt;string, SyncHandler&gt;();
export function registerHandler(connectionId: string, handler: SyncHandler): void {
  handlers.set(connectionId, handler);
}
