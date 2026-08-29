/// <reference types="@cloudflare/workers-types" />

// RatholeHub — a single Durable Object that is the control plane for every
// managed rathole instance. It:
//   * persists instances + configs in DO SQLite-backed storage
//   * holds hibernatable WebSocket connections from agents (on rathole boxes)
//     and from browser dashboards
//   * fans state changes out to browsers in real time
//   * pushes generated config / commands down to agents
//
// Connection roles are stored as WebSocket "tags" so we survive hibernation.

import { DurableObject } from "cloudflare:workers";
import type {
  AgentCommand,
  AgentToHub,
  BrowserToHub,
  GlobalSettings,
  HubToAgent,
  HubToBrowser,
  Instance,
  InstanceView,
  User,
  UserView,
} from "@shared/types";
import { hashServerConfig } from "./server-config";
import { accumulateMonthlyTraffic } from "./traffic";
import { mergeAgentState, readAgentStates } from "./agent-reports";

/** Result of a user mutation that can fail validation. */
export type UserMutation =
  | { ok: true; user: UserView }
  | { ok: false; status: number; error: string };

function toUserView(user: User): UserView {
  const { passwordHash, passwordSalt, passwordIterations, ...view } = user;
  void passwordHash;
  void passwordSalt;
  void passwordIterations;
  return view;
}

interface Env {
  RATHOLE_HUB: DurableObjectNamespace<RatholeHub>;
  STATUS_DB: D1Database;
  ASSETS: Fetcher;
}

/**
 * Routine status reports (lastSeen, cpu/mem, traffic counters) are persisted at
 * most this often per instance; material changes persist immediately. Keeps DO
 * storage writes far below one per report.
 */
const PERSIST_MIN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SETTINGS: GlobalSettings = {
  defaultBindAddr: "0.0.0.0:2333",
  defaultTransport: "tcp",
};
const LOG_BUFFER_LIMIT = 300;

type LogEntry = Extract<HubToBrowser, { type: "log" }>;

/** Per-agent state that must survive DO hibernation without a storage write. */
type AgentSocketAttachment = {
  lastStatusAt?: number;
  traffic?: Instance["traffic"];
  monthlyTraffic?: Instance["monthlyTraffic"];
};

function desiredStateForCommand(command: AgentCommand): Instance["desiredProcessState"] | undefined {
  switch (command) {
    case "stop":
      return "stopped";
    case "start":
    case "restart":
    case "reload":
      return "running";
    case "status":
    case "renew_certificate":
      return undefined;
  }
}

/** Strip the agent token before sending an instance to a browser. */
function toView(inst: Instance): InstanceView {
  const { agentToken, ...rest } = inst;
  return { ...rest, agentTokenPreview: agentToken.slice(0, 4) + "…" };
}

/**
 * Fingerprint of the state a status report may change that is worth persisting
 * immediately. Anything else (lastSeen, cpu/mem, traffic counters) only reaches
 * storage on the PERSIST_MIN_INTERVAL_MS schedule.
 */
function materialKey(inst: Instance): string {
  return JSON.stringify([
    inst.status,
    inst.processState,
    inst.serviceStatus
      ? Object.entries(inst.serviceStatus).sort(([a], [b]) => a.localeCompare(b))
      : null,
    inst.metrics?.agentVersion ?? null,
    inst.metrics?.ratholeVersion ?? null,
    inst.metrics?.hostname ?? null,
    inst.metrics?.configInSync ?? null,
    inst.certificate?.state ?? null,
    inst.certificate?.notAfter ?? null,
    inst.certificate?.error ?? null,
    inst.certificate?.staging ?? null,
    inst.certificate?.domains ?? null,
    inst.lastError ?? null,
  ]);
}

export class RatholeHub extends DurableObject<Env> {
  private instances = new Map<string, Instance>();
  private users = new Map<string, User>();
  private logBuffers = new Map<string, LogEntry[]>();
  private settings: GlobalSettings = { ...DEFAULT_SETTINGS };
  private loaded = false;
  /** In-memory liveness (not persisted); reseeded with a grace period after hibernation. */
  private lastStatusAt = new Map<string, number>();
  /** Last storage write per instance, for throttling routine status persists. */
  private lastPersistAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const [stored, settings, users] = await Promise.all([
        ctx.storage.list<Instance>({ prefix: "instance:" }),
        ctx.storage.get<GlobalSettings>("settings:global"),
        ctx.storage.list<User>({ prefix: "user:" }),
      ]);
      for (const inst of stored.values()) {
        this.instances.set(inst.id, inst);
        this.lastPersistAt.set(inst.id, inst.updatedAt);
      }
      for (const user of users.values()) this.users.set(user.id, user);
      if (settings) {
        this.settings = {
          defaultBindAddr: settings.defaultBindAddr ?? DEFAULT_SETTINGS.defaultBindAddr,
          defaultTransport: settings.defaultTransport ?? DEFAULT_SETTINGS.defaultTransport,
          defaultHeartbeatInterval: settings.defaultHeartbeatInterval,
        };
      }
      const wakeAt = Date.now();
      for (const ws of ctx.getWebSockets()) {
        const role = ctx.getTags(ws)[0] ?? "";
        if (!role.startsWith("agent:")) continue;
        const inst = this.instances.get(role.slice("agent:".length));
        if (!inst) continue;
        const attachment = this.agentAttachment(ws);
        if (attachment?.lastStatusAt !== undefined) {
          this.restoreAgentAttachment(inst, attachment);
        } else {
          // Existing sockets from before attachments were introduced get one
          // grace window, recorded on the socket so it cannot reset each wake.
          this.lastStatusAt.set(inst.id, wakeAt);
          try { ws.serializeAttachment({ lastStatusAt: wakeAt } satisfies AgentSocketAttachment); } catch { /* ignore */ }
        }
      }
      this.loaded = true;
    });
  }

  // ---- persistence helpers ------------------------------------------------

  private async persist(inst: Instance) {
    inst.updatedAt = Date.now();
    this.instances.set(inst.id, inst);
    this.lastPersistAt.set(inst.id, inst.updatedAt);
    await this.ctx.storage.put(`instance:${inst.id}`, inst);
  }

  private agentAttachment(ws: WebSocket): AgentSocketAttachment | null {
    return ws.deserializeAttachment() as AgentSocketAttachment | null;
  }

  private restoreAgentAttachment(inst: Instance, attachment: AgentSocketAttachment): void {
    const seen = attachment.lastStatusAt;
    if (seen === undefined || !Number.isFinite(seen)) return;
    const knownSeen = this.lastStatusAt.get(inst.id) ?? 0;
    if (seen > knownSeen) this.lastStatusAt.set(inst.id, seen);
    if (seen <= (inst.lastSeen ?? 0)) return;
    inst.lastSeen = seen;
    if (attachment.traffic !== undefined) inst.traffic = attachment.traffic;
    if (attachment.monthlyTraffic !== undefined) inst.monthlyTraffic = attachment.monthlyTraffic;
  }

  /** Mirror unpersisted traffic/liveness onto every socket so it survives hibernation. */
  private attachAgentState(instanceId: string, inst: Instance, includeTraffic: boolean): boolean {
    const attachment: AgentSocketAttachment = {
      lastStatusAt: this.lastStatusAt.get(instanceId),
      ...(includeTraffic ? { traffic: inst.traffic, monthlyTraffic: inst.monthlyTraffic } : {}),
    };
    try {
      for (const ws of this.ctx.getWebSockets(`agent:${instanceId}`)) {
        ws.serializeAttachment(attachment);
      }
      return true;
    } catch {
      // Attachments are size-limited. The caller falls back to a storage write.
      return false;
    }
  }

  private async remove(id: string) {
    this.instances.delete(id);
    await this.ctx.storage.delete(`instance:${id}`);
    this.broadcastBrowsers({ type: "instance_removed", instanceId: id });
  }

  // ---- public API used by the Worker fetch handler ------------------------

  async listInstances(): Promise<InstanceView[]> {
    let reports = new Map();
    try {
      reports = await readAgentStates(this.env.STATUS_DB);
    } catch (error) {
      // Keep the control plane usable while a new deployment is waiting for its
      // D1 migration. Agent report ingestion will surface that setup error.
      console.error("could not read agent status from D1", error);
    }
    return [...this.instances.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((inst) => mergeAgentState(
        inst,
        reports.get(inst.id),
        this.ctx.getWebSockets(`agent:${inst.id}`).length > 0,
      ));
  }

  async getInstance(id: string): Promise<Instance | undefined> {
    return this.instances.get(id);
  }

  /** Record the public IP the agent connects from (used as a client host fallback). */
  async recordAgentIp(id: string, ip: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst || inst.publicIp === ip) return;
    inst.publicIp = ip;
    await this.persist(inst);
    this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
  }

  /** Find an instance previously enrolled by the given node id (for idempotent re-enroll). */
  async findInstanceByNodeId(nodeId: string): Promise<Instance | undefined> {
    for (const inst of this.instances.values()) {
      if (inst.enrollNodeId && inst.enrollNodeId === nodeId) return inst;
    }
    return undefined;
  }

  async getSettings(): Promise<GlobalSettings> {
    return { ...this.settings };
  }

  async updateSettings(settings: GlobalSettings): Promise<GlobalSettings> {
    this.settings = { ...settings };
    await this.ctx.storage.put("settings:global", this.settings);
    return { ...this.settings };
  }

  // ---- users --------------------------------------------------------------
  // These run inside the single-threaded DO, so check-then-write is atomic.

  async listUsers(): Promise<UserView[]> {
    return [...this.users.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toUserView);
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const wanted = username.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.username.toLowerCase() === wanted) return user;
    }
    return undefined;
  }

  private async putUser(user: User) {
    this.users.set(user.id, user);
    await this.ctx.storage.put(`user:${user.id}`, user);
  }

  /** Seed the first admin only when there are no users yet. */
  async bootstrapAdmin(user: User): Promise<boolean> {
    if (this.users.size > 0) return false;
    await this.putUser(user);
    return true;
  }

  async createUser(user: User): Promise<UserMutation> {
    if (await this.getUserByUsername(user.username)) {
      return { ok: false, status: 409, error: "username already exists" };
    }
    await this.putUser(user);
    return { ok: true, user: toUserView(user) };
  }

  async updateUser(
    id: string,
    patch: { role?: User["role"]; password?: import("./passwords").PasswordFields },
  ): Promise<UserMutation> {
    const user = this.users.get(id);
    if (!user) return { ok: false, status: 404, error: "user not found" };

    // Guard against demoting the last admin.
    if (patch.role && patch.role !== "admin" && user.role === "admin") {
      const admins = [...this.users.values()].filter((u) => u.role === "admin");
      if (admins.length <= 1) {
        return { ok: false, status: 400, error: "cannot demote the last admin" };
      }
    }

    const next: User = {
      ...user,
      role: patch.role ?? user.role,
      ...(patch.password ?? {}),
      updatedAt: Date.now(),
    };
    await this.putUser(next);
    return { ok: true, user: toUserView(next) };
  }

  async deleteUser(id: string): Promise<UserMutation> {
    const user = this.users.get(id);
    if (!user) return { ok: false, status: 404, error: "user not found" };
    if (user.role === "admin") {
      const admins = [...this.users.values()].filter((u) => u.role === "admin");
      if (admins.length <= 1) {
        return { ok: false, status: 400, error: "cannot delete the last admin" };
      }
    }
    this.users.delete(id);
    await this.ctx.storage.delete(`user:${id}`);
    return { ok: true, user: toUserView(user) };
  }

  async createInstance(inst: Instance): Promise<InstanceView> {
    await this.persist(inst);
    const view = toView(inst);
    this.broadcastBrowsers({ type: "instance_update", instance: view });
    return view;
  }

  async updateInstance(inst: Instance): Promise<InstanceView> {
    await this.persist(inst);
    const view = toView(inst);
    this.broadcastBrowsers({ type: "instance_update", instance: view });
    // Push fresh config to a connected agent, if any.
    this.pushConfig(inst);
    return view;
  }

  async deleteInstance(id: string): Promise<void> {
    // Close any agent socket for this instance.
    for (const ws of this.ctx.getWebSockets(`agent:${id}`)) {
      try { ws.close(1000, "instance deleted"); } catch { /* ignore */ }
    }
    await this.remove(id);
  }

  async sendCommand(id: string, command: AgentCommand): Promise<boolean> {
    const sockets = this.ctx.getWebSockets(`agent:${id}`);
    if (sockets.length === 0) return false;
    const inst = this.instances.get(id);
    if (!inst) return false;
    const desiredProcessState = desiredStateForCommand(command);
    if (desiredProcessState && inst.desiredProcessState !== desiredProcessState) {
      inst.desiredProcessState = desiredProcessState;
      await this.persist(inst);
      this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
    }
    const msg: HubToAgent = { type: "command", command };
    for (const ws of sockets) this.safeSend(ws, msg);
    return true;
  }

  // ---- WebSocket entrypoints ---------------------------------------------

  /**
   * WebSocket upgrade responses must travel through the Durable Object fetch
   * handler so the client side of the pair reaches the original request.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/ws") return this.acceptBrowser();
    if (url.pathname === "/api/agent/ws") {
      return this.acceptAgent(url.searchParams.get("instance") ?? "");
    }
    return new Response("not found", { status: 404 });
  }

  /** Upgrade an agent connection. `role` tag = agent:<instanceId>. */
  private async acceptAgent(instanceId: string): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`agent:${instanceId}`]);
    const now = Date.now();
    this.lastStatusAt.set(instanceId, now);
    const inst = this.instances.get(instanceId);
    if (inst && !this.attachAgentState(instanceId, inst, true)) {
      await this.persist(inst);
      this.attachAgentState(instanceId, inst, false);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Upgrade a browser dashboard connection. */
  private acceptBrowser(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["browser"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- hibernation handlers ----------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.loaded) return;
    const tags = this.ctx.getTags(ws);
    const role = tags[0] ?? "";
    let data: unknown;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (role.startsWith("agent:")) {
      await this.handleAgentMessage(ws, role.slice("agent:".length), data as AgentToHub);
    } else if (role === "browser") {
      await this.handleBrowserMessage(ws, data as BrowserToHub);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const role = tags[0] ?? "";
    if (role.startsWith("agent:")) {
      const id = role.slice("agent:".length);
      const inst = this.instances.get(id);
      if (inst) this.restoreAgentAttachment(inst, this.agentAttachment(ws) ?? {});
      const anotherAgentSocket = this.ctx
        .getWebSockets(`agent:${id}`)
        .some((other) => other !== ws);
      if (inst && !anotherAgentSocket) {
        this.lastStatusAt.delete(id);
        inst.status = "offline";
        inst.processState = "unknown";
        inst.serviceStatus = undefined;
        inst.certificate = undefined;
        inst.lastError = undefined;
        await this.persist(inst);
        this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, "socket error"); } catch { /* ignore */ }
  }

  async alarm(): Promise<void> {
    // Kept only so alarms scheduled by an older deployment drain harmlessly.
    // Status freshness now comes from D1 when the panel reads instance state.
  }

  // ---- message handling ---------------------------------------------------

  private async handleAgentMessage(ws: WebSocket, instanceId: string, msg: AgentToHub) {
    const inst = this.instances.get(instanceId);
    if (!inst) {
      this.safeSend(ws, { type: "error", message: "unknown instance" });
      return;
      }
      switch (msg.type) {
      case "register": {
        if (msg.token !== inst.agentToken) {
          this.safeSend(ws, { type: "error", message: "bad token" });
          try { ws.close(1008, "unauthorized"); } catch { /* ignore */ }
          return;
        }
        inst.status = "online";
        inst.lastSeen = Date.now();
        this.lastStatusAt.set(instanceId, inst.lastSeen);
        inst.metrics = { ...inst.metrics, agentVersion: msg.agentVersion, hostname: msg.hostname };
        inst.desiredProcessState ??= "running";
        await this.persist(inst);
        this.attachAgentState(instanceId, inst, false);
        this.pushLog({
          type: "log",
          instanceId,
          line: `[hub] agent registered${msg.hostname ? ` from ${msg.hostname}` : ""}`,
          ts: Date.now(),
        });
        this.safeSend(ws, { type: "registered", instanceId, name: inst.name } satisfies HubToAgent);
        this.pushConfig(inst, ws);
        this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
        break;
      }
      case "status": {
        const now = Date.now();
        const before = materialKey(inst);
        inst.status = "online";
        inst.lastSeen = now;
        this.lastStatusAt.set(instanceId, now);
        inst.processState = msg.processState;
        if (msg.metrics) inst.metrics = { ...inst.metrics, ...msg.metrics };
        inst.serviceStatus = msg.serviceStatus;
        // Assigned unconditionally, like serviceStatus: an agent that omits it
        // (Let's Encrypt switched off) means "no certificate", not "unchanged".
        inst.certificate = msg.certificate;
        inst.lastError = msg.error;
        if (msg.traffic) {
          // Fold the delta into this month's total before overwriting the snapshot.
          // The latest snapshot/accounting state is mirrored in the WebSocket
          // attachment, so hibernation cannot make a later counter reset lose
          // bytes that were already reported but not yet written to storage.
          accumulateMonthlyTraffic(inst, msg.traffic);
          inst.traffic = msg.traffic;
        }
        // Persist material changes immediately; routine drift (lastSeen, cpu/mem,
        // traffic counters) only every PERSIST_MIN_INTERVAL_MS per instance.
        const lastPersist = this.lastPersistAt.get(instanceId) ?? 0;
        let persisted = false;
        if (materialKey(inst) !== before || now - lastPersist >= PERSIST_MIN_INTERVAL_MS) {
          await this.persist(inst);
          persisted = true;
        } else {
          this.instances.set(inst.id, inst);
        }
        if (!this.attachAgentState(instanceId, inst, !persisted)) {
          // A large service set can exceed the attachment limit. Preserve exact
          // accounting by writing this report instead of dropping the checkpoint.
          if (!persisted) await this.persist(inst);
          this.attachAgentState(instanceId, inst, false);
        }
        this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
        break;
      }
      case "log": {
        this.pushLog({
          type: "log",
          instanceId,
          line: msg.line,
          stream: msg.stream,
          ts: msg.ts ?? Date.now(),
        });
        break;
      }
      case "config_ack": {
        if (inst.metrics) inst.metrics.configInSync = msg.ok;
        else inst.metrics = { configInSync: msg.ok };
        await this.persist(inst);
        this.pushLog({
          type: "log",
          instanceId,
          line: `[hub] config ${msg.ok ? "applied" : `failed: ${msg.error ?? "unknown error"}`}`,
          ts: Date.now(),
        });
        this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
        break;
      }
      case "pong":
        inst.lastSeen = Date.now();
        this.lastStatusAt.set(instanceId, inst.lastSeen);
        if (!this.attachAgentState(instanceId, inst, true)) {
          await this.persist(inst);
          this.attachAgentState(instanceId, inst, false);
        }
        break;
      case "command_result":
        this.pushLog({
          type: "log",
          instanceId,
          line: `[agent] command ${msg.command} → ${msg.ok ? "ok" : "failed: " + msg.error}`,
          ts: Date.now(),
        });
        break;
    }
  }

  private async handleBrowserMessage(ws: WebSocket, msg: BrowserToHub) {
    switch (msg.type) {
      case "subscribe_logs":
        this.ctx.getTags(ws); // no-op; tags fixed at accept. Track via attachment.
        this.attachLogSub(ws, msg.instanceId, true);
        for (const entry of this.logBuffers.get(msg.instanceId) ?? []) this.safeSend(ws, entry);
        break;
      case "unsubscribe_logs":
        this.attachLogSub(ws, msg.instanceId, false);
        break;
    }
  }

  // Track which instance's logs a browser wants via serializable attachment.
  private attachLogSub(ws: WebSocket, instanceId: string, on: boolean) {
    const att = (ws.deserializeAttachment() as { logs?: string[] } | null) ?? {};
    const set = new Set(att.logs ?? []);
    if (on) set.add(instanceId);
    else set.delete(instanceId);
    ws.serializeAttachment({ ...att, logs: [...set] });
  }

  // ---- fan-out ------------------------------------------------------------

  private pushConfig(inst: Instance, only?: WebSocket) {
    const configHash = hashServerConfig(JSON.stringify(inst.config));
    const services = inst.config.services.map((s) => ({ name: s.name, bindAddr: s.bindAddr }));
    const desiredProcessState = inst.desiredProcessState ?? "running";
    const msg: HubToAgent = {
      type: "apply_config",
      config: inst.config,
      configHash,
      services,
      desiredProcessState,
    };
    const targets = only ? [only] : this.ctx.getWebSockets(`agent:${inst.id}`);
    this.pushLog({
      type: "log",
      instanceId: inst.id,
      line: `[hub] pushing config ${configHash} (${services.length} services)`,
      ts: Date.now(),
    });
    for (const ws of targets) this.safeSend(ws, msg);
  }

  private broadcastBrowsers(msg: HubToBrowser) {
    for (const ws of this.ctx.getWebSockets("browser")) this.safeSend(ws, msg);
  }

  private pushLog(msg: LogEntry) {
    const buffer = this.logBuffers.get(msg.instanceId) ?? [];
    buffer.push(msg);
    if (buffer.length > LOG_BUFFER_LIMIT) buffer.splice(0, buffer.length - LOG_BUFFER_LIMIT);
    this.logBuffers.set(msg.instanceId, buffer);
    this.broadcastLogs(msg.instanceId, msg);
  }

  private broadcastLogs(instanceId: string, msg: HubToBrowser) {
    for (const ws of this.ctx.getWebSockets("browser")) {
      const att = ws.deserializeAttachment() as { logs?: string[] } | null;
      if (att?.logs?.includes(instanceId)) this.safeSend(ws, msg);
    }
  }

  private safeSend(ws: WebSocket, msg: HubToBrowser | HubToAgent) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing; ignore */
    }
  }
}
