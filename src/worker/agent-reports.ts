import type { AgentToHub, Instance, InstanceView } from "@shared/types";

export type AgentStatusMessage = Extract<AgentToHub, { type: "status" }>;

export interface AgentReportPayload {
  reportedAt: number;
  status: AgentStatusMessage;
}

interface CredentialRow {
  token_hash: string;
}

interface StatusRow {
  instance_id: string;
  reported_at: number;
  received_at: number;
  process_state: Instance["processState"];
  metrics_json: string | null;
  service_status_json: string | null;
  traffic_json: string | null;
}

interface MonthlyRow {
  instance_id: string;
  month: string;
  bytes_in: number;
  bytes_out: number;
}

export interface StoredAgentState {
  reportedAt: number;
  receivedAt: number;
  processState: Instance["processState"];
  metrics?: Instance["metrics"];
  serviceStatus?: Instance["serviceStatus"];
  traffic?: Instance["traffic"];
  monthlyTraffic?: Instance["monthlyTraffic"];
}

const PROCESS_STATES = new Set<Instance["processState"]>([
  "running",
  "stopped",
  "errored",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strictly validate the public agent report endpoint before touching D1. */
export function parseAgentReport(value: unknown): AgentReportPayload | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.reportedAt) || !isRecord(value.status)) {
    return null;
  }
  const status = value.status;
  if (status.type !== "status" || !PROCESS_STATES.has(status.processState as Instance["processState"])) {
    return null;
  }
  if (status.metrics !== undefined && !isRecord(status.metrics)) return null;
  if (status.serviceStatus !== undefined) {
    if (!isRecord(status.serviceStatus)) return null;
    if (Object.values(status.serviceStatus).some((online) => typeof online !== "boolean")) return null;
  }
  if (status.traffic !== undefined) {
    if (!isRecord(status.traffic)) return null;
    for (const traffic of Object.values(status.traffic)) {
      if (!isRecord(traffic)) return null;
      if (
        !Number.isSafeInteger(traffic.bytesIn) ||
        (traffic.bytesIn as number) < 0 ||
        !Number.isSafeInteger(traffic.bytesOut) ||
        (traffic.bytesOut as number) < 0
      ) {
        return null;
      }
    }
  }
  return value as unknown as AgentReportPayload;
}

export async function hashAgentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function agentCredentialMatches(
  db: D1Database,
  instanceId: string,
  token: string,
): Promise<boolean | null> {
  const row = await db
    .prepare("SELECT token_hash FROM agent_credentials WHERE instance_id = ?")
    .bind(instanceId)
    .first<CredentialRow>();
  if (!row) return null;
  return row.token_hash === (await hashAgentToken(token));
}

/**
 * Seed D1 from the DO instance record during enrollment/control-socket auth, so
 * subsequent status reports can authenticate without entering the DO.
 */
export async function syncAgentInstance(db: D1Database, inst: Instance): Promise<void> {
  const reportedAt = inst.lastSeen ?? inst.updatedAt;
  const statements = [
    db
      .prepare(
        `INSERT INTO agent_credentials (instance_id, token_hash, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           token_hash = excluded.token_hash,
           updated_at = excluded.updated_at`,
      )
      .bind(inst.id, await hashAgentToken(inst.agentToken), Date.now()),
    // Seed without traffic first so the insert trigger does not count an
    // already-accounted cumulative snapshot as fresh traffic.
    db
      .prepare(
        `INSERT OR IGNORE INTO agent_status
           (instance_id, reported_at, received_at, process_state, metrics_json,
            service_status_json, traffic_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        inst.id,
        reportedAt,
        inst.lastSeen ?? reportedAt,
        inst.processState,
        inst.metrics ? JSON.stringify(inst.metrics) : null,
        inst.serviceStatus ? JSON.stringify(inst.serviceStatus) : null,
      ),
    // This update deliberately keeps reported_at unchanged; the traffic trigger
    // only accumulates newer reports, so it safely restores the prior snapshot.
    db
      .prepare(
        `UPDATE agent_status
         SET traffic_json = COALESCE(traffic_json, ?)
         WHERE instance_id = ? AND reported_at = ?`,
      )
      .bind(inst.traffic ? JSON.stringify(inst.traffic) : null, inst.id, reportedAt),
  ];

  for (const [month, total] of Object.entries(inst.monthlyTraffic ?? {})) {
    statements.push(
      db
        .prepare(
          `INSERT INTO agent_monthly_traffic
             (instance_id, month, bytes_in, bytes_out)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(instance_id, month) DO UPDATE SET
             bytes_in = MAX(bytes_in, excluded.bytes_in),
             bytes_out = MAX(bytes_out, excluded.bytes_out)`,
        )
        .bind(inst.id, month, total.bytesIn, total.bytesOut),
    );
  }
  await db.batch(statements);
}

export async function storeAgentReport(
  db: D1Database,
  instanceId: string,
  report: AgentReportPayload,
): Promise<void> {
  const { status } = report;
  await db
    .prepare(
      `INSERT INTO agent_status
         (instance_id, reported_at, received_at, process_state, metrics_json,
          service_status_json, traffic_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET
         reported_at = excluded.reported_at,
         received_at = excluded.received_at,
         process_state = excluded.process_state,
         metrics_json = COALESCE(excluded.metrics_json, agent_status.metrics_json),
         service_status_json = excluded.service_status_json,
         traffic_json = COALESCE(excluded.traffic_json, agent_status.traffic_json)
       WHERE excluded.reported_at > agent_status.reported_at`,
    )
    .bind(
      instanceId,
      report.reportedAt,
      Date.now(),
      status.processState,
      status.metrics ? JSON.stringify(status.metrics) : null,
      status.serviceStatus ? JSON.stringify(status.serviceStatus) : null,
      status.traffic ? JSON.stringify(status.traffic) : null,
    )
    .run();
}

export async function deleteAgentState(db: D1Database, instanceId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM agent_credentials WHERE instance_id = ?").bind(instanceId),
    db.prepare("DELETE FROM agent_status WHERE instance_id = ?").bind(instanceId),
    db.prepare("DELETE FROM agent_monthly_traffic WHERE instance_id = ?").bind(instanceId),
  ]);
}

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export async function readAgentStates(db: D1Database): Promise<Map<string, StoredAgentState>> {
  const results = await db.batch([
    db.prepare(
      `SELECT instance_id, reported_at, received_at, process_state,
              metrics_json, service_status_json, traffic_json
       FROM agent_status`,
    ),
    db.prepare(
      `SELECT instance_id, month, bytes_in, bytes_out
       FROM agent_monthly_traffic`,
    ),
  ]);
  const statuses = results[0] as D1Result<StatusRow>;
  const monthly = results[1] as D1Result<MonthlyRow>;
  const states = new Map<string, StoredAgentState>();
  for (const row of statuses.results) {
    states.set(row.instance_id, {
      reportedAt: row.reported_at,
      receivedAt: row.received_at,
      processState: row.process_state,
      metrics: parseJson(row.metrics_json),
      serviceStatus: parseJson(row.service_status_json),
      traffic: parseJson(row.traffic_json),
    });
  }
  for (const row of monthly.results) {
    const state = states.get(row.instance_id);
    if (!state) continue;
    (state.monthlyTraffic ??= {})[row.month] = {
      bytesIn: row.bytes_in,
      bytesOut: row.bytes_out,
    };
  }
  return states;
}

export function mergeAgentState(
  inst: Instance,
  report: StoredAgentState | undefined,
  connected: boolean,
): InstanceView {
  const { agentToken, ...base } = inst;
  const useReport = report !== undefined && report.receivedAt >= (inst.lastSeen ?? 0);
  const lastSeen = Math.max(report?.receivedAt ?? 0, inst.lastSeen ?? 0) || undefined;
  return {
    ...base,
    status: connected ? "online" : "offline",
    processState: connected
      ? useReport ? report.processState : inst.processState
      : "unknown",
    lastSeen,
    metrics: useReport && report.metrics ? { ...inst.metrics, ...report.metrics } : inst.metrics,
    serviceStatus: connected
      ? useReport ? report.serviceStatus : inst.serviceStatus
      : undefined,
    traffic: useReport ? report.traffic ?? inst.traffic : inst.traffic,
    monthlyTraffic: useReport ? report.monthlyTraffic ?? inst.monthlyTraffic : inst.monthlyTraffic,
    agentTokenPreview: agentToken.slice(0, 4) + "…",
  };
}
