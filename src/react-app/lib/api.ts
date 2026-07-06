import type {
  CreateInstanceInput,
  GeneratedConfigs,
  InstanceView,
  UpdateInstanceInput,
} from "@shared/types";
import type { ValidationIssue } from "@shared/config-generator";

const TOKEN_KEY = "rathole-admin-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  async checkSession(token: string): Promise<boolean> {
    const res = await fetch("/api/session", {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.ok;
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
