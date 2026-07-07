// Validates the shared server-side config model.
//
// Reference: https://github.com/rapiz1/rathole#configuration

import type { RatholeConfig } from "./types";

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

export function defaultConfig(): RatholeConfig {
  return {
    bindAddr: "0.0.0.0:2333",
    defaultToken: "",
    transport: "tcp",
    services: [],
  };
}
