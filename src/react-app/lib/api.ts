import type {
  AgentCommand,
  GlobalSettings,
  InstanceView,
  UpdateInstanceInput,
} from "@shared/types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      issues?: Array<{ message?: string }>;
    };
    const details = body.issues
      ?.map((issue) => issue.message)
      .filter(Boolean)
      .join(" ");
    const message = [body.error ?? res.statusText, details].filter(Boolean).join(": ");
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  async login(username: string, password: string): Promise<boolean> {
    const res = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    return res.ok;
  },

  async checkSession(): Promise<boolean> {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    if (!res.ok) return false;
    const body = (await res.json()) as { authenticated?: boolean };
    return body.authenticated === true;
  },

  async logout(): Promise<void> {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  },

  getSettings: () => req<{ settings: GlobalSettings }>("/api/settings"),

  updateSettings: (settings: GlobalSettings) =>
    req<{ settings: GlobalSettings }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...settings,
        defaultHeartbeatInterval: settings.defaultHeartbeatInterval ?? null,
      }),
    }),

  listInstances: () => req<{ instances: InstanceView[] }>("/api/instances"),

  updateInstance: (id: string, input: UpdateInstanceInput) =>
    req<{ instance: InstanceView }>(`/api/instances/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  deleteInstance: (id: string) =>
    req<{ ok: boolean }>(`/api/instances/${id}`, { method: "DELETE" }),

  revealToken: (id: string) =>
    req<{ agentToken: string }>(`/api/instances/${id}/reveal`),

  sendCommand: (id: string, command: AgentCommand) =>
    req<{ delivered: boolean }>(`/api/instances/${id}/command`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }),
};
