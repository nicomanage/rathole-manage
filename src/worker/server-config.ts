import type { RatholeConfig } from "@shared/types";

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serviceKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : quote(name);
}

function transportBlock(config: RatholeConfig): string {
  const lines: string[] = [
    "[server.transport]",
    `type = ${quote(config.transport)}`,
  ];

  if (config.transport === "tls" && config.tls) {
    lines.push("[server.transport.tls]");
    if (config.tls.pkcsPath) lines.push(`pkcs12 = ${quote(config.tls.pkcsPath)}`);
    if (config.tls.keystorePassword) {
      lines.push(`pkcs12_password = ${quote(config.tls.keystorePassword)}`);
    }
  }
  if (config.transport === "noise" && config.noise) {
    lines.push("[server.transport.noise]");
    if (config.noise.pattern) lines.push(`pattern = ${quote(config.noise.pattern)}`);
    if (config.noise.localPrivateKey) {
      lines.push(`local_private_key = ${quote(config.noise.localPrivateKey)}`);
    }
    if (config.noise.remotePublicKey) {
      lines.push(`remote_public_key = ${quote(config.noise.remotePublicKey)}`);
    }
  }
  if (config.transport === "websocket" && config.websocket) {
    lines.push("[server.transport.websocket]");
    lines.push(`tls = ${config.websocket.tls ? "true" : "false"}`);
  }

  return lines.join("\n");
}

/** Worker-owned generation of the server config sent to the node agent. */
export function generateServerToml(config: RatholeConfig, instanceName?: string): string {
  const out: string[] = [];
  if (instanceName) out.push(`# rathole server config for "${instanceName}"`);
  out.push("# Generated and managed by rathole-manage Worker — do not edit by hand.");
  out.push("");
  out.push("[server]");
  out.push(`bind_addr = ${quote(config.bindAddr)}`);
  if (config.defaultToken?.trim()) out.push(`default_token = ${quote(config.defaultToken)}`);
  if (typeof config.heartbeatInterval === "number") {
    out.push(`heartbeat_interval = ${config.heartbeatInterval}`);
  }
  out.push("");

  if (config.transport && config.transport !== "tcp") {
    out.push(transportBlock(config));
  } else {
    out.push("[server.transport]");
    out.push('type = "tcp"');
  }
  out.push("");

  for (const service of config.services) {
    out.push(`[server.services.${serviceKey(service.name)}]`);
    out.push(`type = ${quote(service.type)}`);
    out.push(`bind_addr = ${quote(service.bindAddr)}`);
    if (service.token?.trim()) out.push(`token = ${quote(service.token)}`);
    if (service.nodelay !== undefined) {
      out.push(`nodelay = ${service.nodelay ? "true" : "false"}`);
    }
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Deterministic short hash used by the Worker and agent for drift detection. */
export function hashServerConfig(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
