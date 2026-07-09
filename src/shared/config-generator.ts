// Validates the shared server-side config model.
//
// Reference: https://github.com/rapiz1/rathole#configuration

import type { RatholeConfig, RatholeService } from "./types";

export interface ValidationIssue {
  path: string;
  message: string;
}

type LegacyRatholeService = RatholeService & { domain?: string };

export const HTTP_PROXY_BIND_ADDR = "[::]:80";
export const HTTPS_PROXY_BIND_ADDR = "[::]:443";
export const HTTP_SERVICE_BIND_ADDR_PREFIX = "memory://";

function isHttpService(svc: RatholeService): boolean {
  return svc.type === "http" || svc.type === "https";
}

function hasHttpRoute(svc: RatholeService): boolean {
  return isHttpService(svc) || serviceHttpHosts(svc).length > 0;
}

function hasHttpsRoute(svc: RatholeService): boolean {
  return svc.type === "https" && serviceHttpHosts(svc).length > 0;
}

function assignHttpServiceBindAddrs(services: RatholeService[]): RatholeService[] {
  return services.map((service, i) => {
    if (!isHttpService(service)) return service;
    const key = service.name.trim() || `service_${i + 1}`;
    return { ...service, bindAddr: `${HTTP_SERVICE_BIND_ADDR_PREFIX}${key}` };
  });
}

function defaultPublicBindAddr(i: number): string {
  return `0.0.0.0:${5000 + i}`;
}

function restorePublicBindAddr(service: RatholeService, i: number): string {
  const bindAddr = service.bindAddr.trim();
  if (!bindAddr || bindAddr.startsWith(HTTP_SERVICE_BIND_ADDR_PREFIX)) {
    return defaultPublicBindAddr(i);
  }
  return service.bindAddr;
}

export function parseHttpHostsInput(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((host) => host.trim())
    .filter(Boolean);
}

export function serviceHttpHosts(service: RatholeService): string[] {
  const hosts = [
    ...(service.httpHosts ?? []),
    ...(service.httpHost ? parseHttpHostsInput(service.httpHost) : []),
  ];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const host of hosts) {
    const trimmed = host.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Normalize persisted/API configs before editing or saving.
 *
 * Older UI versions stored `domain` on each service. Domain is now server-level
 * metadata, so keep the first legacy value as the instance domain and drop the
 * per-service field from future writes.
 */
export function normalizeConfig(config: RatholeConfig): RatholeConfig {
  const legacyServices = config.services as LegacyRatholeService[];
  const legacyDomain = legacyServices.find((service) => service.domain?.trim())?.domain;
  const httpEnabled = !!config.http?.enabled;
  const services = legacyServices.map(({ domain: _domain, ...service }, i) => {
    const httpHosts = httpEnabled ? serviceHttpHosts(service) : [];
    const serviceType =
      !httpEnabled && isHttpService(service)
        ? "tcp"
        : httpHosts.length > 0 && service.type === "tcp"
          ? "http"
          : service.type;
    const bindAddr =
      serviceType === "tcp" && isHttpService(service)
        ? restorePublicBindAddr(service, i)
        : service.bindAddr;
    return {
      ...service,
      type: serviceType,
      bindAddr,
      httpHost: undefined,
      httpHosts: httpHosts.length > 0 ? httpHosts : undefined,
    };
  });
  const normalizedServices = assignHttpServiceBindAddrs(services);

  return {
    ...config,
    domain: config.domain ?? legacyDomain,
    http: config.http
      ? {
          enabled: !!config.http.enabled,
          bindAddr: HTTP_PROXY_BIND_ADDR,
          httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
          letsEncrypt: config.http.letsEncrypt
            ? {
                enabled: !!config.http.letsEncrypt.enabled,
                email: config.http.letsEncrypt.email?.trim() || "",
                staging: !!config.http.letsEncrypt.staging,
              }
            : undefined,
        }
      : undefined,
    services: normalizedServices,
  };
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

function validateHttpHost(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  if (input !== value || /\s/.test(input)) return "must not contain whitespace.";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || input.includes("/")) {
    return "must be only a hostname, without a URL scheme or path.";
  }
  if (input.includes(":")) return "must not include a port.";
  if (!isValidHostname(input)) return "must be a valid hostname such as app.example.com.";
  return null;
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

  const httpEnabled = !!config.http?.enabled;
  const letsEncryptEnabled = !!config.http?.letsEncrypt?.enabled;
  const httpRoutes = config.services.filter(hasHttpRoute);
  const letsEncryptActive = letsEncryptEnabled && config.services.some(hasHttpsRoute);
  if (httpEnabled || httpRoutes.length > 0) {
    const httpBindAddr = config.http?.bindAddr?.trim() || HTTP_PROXY_BIND_ADDR;
    if (httpBindAddr !== HTTP_PROXY_BIND_ADDR) {
      issues.push({
        path: "http.bindAddr",
        message: `HTTP proxy always listens on ${HTTP_PROXY_BIND_ADDR}.`,
      });
    }
  }
  if (!httpEnabled && httpRoutes.length > 0) {
    issues.push({
      path: "http.enabled",
      message: "Enable the HTTP proxy before assigning HTTP hosts.",
    });
  }
  if (letsEncryptActive) {
    const httpsBindAddr = config.http?.httpsBindAddr?.trim() || HTTPS_PROXY_BIND_ADDR;
    if (httpsBindAddr !== HTTPS_PROXY_BIND_ADDR) {
      issues.push({
        path: "http.httpsBindAddr",
        message: `HTTPS proxy always listens on ${HTTPS_PROXY_BIND_ADDR}.`,
      });
    }
  }

  const seenHttpHosts = new Set<string>();
  const seen = new Set<string>();
  config.services.forEach((svc, i) => {
    const base = `services[${i}]`;
    if (!svc.name.trim()) {
      issues.push({ path: `${base}.name`, message: "Service name is required." });
    } else if (seen.has(svc.name)) {
      issues.push({ path: `${base}.name`, message: `Duplicate service name "${svc.name}".` });
    }
    seen.add(svc.name);

    if (!isHttpService(svc)) {
      const publicBindError = validateHostPort(svc.bindAddr, "[::]:5000");
      if (publicBindError) {
        issues.push({
          path: `${base}.bindAddr`,
          message: `Service "${svc.name || i}" public bind address ${publicBindError}`,
        });
      }
    }

    const httpHosts = serviceHttpHosts(svc);
    if (isHttpService(svc) && httpHosts.length === 0) {
      issues.push({
        path: `${base}.httpHosts`,
        message: `Service "${svc.name || i}" needs at least one HTTP host.`,
      });
    }
    if (httpHosts.length > 0) {
      if (svc.type === "udp") {
        issues.push({
          path: `${base}.httpHosts`,
          message: `Service "${svc.name || i}" cannot be UDP and receive HTTP proxy traffic.`,
        });
      }
      if (svc.type === "tcp") {
        issues.push({
          path: `${base}.httpHosts`,
          message: `Service "${svc.name || i}" must be HTTP or HTTPS to use an HTTP host.`,
        });
      }
      httpHosts.forEach((httpHost, hostIndex) => {
        const httpHostError = validateHttpHost(httpHost);
        if (httpHostError) {
          issues.push({
            path: `${base}.httpHosts`,
            message: `Service "${svc.name || i}" HTTP host ${hostIndex + 1} ${httpHostError}`,
          });
        }
        const key = httpHost.toLowerCase();
        if (seenHttpHosts.has(key)) {
          issues.push({
            path: `${base}.httpHosts`,
            message: `Duplicate HTTP host "${httpHost}".`,
          });
        }
        seenHttpHosts.add(key);
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
    http: {
      enabled: false,
      bindAddr: HTTP_PROXY_BIND_ADDR,
      httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
      letsEncrypt: {
        enabled: false,
        email: "",
        staging: false,
      },
    },
    services: [],
  };
}

// ---- client.toml generation ------------------------------------------------

/** Quote a TOML string value. */
function q(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** rathole service names must be usable as bare TOML keys. */
function serviceKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : q(name);
}

function splitHostPort(addr: string): { host: string; port: string } {
  const s = addr.trim();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return { host: s.slice(0, end + 1), port: s.slice(end + 2).replace(/^:/, "") };
  }
  const idx = s.lastIndexOf(":");
  return idx < 0 ? { host: s, port: "" } : { host: s.slice(0, idx), port: s.slice(idx + 1) };
}

/**
 * The host a client dials: instance domain, else the node's public IP, else a
 * concrete bind host, else a placeholder.
 */
function remoteHost(config: RatholeConfig, publicIp?: string): string {
  const domain = config.domain?.trim();
  if (domain) return domain;
  if (publicIp?.trim()) return publicIp.trim();
  const { host } = splitHostPort(config.bindAddr);
  if (host && !["0.0.0.0", "::", "[::]", ""].includes(host)) return host;
  return "your-server-host";
}

/** Join host and port, bracketing bare IPv6 hosts. */
function hostPort(host: string, port: string): string {
  const needsBrackets = host.includes(":") && !host.startsWith("[");
  return `${needsBrackets ? `[${host}]` : host}:${port || "2333"}`;
}

/** A sensible default local target for a service, based on its name. */
function localHint(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("ssh")) return "127.0.0.1:22";
  if (n.includes("http") || n.includes("web")) return "127.0.0.1:80";
  if (n.includes("rdp")) return "127.0.0.1:3389";
  if (n.includes("vnc")) return "127.0.0.1:5900";
  return "127.0.0.1:8080";
}

function serviceLocalHint(service: RatholeService): string {
  if (hasHttpRoute(service)) return "127.0.0.1:80";
  return localHint(service.name);
}

function ratholeServiceType(service: RatholeService): "tcp" | "udp" {
  return service.type === "udp" ? "udp" : "tcp";
}

/** The `[client]` + `[client.transport]` lines (no services). */
function clientGlobalLines(config: RatholeConfig, publicIp?: string): string[] {
  const { port } = splitHostPort(config.bindAddr);
  const out = ["[client]", `remote_addr = ${q(hostPort(remoteHost(config, publicIp), port))}`];
  if (config.defaultToken?.trim()) out.push(`default_token = ${q(config.defaultToken)}`);
  out.push("");
  out.push("[client.transport]");
  out.push(`type = ${q(config.transport)}`);
  if (config.transport === "tls" && config.tls) {
    out.push("[client.transport.tls]");
    if (config.tls.trustedRoot) out.push(`trusted_root = ${q(config.tls.trustedRoot)}`);
    if (config.tls.hostname) out.push(`hostname = ${q(config.tls.hostname)}`);
  } else if (config.transport === "noise" && config.noise) {
    out.push("[client.transport.noise]");
    if (config.noise.pattern) out.push(`pattern = ${q(config.noise.pattern)}`);
    if (config.noise.remotePublicKey)
      out.push(`remote_public_key = ${q(config.noise.remotePublicKey)}`);
  } else if (config.transport === "websocket") {
    out.push("[client.transport.websocket]");
    out.push(`tls = ${config.websocket?.tls ? "true" : "false"}`);
  }
  return out;
}

/** The `[client.services.<name>]` block for a single service. */
function clientServiceLines(svc: RatholeService): string[] {
  const out = [
    `[client.services.${serviceKey(svc.name)}]`,
    `type = ${q(ratholeServiceType(svc))}`,
    `local_addr = ${q(serviceLocalHint(svc))}`,
  ];
  if (svc.token?.trim()) out.push(`token = ${q(svc.token)}`);
  if (svc.nodelay !== undefined) out.push(`nodelay = ${svc.nodelay ? "true" : "false"}`);
  return out;
}

/** Just the global `[client]` section (remote_addr, token, transport). */
export function generateClientGlobalToml(config: RatholeConfig, publicIp?: string): string {
  return (
    [
      "# rathole client — global section. Run with `rathole client.toml`.",
      "",
      ...clientGlobalLines(config, publicIp),
    ]
      .join("\n")
      .trimEnd() + "\n"
  );
}

/** Just one service's `[client.services.*]` block. */
export function generateClientServiceToml(svc: RatholeService): string {
  return (
    ["# adjust local_addr to your local service", ...clientServiceLines(svc)].join("\n").trimEnd() +
    "\n"
  );
}

/**
 * Generate a full rathole `client.toml` template for the machine behind NAT.
 * `local_addr` values are best-guess placeholders — adjust them to your local
 * services. rathole forwards raw TCP/UDP, so this is a starting point.
 */
export function generateClientToml(config: RatholeConfig, publicIp?: string): string {
  const out = [
    "# rathole client config — run this on the machine behind NAT.",
    "# Generated by rathole-manage. Adjust each local_addr to your local service.",
    "",
    ...clientGlobalLines(config, publicIp),
    "",
  ];
  for (const svc of config.services) {
    out.push(...clientServiceLines(svc), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
