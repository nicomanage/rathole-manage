// Validates the shared config model and generates the operator-managed client
// config. Server config generation is Worker-owned in src/worker/server-config.ts.
//
// Reference: https://github.com/rapiz1/rathole#configuration

import type { RatholeConfig, RatholeService } from "./types";

/** Quote a TOML string value, escaping backslashes and double quotes. */
function q(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** rathole service names must be usable as bare TOML keys. */
function isBareKey(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function serviceKey(name: string): string {
  return isBareKey(name) ? name : q(name);
}

export interface ValidationIssue {
  path: string;
  message: string;
}

function validateHostPort(value: string, ipv6Example: string): string | null {
  const input = value.trim();
  if (!input) return "is required.";
  if (input !== value || /\s/.test(input)) return "must not contain whitespace.";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || input.includes("/")) {
    return "must be only host:port, without a URL scheme or path.";
  }

  let host: string;
  let portText: string;

  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    if (end < 0) return `must close the IPv6 address bracket, e.g. ${ipv6Example}.`;
    host = input.slice(1, end);
    if (input[end + 1] !== ":") return `must put the port after the IPv6 bracket, e.g. ${ipv6Example}.`;
    portText = input.slice(end + 2);
    if (!isValidIpv6Host(host)) return `has an invalid IPv6 address; use bracket form like ${ipv6Example}.`;
  } else {
    const firstColon = input.indexOf(":");
    const lastColon = input.lastIndexOf(":");
    if (firstColon < 0) return "must include a port, e.g. 0.0.0.0:5000.";
    if (firstColon !== lastColon) return `looks like IPv6; use bracket form like ${ipv6Example}.`;
    host = input.slice(0, lastColon);
    portText = input.slice(lastColon + 1);
    if (!isValidHost(host)) {
      return "has an invalid host; use an IPv4 address, hostname, localhost, or bracketed IPv6.";
    }
  }

  if (!/^\d+$/.test(portText)) return "port must be a whole number.";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "port must be between 1 and 65535.";
  }
  return null;
}

function isValidHost(host: string): boolean {
  if (!host) return false;
  if (host === "localhost") return true;
  if (isValidIpv4(host)) return true;
  return isValidHostname(host);
}

function isValidIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isValidHostname(host: string): boolean {
  if (host.length > 253) return false;
  const normalized = host.endsWith(".") ? host.slice(0, -1) : host;
  return normalized.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}

function isValidIpv6Host(host: string): boolean {
  if (!host) return false;
  try {
    new URL(`http://[${host}]:1`);
    return true;
  } catch {
    return false;
  }
}

/** Validate a config, returning a list of human-readable problems (empty = ok). */
export function validateConfig(config: RatholeConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const controlBindError = validateHostPort(config.bindAddr, "[::]:2333");
  if (controlBindError) {
    issues.push({
      path: "bindAddr",
      message: `Control channel bind address ${controlBindError}`,
    });
  }

  const seen = new Set<string>();
  config.services.forEach((svc, i) => {
    const base = `services[${i}]`;
    if (!svc.name.trim()) {
      issues.push({ path: `${base}.name`, message: "Service name is required." });
    } else if (seen.has(svc.name)) {
      issues.push({ path: `${base}.name`, message: `Duplicate service name "${svc.name}".` });
    }
    seen.add(svc.name);

    const publicBindError = validateHostPort(svc.bindAddr, "[::]:5000");
    if (publicBindError) {
      issues.push({
        path: `${base}.bindAddr`,
        message: `Service "${svc.name || i}" public bind address ${publicBindError}`,
      });
    }
  });

  const hasDefault = !!config.defaultToken?.trim();
  const missingTokens = config.services.filter((s) => !s.token?.trim());
  if (!hasDefault && missingTokens.length > 0) {
    issues.push({
      path: "defaultToken",
      message:
        "Set a default token, or give every service its own token. rathole requires a token for each service.",
    });
  }

  return issues;
}

/**
 * Generate a matching `client.toml`. This is a template the operator runs on the
 * machine behind NAT; `local_addr` defaults to the service's clientLocalAddr.
 */
export function generateClientToml(
  config: RatholeConfig,
  publicHost?: string,
): string {
  const remotePort = config.bindAddr.split(":").pop() ?? "2333";
  const host = publicHost?.trim() || "your-server-host";
  const out: string[] = [];
  out.push(`# rathole client config (run this on the machine behind NAT).`);
  out.push(`# Generated by rathole-manage.`);
  out.push("");
  out.push(`[client]`);
  out.push(`remote_addr = ${q(`${host}:${remotePort}`)}`);
  if (config.defaultToken?.trim()) out.push(`default_token = ${q(config.defaultToken)}`);
  out.push("");

  if (config.transport && config.transport !== "tcp") {
    out.push(`[client.transport]`);
    out.push(`type = ${q(config.transport)}`);
    if (config.transport === "noise" && config.noise?.pattern) {
      out.push(`[client.transport.noise]`);
      out.push(`pattern = ${q(config.noise.pattern)}`);
      if (config.noise.remotePublicKey)
        out.push(`remote_public_key = ${q(config.noise.remotePublicKey)}`);
    }
    if (config.transport === "websocket") {
      out.push(`[client.transport.websocket]`);
      out.push(`tls = ${config.websocket?.tls ? "true" : "false"}`);
    }
    out.push("");
  }

  for (const svc of config.services) {
    out.push(`[client.services.${serviceKey(svc.name)}]`);
    out.push(`type = ${q(svc.type)}`);
    out.push(`local_addr = ${q(svc.clientLocalAddr || localHint(svc))}`);
    if (svc.token?.trim()) out.push(`token = ${q(svc.token)}`);
    if (svc.nodelay !== undefined) out.push(`nodelay = ${svc.nodelay ? "true" : "false"}`);
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function localHint(svc: RatholeService): string {
  // A sensible default local target based on the service name.
  const n = svc.name.toLowerCase();
  if (n.includes("ssh")) return "127.0.0.1:22";
  if (n.includes("web") || n.includes("http")) return "127.0.0.1:80";
  if (n.includes("rdp")) return "127.0.0.1:3389";
  return "127.0.0.1:8080";
}

export function defaultConfig(): RatholeConfig {
  return {
    bindAddr: "0.0.0.0:2333",
    defaultToken: "",
    transport: "tcp",
    services: [],
  };
}
