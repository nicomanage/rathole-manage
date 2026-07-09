import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  generateClientGlobalToml,
  generateClientServiceToml,
  generateClientToml,
  HTTP_PROXY_BIND_ADDR,
  HTTPS_PROXY_BIND_ADDR,
  normalizeConfig,
  validateConfig,
} from "./config-generator";
import { hashServerConfig } from "../worker/server-config";
import type { RatholeConfig } from "./types";

function config(overrides: Partial<RatholeConfig> = {}): RatholeConfig {
  return {
    ...defaultConfig(),
    bindAddr: "0.0.0.0:2333",
    defaultToken: "secret",
    transport: "tcp",
    services: [
      { name: "ssh", type: "tcp", bindAddr: "0.0.0.0:5202" },
    ],
    ...overrides,
  };
}

describe("validateConfig", () => {
  it("accepts a well-formed config", () => {
    expect(validateConfig(config())).toEqual([]);
  });

  it("flags a malformed control bind address", () => {
    const issues = validateConfig(config({ bindAddr: "nope" }));
    expect(issues.some((i) => i.path === "bindAddr")).toBe(true);
  });

  it("flags duplicate service names", () => {
    const issues = validateConfig(
      config({
        services: [
          { name: "dup", type: "tcp", bindAddr: "0.0.0.0:1" },
          { name: "dup", type: "tcp", bindAddr: "0.0.0.0:2" },
        ],
      }),
    );
    expect(issues.some((i) => /duplicate/i.test(i.message))).toBe(true);
  });

  it("requires a token when no default token is set", () => {
    const issues = validateConfig(
      config({
        defaultToken: "",
        services: [{ name: "s", type: "tcp", bindAddr: "0.0.0.0:9" }],
      }),
    );
    expect(issues.some((i) => i.path === "defaultToken")).toBe(true);
  });

  it("flags a service with an invalid bind address", () => {
    const issues = validateConfig(
      config({ services: [{ name: "s", type: "tcp", bindAddr: "oops" }] }),
    );
    expect(issues.some((i) => i.path === "services[0].bindAddr")).toBe(true);
  });

  it("requires the HTTP proxy when a service has an HTTP host", () => {
    const issues = validateConfig(
      config({
        http: { enabled: false, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
      }),
    );
    expect(issues.some((i) => i.path === "http.enabled")).toBe(true);
  });

  it("accepts a valid Pingora HTTP route", () => {
    expect(
      validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
        }),
      ),
    ).toEqual([]);
  });

  it("rejects duplicate HTTP hosts", () => {
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [
          { name: "web1", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
          { name: "web2", type: "tcp", bindAddr: "0.0.0.0:8081", httpHost: "APP.example.com" },
        ],
      }),
    );
    expect(issues.some((i) => /duplicate/i.test(i.message))).toBe(true);
  });

  it("rejects HTTP hosts on UDP services", () => {
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "dns", type: "udp", bindAddr: "0.0.0.0:5353", httpHost: "dns.example.com" }],
      }),
    );
    expect(issues.some((i) => /must be TCP/.test(i.message))).toBe(true);
  });

  it("accepts Let's Encrypt when HTTP-01 can bind port 80", () => {
    expect(
      validateConfig(
        config({
          http: {
            enabled: true,
            bindAddr: HTTP_PROXY_BIND_ADDR,
            httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
            letsEncrypt: { enabled: true, email: "admin@example.com" },
          },
          services: [
            { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a custom HTTP proxy bind address", () => {
    const issues = validateConfig(
      config({
        http: {
          enabled: true,
          bindAddr: "0.0.0.0:8080",
          httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
          letsEncrypt: { enabled: true, email: "admin@example.com" },
        },
        services: [
          { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
        ],
      }),
    );
    expect(issues.some((i) => i.path === "http.bindAddr" && /always listens/.test(i.message))).toBe(true);
  });

  it("rejects a custom HTTPS proxy bind address", () => {
    const issues = validateConfig(
      config({
        http: {
          enabled: true,
          bindAddr: HTTP_PROXY_BIND_ADDR,
          httpsBindAddr: "0.0.0.0:8443",
          letsEncrypt: { enabled: true, email: "admin@example.com" },
        },
        services: [
          { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
        ],
      }),
    );
    expect(issues.some((i) => i.path === "http.httpsBindAddr" && /always listens/.test(i.message))).toBe(true);
  });

  it("requires a Let's Encrypt account email", () => {
    const issues = validateConfig(
      config({
          http: {
            enabled: true,
            bindAddr: HTTP_PROXY_BIND_ADDR,
            httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
            letsEncrypt: { enabled: true, email: "" },
          },
        services: [
          { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
        ],
      }),
    );
    expect(issues.some((i) => i.path === "http.letsEncrypt.email")).toBe(true);
  });

  it("normalizes proxy binds to fixed IPv6 wildcard ports", () => {
    const normalized = normalizeConfig(
      config({
        http: {
          enabled: true,
          bindAddr: "0.0.0.0:8080",
          httpsBindAddr: "0.0.0.0:8443",
          letsEncrypt: { enabled: true, email: "admin@example.com" },
        },
      }),
    );
    expect(normalized.http?.bindAddr).toBe(HTTP_PROXY_BIND_ADDR);
    expect(normalized.http?.httpsBindAddr).toBe(HTTPS_PROXY_BIND_ADDR);
  });
});

describe("generateClientToml", () => {
  it("uses the instance domain and control port for remote_addr", () => {
    const toml = generateClientToml(config({ domain: "tunnel.example.com" }));
    expect(toml).toContain('remote_addr = "tunnel.example.com:2333"');
    expect(toml).toContain('default_token = "secret"');
  });

  it("emits a client service table with a sensible local_addr default", () => {
    const toml = generateClientToml(config());
    expect(toml).toContain("[client.services.ssh]");
    expect(toml).toContain('local_addr = "127.0.0.1:22"');
  });

  it("uses port 80 as the local_addr default for HTTP-routed services", () => {
    const toml = generateClientToml(
      config({
        services: [{ name: "app", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
      }),
    );
    expect(toml).toContain("[client.services.app]");
    expect(toml).toContain('local_addr = "127.0.0.1:80"');
  });

  it("falls back to a placeholder host when domain and bind host are unset", () => {
    const toml = generateClientToml(config({ domain: undefined }));
    expect(toml).toContain('remote_addr = "your-server-host:2333"');
  });

  it("uses the node public IP when no domain is set", () => {
    const toml = generateClientToml(config({ domain: undefined }), "203.0.113.7");
    expect(toml).toContain('remote_addr = "203.0.113.7:2333"');
  });

  it("brackets an IPv6 public IP", () => {
    const toml = generateClientToml(config({ domain: undefined }), "2001:db8::1");
    expect(toml).toContain('remote_addr = "[2001:db8::1]:2333"');
  });

  it("prefers the domain over the public IP", () => {
    const toml = generateClientToml(config({ domain: "tunnel.example.com" }), "203.0.113.7");
    expect(toml).toContain('remote_addr = "tunnel.example.com:2333"');
  });

  it("includes noise transport with the remote public key", () => {
    const toml = generateClientToml(
      config({ transport: "noise", noise: { remotePublicKey: "abc123" } }),
    );
    expect(toml).toContain("[client.transport.noise]");
    expect(toml).toContain('remote_public_key = "abc123"');
  });

  it("quotes non-bare service names", () => {
    const toml = generateClientToml(
      config({ services: [{ name: "my nas", type: "tcp", bindAddr: "0.0.0.0:1" }] }),
    );
    expect(toml).toContain('[client.services."my nas"]');
  });
});

describe("split client config", () => {
  it("global section has [client] but no service tables", () => {
    const toml = generateClientGlobalToml(config({ domain: "tunnel.example.com" }));
    expect(toml).toContain("[client]");
    expect(toml).toContain('remote_addr = "tunnel.example.com:2333"');
    expect(toml).not.toContain("[client.services");
  });

  it("service block has only that service's table", () => {
    const toml = generateClientServiceToml({
      name: "ssh",
      type: "tcp",
      bindAddr: "0.0.0.0:5202",
      token: "svc-token",
    });
    expect(toml).toContain("[client.services.ssh]");
    expect(toml).toContain('local_addr = "127.0.0.1:22"');
    expect(toml).toContain('token = "svc-token"');
    expect(toml).not.toContain("[client]");
  });
});

describe("hashServerConfig", () => {
  it("is deterministic and changes with content", () => {
    const a = hashServerConfig("hello");
    expect(a).toBe(hashServerConfig("hello"));
    expect(a).not.toBe(hashServerConfig("hello!"));
  });
});
