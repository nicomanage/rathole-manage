/// <reference types="@cloudflare/workers-types" />

// Cloudflare Worker entry: the rathole-manage control plane.
//
//   /api/agent/ws   — WebSocket upgrade for Rust agents (auth by instance token)
//   /api/ws         — WebSocket upgrade for browser dashboards (session cookie)
//   /api/instances  — REST CRUD for instances (session cookie)
//   everything else — static SPA assets (the shadcn panel)

import { RatholeHub } from "./hub";
import { defaultConfig, validateConfig } from "@shared/config-generator";
import { hashPassword, verifyPassword } from "./passwords";
import type {
  AgentCommand,
  CreateInstanceInput,
  CreateUserInput,
  EnrollInput,
  GlobalSettings,
  Instance,
  RatholeConfig,
  Role,
  UpdateInstanceInput,
  UpdateUserInput,
  User,
} from "@shared/types";

export { RatholeHub };

interface Env {
  RATHOLE_HUB: DurableObjectNamespace<RatholeHub>;
  ASSETS: Fetcher;
  /** Bootstrap admin — seeds the first user if none exist yet. */
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
}

const MIN_PASSWORD_LENGTH = 8;
const ROLES: Role[] = ["admin", "viewer"];

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

async function createSession(env: Env, username: string): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        username,
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

/** Verify the session cookie and return the signed-in username, if valid. */
async function sessionUsername(req: Request, env: Env): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const session = cookieValue(req, SESSION_COOKIE);
  if (!session) return null;
  const [payload, encodedSignature, extra] = session.split(".");
  if (!payload || !encodedSignature || extra) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env.SESSION_SECRET),
      fromBase64Url(encodedSignature),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as {
      username?: string;
      expiresAt?: number;
    };
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) return null;
    return parsed.username ?? null;
  } catch {
    return null;
  }
}

/** Resolve the authenticated user (fresh from storage, so role changes apply). */
async function authenticate(
  req: Request,
  env: Env,
  stub: DurableObjectStub<RatholeHub>,
): Promise<User | null> {
  const username = await sessionUsername(req, env);
  if (!username) return null;
  return (await stub.getUserByUsername(username)) ?? null;
}

/** Seed the first admin from env credentials when the user store is empty. */
async function ensureBootstrap(env: Env, stub: DurableObjectStub<RatholeHub>): Promise<void> {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) return;
  if ((await stub.countUsers()) > 0) return;
  const now = Date.now();
  await stub.bootstrapAdmin({
    id: crypto.randomUUID(),
    username: env.ADMIN_USERNAME,
    ...(await hashPassword(env.ADMIN_PASSWORD)),
    role: "admin",
    createdAt: now,
    updatedAt: now,
  });
}

function forbidden(): Response {
  return json({ error: "forbidden" }, 403);
}

function validateUsername(username: string | undefined): string | null {
  const u = username?.trim() ?? "";
  if (u.length < 1 || u.length > 64) return null;
  if (!/^[A-Za-z0-9._@-]+$/.test(u)) return null;
  return u;
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

function newInstance(
  input: CreateInstanceInput,
  settings: GlobalSettings,
  enrollNodeId?: string,
): Instance {
  const now = Date.now();
  const base: RatholeConfig = {
    ...defaultConfig(),
    bindAddr: settings.defaultBindAddr,
    defaultToken: randomToken(),
    transport: settings.defaultTransport,
    heartbeatInterval: settings.defaultHeartbeatInterval,
  };
  const config: RatholeConfig = {
    ...base,
    ...input.config,
    services: input.config?.services ?? [],
  };
  if (!config.defaultToken?.trim()) config.defaultToken = randomToken();
  return {
    id: crypto.randomUUID(),
    name: input.name.trim() || "unnamed",
    publicHost: input.publicHost?.trim() || undefined,
    agentToken: randomToken(),
    enrollNodeId,
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

  // ---- username/password session -----------------------------------------
  if (path === "/api/login") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!env.SESSION_SECRET) {
      return json({ error: "SESSION_SECRET is not configured" }, 500);
    }
    await ensureBootstrap(env, stub);
    const body = (await req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
    };
    const user = await stub.getUserByUsername(body.username ?? "");
    const ok = user ? await verifyPassword(body.password ?? "", user) : false;
    if (!user || !ok) return unauthorized();
    const session = await createSession(env, user.username);
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

  // Session probing is expected before login, so report state in the body
  // instead of generating a noisy 401 in the browser console.
  if (path === "/api/session" && req.method === "GET") {
    const user = await authenticate(req, env, stub);
    return json(
      user ? { authenticated: true, username: user.username, role: user.role } : { authenticated: false },
    );
  }

  // ---- agent self-enrollment --------------------------------------------
  // Lets an agent create (or idempotently reclaim) its own instance without an
  // operator pre-creating it in the panel. Authorized by an admin session
  // cookie the agent obtains from its TUI login.
  if (path === "/api/agent/enroll") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const actor = await authenticate(req, env, stub);
    if (!actor) return unauthorized();
    if (actor.role !== "admin") return forbidden();

    const body = (await req.json().catch(() => ({}))) as Partial<EnrollInput>;
    const nodeId = body.nodeId?.trim();
    if (!nodeId) return json({ error: "nodeId is required" }, 400);

    const existing = await stub.findInstanceByNodeId(nodeId);
    if (existing) {
      // Idempotent: same node re-enrolling reclaims its existing credentials.
      return json({
        instanceId: existing.id,
        agentToken: existing.agentToken,
        name: existing.name,
        created: false,
      });
    }

    const name = body.name?.trim() || `node-${nodeId.slice(0, 8)}`;
    const inst = newInstance(
      { name, publicHost: body.publicHost?.trim() || undefined },
      await stub.getSettings(),
      nodeId,
    );
    const issues = validateConfig(inst.config);
    if (issues.length > 0) return json({ error: "invalid configuration", issues }, 400);
    await stub.createInstance(inst);
    return json(
      { instanceId: inst.id, agentToken: inst.agentToken, name: inst.name, created: true },
      201,
    );
  }

  // ---- agent WebSocket (token = instance agentToken) --------------------
  if (path === "/api/agent/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
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
    if (!(await authenticate(req, env, stub))) return unauthorized();
    return stub.fetch(req);
  }

  // Everything below requires an authenticated user; mutations require admin.
  const user = await authenticate(req, env, stub);
  if (!user) return unauthorized();
  const isAdmin = user.role === "admin";

  // ---- current user -------------------------------------------------------
  if (path === "/api/me" && req.method === "GET") {
    return json({ username: user.username, role: user.role });
  }

  // ---- change own password ------------------------------------------------
  if (path === "/api/account/password") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = (await req.json().catch(() => ({}))) as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!(await verifyPassword(body.currentPassword ?? "", user))) {
      return json({ error: "current password is incorrect" }, 400);
    }
    if ((body.newPassword ?? "").length < MIN_PASSWORD_LENGTH) {
      return json({ error: `new password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
    }
    const res = await stub.updateUser(user.id, { password: await hashPassword(body.newPassword!) });
    if (!res.ok) return json({ error: res.error }, res.status);
    return json({ ok: true });
  }

  // ---- user management (admin only) --------------------------------------
  if (path === "/api/users") {
    if (!isAdmin) return forbidden();
    if (req.method === "GET") {
      return json({ users: await stub.listUsers() });
    }
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Partial<CreateUserInput>;
      const username = validateUsername(body.username);
      if (!username) return json({ error: "invalid username" }, 400);
      if ((body.password ?? "").length < MIN_PASSWORD_LENGTH) {
        return json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
      }
      if (!body.role || !ROLES.includes(body.role)) return json({ error: "invalid role" }, 400);
      const now = Date.now();
      const created: User = {
        id: crypto.randomUUID(),
        username,
        ...(await hashPassword(body.password!)),
        role: body.role,
        createdAt: now,
        updatedAt: now,
      };
      const res = await stub.createUser(created);
      if (!res.ok) return json({ error: res.error }, res.status);
      return json({ user: res.user }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    if (!isAdmin) return forbidden();
    const targetId = userMatch[1];
    if (req.method === "PATCH" || req.method === "PUT") {
      const body = (await req.json().catch(() => ({}))) as UpdateUserInput;
      const patch: { role?: Role; password?: Awaited<ReturnType<typeof hashPassword>> } = {};
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return json({ error: "invalid role" }, 400);
        patch.role = body.role;
      }
      if (body.password !== undefined) {
        if (body.password.length < MIN_PASSWORD_LENGTH) {
          return json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
        }
        patch.password = await hashPassword(body.password);
      }
      const res = await stub.updateUser(targetId, patch);
      if (!res.ok) return json({ error: res.error }, res.status);
      return json({ user: res.user });
    }
    if (req.method === "DELETE") {
      if (targetId === user.id) return json({ error: "you cannot delete your own account" }, 400);
      const res = await stub.deleteUser(targetId);
      if (!res.ok) return json({ error: res.error }, res.status);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // ---- global defaults ---------------------------------------------------
  if (path === "/api/settings") {
    if (req.method === "GET") {
      return json({ settings: await stub.getSettings() });
    }
    if (req.method === "PUT") {
      if (!isAdmin) return forbidden();
      const current = await stub.getSettings();
      const body = (await req.json().catch(() => ({}))) as Omit<
        Partial<GlobalSettings>,
        "defaultHeartbeatInterval"
      > & { defaultHeartbeatInterval?: number | null };
      const next: GlobalSettings = {
        defaultBindAddr:
          body.defaultBindAddr !== undefined
            ? body.defaultBindAddr.trim()
            : current.defaultBindAddr,
        defaultTransport: body.defaultTransport ?? current.defaultTransport,
        defaultHeartbeatInterval:
          body.defaultHeartbeatInterval === null
            ? undefined
            : body.defaultHeartbeatInterval ?? current.defaultHeartbeatInterval,
      };
      if (!["tcp", "tls", "noise", "websocket"].includes(next.defaultTransport)) {
        return json({ error: "invalid default transport" }, 400);
      }
      if (
        next.defaultHeartbeatInterval !== undefined &&
        (!Number.isFinite(next.defaultHeartbeatInterval) || next.defaultHeartbeatInterval <= 0)
      ) {
        return json({ error: "heartbeat interval must be greater than zero" }, 400);
      }
      const issues = validateConfig({
        ...defaultConfig(),
        bindAddr: next.defaultBindAddr,
        transport: next.defaultTransport,
        heartbeatInterval: next.defaultHeartbeatInterval,
      });
      if (issues.length > 0) {
        return json({ error: "invalid global settings", issues }, 400);
      }
      return json({ settings: await stub.updateSettings(next) });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // ---- collection: /api/instances ---------------------------------------
  // Instances are created only via agent self-enrollment (/api/agent/enroll);
  // the panel lists and manages them but does not create them manually.
  if (path === "/api/instances") {
    if (req.method === "GET") {
      return json({ instances: await stub.listInstances() });
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

    // /api/instances/:id/reveal → return the raw agent token (for setup)
    if (sub === "/reveal" && req.method === "GET") {
      if (!isAdmin) return forbidden();
      return json({ agentToken: inst.agentToken });
    }

    // /api/instances/:id/command → start/stop/restart/reload
    if (sub === "/command" && req.method === "POST") {
      if (!isAdmin) return forbidden();
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
        if (!isAdmin) return forbidden();
        const body = (await req.json().catch(() => ({}))) as UpdateInstanceInput;
        const updated: Instance = {
          ...inst,
          name: body.name?.trim() || inst.name,
          publicHost:
            body.publicHost !== undefined ? body.publicHost.trim() || undefined : inst.publicHost,
          config: body.config ?? inst.config,
        };
        const issues = validateConfig(updated.config);
        if (issues.length > 0) {
          return json({ error: "invalid configuration", issues }, 400);
        }
        const view = await stub.updateInstance(updated);
        return json({ instance: view });
      }
      if (req.method === "DELETE") {
        if (!isAdmin) return forbidden();
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
