/// <reference types="@cloudflare/workers-types" />

// Cloudflare Worker entry: the rathole-manage control plane.
//
//   /api/agent/ws   — WebSocket upgrade for Rust agents (auth by instance token)
//   /api/ws         — WebSocket upgrade for browser dashboards (auth by admin token)
//   /api/instances  — REST CRUD for instances (auth by admin token)
//   everything else — static SPA assets (the shadcn panel)

import { RatholeHub } from "./hub";
import { generateConfigs, defaultConfig, validateConfig } from "@shared/config-generator";
import type {
  AgentCommand,
  CreateInstanceInput,
  Instance,
  RatholeConfig,
  UpdateInstanceInput,
} from "@shared/types";

export { RatholeHub };

interface Env {
  RATHOLE_HUB: DurableObjectNamespace<RatholeHub>;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
}

const JSON_HEADERS = { "content-type": "application/json" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

/** The whole panel is backed by one hub instance. */
function hub(env: Env): DurableObjectStub<RatholeHub> {
  return env.RATHOLE_HUB.get(env.RATHOLE_HUB.idFromName("global"));
}

function checkAdmin(req: Request, env: Env): boolean {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const url = new URL(req.url);
  const token = bearer ?? url.searchParams.get("token") ?? undefined;
  return !!token && !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

function randomToken(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newInstance(input: CreateInstanceInput): Instance {
  const now = Date.now();
  const base = defaultConfig();
  const config: RatholeConfig = {
    ...base,
    ...input.config,
    services: input.config?.services ?? [],
  };
  return {
    id: crypto.randomUUID(),
    name: input.name.trim() || "unnamed",
    publicHost: input.publicHost?.trim() || undefined,
    agentToken: randomToken(),
    config,
    status: "offline",
    processState: "unknown",
    createdAt: now,
    updatedAt: now,
  };
}

async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const stub = hub(env);

  // ---- agent WebSocket (token = instance agentToken) --------------------
  if (path === "/api/agent/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const instanceId = url.searchParams.get("instance") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const inst = await stub.getInstance(instanceId);
    if (!inst || inst.agentToken !== token) return unauthorized();
    return stub.acceptAgent(instanceId);
  }

  // ---- browser dashboard WebSocket (admin token) ------------------------
  if (path === "/api/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (!checkAdmin(req, env)) return unauthorized();
    return stub.acceptBrowser();
  }

  // Everything below requires admin auth.
  if (!checkAdmin(req, env)) return unauthorized();

  // ---- session check ----------------------------------------------------
  if (path === "/api/session" && req.method === "GET") {
    return json({ ok: true });
  }

  // ---- collection: /api/instances ---------------------------------------
  if (path === "/api/instances") {
    if (req.method === "GET") {
      return json({ instances: await stub.listInstances() });
    }
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as CreateInstanceInput;
      if (!body.name?.trim()) return json({ error: "name is required" }, 400);
      const inst = newInstance(body);
      const view = await stub.createInstance(inst);
      return json({ instance: view }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // ---- item: /api/instances/:id[/...] -----------------------------------
  const itemMatch = path.match(/^\/api\/instances\/([^/]+)(\/[^/]+)?$/);
  if (itemMatch) {
    const id = itemMatch[1];
    const sub = itemMatch[2];
    const inst = await stub.getInstance(id);
    if (!inst) return json({ error: "not found" }, 404);

    // /api/instances/:id/config → generated TOML + validation
    if (sub === "/config" && req.method === "GET") {
      const configs = generateConfigs(inst);
      return json({ ...configs, issues: validateConfig(inst.config) });
    }

    // /api/instances/:id/reveal → return the raw agent token (for setup)
    if (sub === "/reveal" && req.method === "GET") {
      return json({ agentToken: inst.agentToken });
    }

    // /api/instances/:id/command → start/stop/restart/reload
    if (sub === "/command" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { command?: AgentCommand };
      if (!body.command) return json({ error: "command required" }, 400);
      const delivered = await stub.sendCommand(id, body.command);
      return json({ delivered });
    }

    if (!sub) {
      if (req.method === "GET") {
        const view = (await stub.listInstances()).find((v) => v.id === id);
        return json({ instance: view });
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        const body = (await req.json().catch(() => ({}))) as UpdateInstanceInput;
        const updated: Instance = {
          ...inst,
          name: body.name?.trim() || inst.name,
          publicHost:
            body.publicHost !== undefined ? body.publicHost.trim() || undefined : inst.publicHost,
          config: body.config ?? inst.config,
        };
        const view = await stub.updateInstance(updated);
        return json({ instance: view });
      }
      if (req.method === "DELETE") {
        await stub.deleteInstance(id);
        return json({ ok: true });
      }
    }
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env);
      } catch (err) {
        return json({ error: (err as Error).message ?? "internal error" }, 500);
      }
    }
    // Fall through to static SPA assets.
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
