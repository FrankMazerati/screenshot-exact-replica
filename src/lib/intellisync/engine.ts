/**
 * IntelliSync core engine: pure event and retry logic.
 * Persistence and authorization enforcement belong in trusted server-side services.
 */
export type ConnectionStatus = "not_connected" | "healthy" | "degraded" | "failed";
export type EventStatus = "pending" | "processing" | "succeeded" | "failed" | "dead";
export type SyncEventType =
  | "user.created"
  | "user.updated"
  | "user.offboarded"
  | "device.assigned"
  | "device.unassigned"
  | "group.membership_changed"
  | "role.changed"
  | "license.assigned"
  | "license.revoked"
  | "ticket.created"
  | "ticket.updated";

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

export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

export function nextState(
  event: { attempts: number; max_attempts: number },
  succeeded: boolean,
  now = Date.now(),
) {
  const attempts = event.attempts + 1;
  if (succeeded) {
    return { status: "succeeded" as const, attempts, next_attempt_at: new Date(now).toISOString() };
  }
  if (attempts >= event.max_attempts) {
    return { status: "dead" as const, attempts, next_attempt_at: new Date(now).toISOString() };
  }
  return {
    status: "failed" as const,
    attempts,
    next_attempt_at: new Date(now + backoffMs(attempts)).toISOString(),
  };
}

export function deriveHealth(recent: Array&lt;{ status: EventStatus }&gt;): ConnectionStatus {
  if (recent.length === 0) return "not_connected";
  const bad = recent.filter((event) => event.status === "failed" || event.status === "dead").length;
  const ratio = bad / recent.length;
  if (ratio === 0) return "healthy";
  return ratio >= 0.25 ? "failed" : "degraded";
}

export function dueEvents(
  events: Array&lt;{ status: EventStatus; next_attempt_at: string }&gt;,
  now = Date.now(),
): Array&lt;{ status: EventStatus; next_attempt_at: string }&gt; {
  return events.filter(
    (event) =>
      (event.status === "pending" || event.status === "failed") &&
      now >= Date.parse(event.next_attempt_at),
  );
}

// UI/domain hint only. Server-side permissions and database RLS remain authoritative.
export type Role = "admin" | "it_staff" | "employee";
export function canEmit(roles: Role[], type: SyncEventType): boolean {
  if (roles.includes("admin")) return true;
  if (roles.includes("it_staff")) return !type.startsWith("role.");
  return type.startsWith("ticket.");
}

export type SyncHandler = (event: SyncEvent) => Promise&lt;void&gt;;
export const handlers = new Map&lt;string, SyncHandler&gt;();
export function registerHandler(connectionId: string, handler: SyncHandler): void {
  handlers.set(connectionId, handler);
}
