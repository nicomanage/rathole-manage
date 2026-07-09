import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  generateClientGlobalToml,
  generateClientServiceToml,
  generateClientToml,
  HTTP_PROXY_BIND_ADDR,
  HTTP_SERVICE_BIND_ADDR_PREFIX,
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
        services: [{ name: "web", type: "http", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
      }),
    );
    expect(issues.some((i) => i.path === "http.enabled")).toBe(true);
  });

  it("accepts a valid Pingora HTTP route", () => {
    expect(
      validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [{ name: "web", type: "http", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
        }),
      ),
    ).toEqual([]);
  });

  it("rejects duplicate HTTP hosts", () => {
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [
          { name: "web1", type: "http", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
          { name: "web2", type: "http", bindAddr: "0.0.0.0:8081", httpHost: "APP.example.com" },
        ],
      }),
    );
    expect(issues.some((i) => /duplicate/i.test(i.message))).toBe(true);
  });

  it("rejects HTTP hosts on TCP services", () => {
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
      }),
    );
    expect(issues.some((i) => /HTTP or HTTPS/.test(i.message))).toBe(true);
  });

  it("rejects HTTP hosts on UDP services", () => {
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "dns", type: "udp", bindAddr: "0.0.0.0:5353", httpHost: "dns.example.com" }],
      }),
    );
    expect(issues.some((i) => /cannot be UDP/.test(i.message))).toBe(true);
  });

  it("accepts HTTP services with a host", () => {
    expect(
      validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [{ name: "web", type: "http", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
        }),
      ),
    ).toEqual([]);
  });

  it("requires a host for HTTP services", () => {
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "web", type: "http", bindAddr: "0.0.0.0:8080" }],
      }),
    );
    expect(issues.some((i) => i.path === "services[0].httpHosts")).toBe(true);
  });

  it("allows HTTPS services without Let's Encrypt form validation", () => {
    expect(
      validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [{ name: "web", type: "https", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
        }),
      ),
    ).toEqual([]);
  });

  it("does not require public bind validation for HTTP services", () => {
    expect(
      validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [{ name: "web", type: "http", bindAddr: "", httpHost: "app.example.com" }],
        }),
      ),
    ).toEqual([]);
  });

  it("accepts Let's Encrypt when HTTPS service can use HTTP-01", () => {
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
            { name: "web", type: "https", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
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
          { name: "web", type: "http", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
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
          { name: "web", type: "https", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
        ],
      }),
    );
    expect(issues.some((i) => i.path === "http.httpsBindAddr" && /always listens/.test(i.message))).toBe(true);
  });

  it("does not validate Let's Encrypt account email in the form", () => {
    expect(
      validateConfig(
        config({
          http: {
            enabled: true,
            bindAddr: HTTP_PROXY_BIND_ADDR,
            httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
            letsEncrypt: { enabled: true, email: "" },
          },
          services: [
            { name: "web", type: "https", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
          ],
        }),
      ),
    ).toEqual([]);
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

  it("normalizes legacy TCP HTTP-host services to HTTP services", () => {
    const normalized = normalizeConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
      }),
    );
    expect(normalized.services[0].type).toBe("http");
    expect(normalized.services[0].bindAddr).toBe(`${HTTP_SERVICE_BIND_ADDR_PREFIX}web`);
    expect(normalized.services[0].httpHost).toBeUndefined();
    expect(normalized.services[0].httpHosts).toEqual(["app.example.com"]);
  });

  it("accepts multiple HTTP hosts on one service", () => {
    expect(
      validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [
            {
              name: "web",
              type: "http",
              bindAddr: "0.0.0.0:8080",
              httpHosts: ["app.example.com", "www.example.com"],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("normalizes comma separated legacy HTTP hosts", () => {
    const normalized = normalizeConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [
          {
            name: "web",
            type: "http",
            bindAddr: "0.0.0.0:8080",
            httpHost: "app.example.com, www.example.com app.example.com",
          },
        ],
      }),
    );
    expect(normalized.services[0].httpHost).toBeUndefined();
    expect(normalized.services[0].httpHosts).toEqual(["app.example.com", "www.example.com"]);
  });

  it("normalizes HTTP and HTTPS service binds to virtual memory keys", () => {
    const normalized = normalizeConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [
          { name: "web", type: "http", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
          { name: "secure", type: "https", bindAddr: "0.0.0.0:8443", httpHost: "secure.example.com" },
        ],
      }),
    );
    expect(normalized.services.map((service) => service.bindAddr)).toEqual([
      `${HTTP_SERVICE_BIND_ADDR_PREFIX}web`,
      `${HTTP_SERVICE_BIND_ADDR_PREFIX}secure`,
    ]);
  });

  it("removes HTTP service types when the HTTP service is disabled", () => {
    const normalized = normalizeConfig(
      config({
        http: { enabled: false, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [
          { name: "web", type: "http", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
          { name: "secure", type: "https", bindAddr: "0.0.0.0:8443", httpHost: "secure.example.com" },
        ],
      }),
    );
    expect(normalized.services.map((service) => service.type)).toEqual(["tcp", "tcp"]);
    expect(normalized.services.every((service) => service.httpHost === undefined)).toBe(true);
    expect(normalized.services.every((service) => service.httpHosts === undefined)).toBe(true);
  });

  it("restores public binds when disabled HTTP services had virtual binds", () => {
    const normalized = normalizeConfig(
      config({
        http: { enabled: false, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [
          {
            name: "web",
            type: "http",
            bindAddr: `${HTTP_SERVICE_BIND_ADDR_PREFIX}web`,
            httpHost: "app.example.com",
          },
          {
            name: "secure",
            type: "https",
            bindAddr: `${HTTP_SERVICE_BIND_ADDR_PREFIX}secure`,
            httpHost: "secure.example.com",
          },
        ],
      }),
    );
    expect(normalized.services.map((service) => service.bindAddr)).toEqual([
      "0.0.0.0:5000",
      "0.0.0.0:5001",
    ]);
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
        services: [{ name: "app", type: "http", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
      }),
    );
    expect(toml).toContain("[client.services.app]");
    expect(toml).toContain('local_addr = "127.0.0.1:80"');
  });

  it("emits HTTP panel services as TCP rathole services", () => {
    const toml = generateClientToml(
      config({
        services: [{ name: "app", type: "https", bindAddr: "0.0.0.0:8443", httpHost: "app.example.com" }],
      }),
    );
    expect(toml).toContain("[client.services.app]");
    expect(toml).toContain('type = "tcp"');
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
