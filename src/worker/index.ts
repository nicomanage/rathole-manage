/// <reference types="@cloudflare/workers-types" />

// Cloudflare Worker entry: the rathole-manage control plane.
//
//   /api/agent/ws   — WebSocket upgrade for Rust agents (auth by instance token)
//   /api/ws         — WebSocket upgrade for browser dashboards (session cookie)
//   /api/instances  — REST CRUD for instances (session cookie)
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
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
}

const JSON_HEADERS = { "content-type": "application/json" };
const SESSION_COOKIE = "rathole_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...Object.fromEntries(new Headers(headers)) },
  });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

/** The whole panel is backed by one hub instance. */
function hub(env: Env): DurableObjectStub<RatholeHub> {
  return env.RATHOLE_HUB.get(env.RATHOLE_HUB.idFromName("global"));
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createSession(env: Env): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        username: env.ADMIN_USERNAME,
        expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env.SESSION_SECRET),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

function cookieValue(req: Request, name: string): string | undefined {
  return req.headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function checkAdmin(req: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_USERNAME || !env.SESSION_SECRET) return false;
  const session = cookieValue(req, SESSION_COOKIE);
  if (!session) return false;
  const [payload, encodedSignature, extra] = session.split(".");
  if (!payload || !encodedSignature || extra) return false;

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env.SESSION_SECRET),
      fromBase64Url(encodedSignature),
      encoder.encode(payload),
    );
    if (!valid) return false;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as {
      username?: string;
      expiresAt?: number;
    };
    return (
      parsed.username === env.ADMIN_USERNAME &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt > Date.now()
    );
  } catch {
    return false;
  }
}

async function sameSecret(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

function sessionCookie(req: Request, value: string, maxAge: number): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (new URL(req.url).protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
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

  // ---- username/password session -----------------------------------------
  if (path === "/api/login") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
      return json({ error: "admin credentials are not configured" }, 500);
    }
    const body = (await req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
    };
    const [usernameOk, passwordOk] = await Promise.all([
      sameSecret(body.username ?? "", env.ADMIN_USERNAME),
      sameSecret(body.password ?? "", env.ADMIN_PASSWORD),
    ]);
    if (!usernameOk || !passwordOk) return unauthorized();
    const session = await createSession(env);
    return json(
      { ok: true },
      200,
      { "set-cookie": sessionCookie(req, session, SESSION_TTL_SECONDS) },
    );
  }

  if (path === "/api/logout") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(req, "", 0) });
  }

  // ---- agent WebSocket (token = instance agentToken) --------------------
  if (path === "/api/agent/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const stub = hub(env);
    const instanceId = url.searchParams.get("instance") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const inst = await stub.getInstance(instanceId);
    if (!inst || inst.agentToken !== token) return unauthorized();
    return stub.fetch(req);
  }

  // ---- browser dashboard WebSocket (session cookie) ---------------------
  if (path === "/api/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (!(await checkAdmin(req, env))) return unauthorized();
    return hub(env).fetch(req);
  }

  // Everything below requires admin auth.
  if (!(await checkAdmin(req, env))) return unauthorized();

  // ---- session check ----------------------------------------------------
  if (path === "/api/session" && req.method === "GET") {
    return json({ ok: true });
  }

  const stub = hub(env);

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
