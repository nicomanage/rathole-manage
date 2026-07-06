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
  HubToAgent,
  HubToBrowser,
  Instance,
  InstanceView,
} from "@shared/types";
import { generateServerToml, hashConfig } from "@shared/config-generator";

interface Env {
  RATHOLE_HUB: DurableObjectNamespace<RatholeHub>;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
}

const OFFLINE_AFTER_MS = 45_000;

/** Strip the agent token before sending an instance to a browser. */
function toView(inst: Instance): InstanceView {
  const { agentToken, ...rest } = inst;
  return { ...rest, agentTokenPreview: agentToken.slice(0, 4) + "…" };
}

export class RatholeHub extends DurableObject<Env> {
  private instances = new Map<string, Instance>();
  private loaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.list<Instance>({ prefix: "instance:" });
      for (const inst of stored.values()) this.instances.set(inst.id, inst);
      this.loaded = true;
      // Re-evaluate liveness periodically via alarm.
      const alarm = await ctx.storage.getAlarm();
      if (alarm === null) await ctx.storage.setAlarm(Date.now() + OFFLINE_AFTER_MS);
    });
  }

  // ---- persistence helpers ------------------------------------------------

  private async persist(inst: Instance) {
    inst.updatedAt = Date.now();
    this.instances.set(inst.id, inst);
    await this.ctx.storage.put(`instance:${inst.id}`, inst);
  }

  private async remove(id: string) {
    this.instances.delete(id);
    await this.ctx.storage.delete(`instance:${id}`);
    this.broadcastBrowsers({ type: "instance_removed", instanceId: id });
  }

  // ---- public API used by the Worker fetch handler ------------------------

  async listInstances(): Promise<InstanceView[]> {
    return [...this.instances.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toView);
  }

  async getInstance(id: string): Promise<Instance | undefined> {
    return this.instances.get(id);
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
    const msg: HubToAgent = { type: "command", command };
    for (const ws of sockets) this.safeSend(ws, msg);
    return true;
  }

  // ---- WebSocket entrypoints ---------------------------------------------

  /** Upgrade an agent connection. `role` tag = agent:<instanceId>. */
  async acceptAgent(instanceId: string): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`agent:${instanceId}`]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Upgrade a browser dashboard connection. */
  async acceptBrowser(): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["browser"]);
    // Send an initial snapshot once connected.
    this.safeSend(server, { type: "snapshot", instances: [...this.instances.values()].map(toView) });
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
      if (inst && this.ctx.getWebSockets(`agent:${id}`).length <= 1) {
        inst.status = "offline";
        inst.processState = "unknown";
        await this.persist(inst);
        this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, "socket error"); } catch { /* ignore */ }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const inst of this.instances.values()) {
      const stale = !inst.lastSeen || now - inst.lastSeen > OFFLINE_AFTER_MS;
      const connected = this.ctx.getWebSockets(`agent:${inst.id}`).length > 0;
      const next: Instance["status"] = connected && !stale ? "online" : "offline";
      if (next !== inst.status) {
        inst.status = next;
        if (next === "offline") inst.processState = "unknown";
        await this.persist(inst);
        this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
      }
    }
    await this.ctx.storage.setAlarm(now + OFFLINE_AFTER_MS);
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
        inst.metrics = { ...inst.metrics, agentVersion: msg.agentVersion, hostname: msg.hostname };
        await this.persist(inst);
        this.safeSend(ws, { type: "registered", instanceId, name: inst.name } satisfies HubToAgent);
        this.pushConfig(inst, ws);
        this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
        break;
      }
      case "status": {
        inst.status = "online";
        inst.lastSeen = Date.now();
        inst.processState = msg.processState;
        if (msg.metrics) inst.metrics = { ...inst.metrics, ...msg.metrics };
        await this.persist(inst);
        this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
        break;
      }
      case "log": {
        this.broadcastLogs(instanceId, {
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
        this.broadcastBrowsers({ type: "instance_update", instance: toView(inst) });
        break;
      }
      case "pong":
        inst.lastSeen = Date.now();
        break;
      case "command_result":
        this.broadcastLogs(instanceId, {
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
      case "subscribe":
        this.safeSend(ws, {
          type: "snapshot",
          instances: [...this.instances.values()].map(toView),
        });
        break;
      case "subscribe_logs":
        this.ctx.getTags(ws); // no-op; tags fixed at accept. Track via attachment.
        this.attachLogSub(ws, msg.instanceId, true);
        break;
      case "unsubscribe_logs":
        this.attachLogSub(ws, msg.instanceId, false);
        break;
      case "command": {
        const inst = this.instances.get(msg.instanceId);
        if (!inst) return;
        const ok = await this.sendCommand(msg.instanceId, msg.command);
        if (!ok) this.safeSend(ws, { type: "error", message: "agent offline" });
        break;
      }
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
    const toml = generateServerToml(inst.config, inst.name);
    const configHash = hashConfig(toml);
    const msg: HubToAgent = { type: "apply_config", toml, configHash };
    const targets = only ? [only] : this.ctx.getWebSockets(`agent:${inst.id}`);
    for (const ws of targets) this.safeSend(ws, msg);
  }

  private broadcastBrowsers(msg: HubToBrowser) {
    for (const ws of this.ctx.getWebSockets("browser")) this.safeSend(ws, msg);
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
