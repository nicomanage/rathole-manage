import type {
  CreateInstanceInput,
  GeneratedConfigs,
  InstanceView,
  UpdateInstanceInput,
} from "@shared/types";
import type { ValidationIssue } from "@shared/config-generator";

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
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
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
    return res.ok;
  },

  async logout(): Promise<void> {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  },

  listInstances: () => req<{ instances: InstanceView[] }>("/api/instances"),

  createInstance: (input: CreateInstanceInput) =>
    req<{ instance: InstanceView }>("/api/instances", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateInstance: (id: string, input: UpdateInstanceInput) =>
    req<{ instance: InstanceView }>(`/api/instances/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  deleteInstance: (id: string) =>
    req<{ ok: boolean }>(`/api/instances/${id}`, { method: "DELETE" }),

  getConfig: (id: string) =>
    req<GeneratedConfigs & { issues: ValidationIssue[] }>(`/api/instances/${id}/config`),

  revealToken: (id: string) =>
    req<{ agentToken: string }>(`/api/instances/${id}/reveal`),

  sendCommand: (id: string, command: string) =>
    req<{ delivered: boolean }>(`/api/instances/${id}/command`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }),
};
