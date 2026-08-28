import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  generateClientGlobalToml,
  generateClientServiceToml,
  generateClientToml,
  HTTP_PROXY_BIND_ADDR,
  HTTP_SERVICE_BIND_ADDR_PREFIX,
  HTTPS_PROXY_BIND_ADDR,
  isHttpRouteActive,
  normalizeConfig,
  validateConfig,
} from "./config-generator";
import { hashServerConfig } from "../worker/server-config";
import type { RatholeConfig, RatholeService } from "./types";

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

  it("allows HTTP routes to remain configured while the proxy is disabled", () => {
    expect(validateConfig(
      config({
        http: { enabled: false, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
      }),
    )).toEqual([]);
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

  it("accepts HTTP hosts on TCP services", () => {
    expect(validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
      }),
    )).toEqual([]);
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

  it("accepts routed TCP services with a host", () => {
    expect(
      validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
        }),
      ),
    ).toEqual([]);
  });

  it("does not require every TCP service to have an HTTP host", () => {
    expect(validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080" }],
      }),
    )).toEqual([]);
  });

  it("allows TCP HTTP routes without Let's Encrypt form validation", () => {
    expect(
      validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
        }),
      ),
    ).toEqual([]);
  });

  it("does not require a public bind for HTTP-routed TCP services", () => {
    // Routed backends are reachable only through the proxy, so there is no
    // public port to validate.
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "web", type: "tcp", bindAddr: "", httpHost: "app.example.com" }],
      }),
    );
    expect(issues.some((i) => i.path === "services[0].bindAddr")).toBe(false);
  });

  it("requires a public bind again once routing is paused", () => {
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [
          { name: "web", type: "tcp", bindAddr: "", httpHost: "app.example.com", httpEnabled: false },
        ],
      }),
    );
    expect(issues.some((i) => i.path === "services[0].bindAddr")).toBe(true);
  });

  it("accepts Let's Encrypt when a TCP HTTP route can use HTTP-01", () => {
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
          { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
        ],
      }),
    );
    expect(issues.some((i) => i.path === "http.httpsBindAddr" && /always listens/.test(i.message))).toBe(true);
  });

  it("requires an ACME account email once Let's Encrypt can issue", () => {
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

  it("ignores a blank ACME email while nothing can be issued yet", () => {
    // Let's Encrypt on but no HTTP-routed backend: the agent provisions nothing,
    // so an empty email must not block saving a half-built config.
    expect(
      validateConfig(
        config({
          http: {
            enabled: true,
            bindAddr: HTTP_PROXY_BIND_ADDR,
            httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
            letsEncrypt: { enabled: true, email: "" },
          },
          services: [{ name: "ssh", type: "tcp", bindAddr: "0.0.0.0:22" }],
        }),
      ),
    ).toEqual([]);
  });

  it("ignores a blank ACME email when every backend brings its own certificate", () => {
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
            {
              name: "web",
              type: "tcp",
              bindAddr: "0.0.0.0:8080",
              httpHost: "app.example.com",
              customCertificate: {
                enabled: true,
                certificatePem: "-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----",
                privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
              },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ["no at sign", "adminexample.com"],
    ["two at signs", "admin@@example.com"],
    ["missing local part", "@example.com"],
    ["bare domain label", "admin@example"],
    ["embedded whitespace", "admin @example.com"],
  ])("rejects a malformed ACME account email (%s)", (_label, email) => {
    const issues = validateConfig(
      config({
        http: {
          enabled: true,
          bindAddr: HTTP_PROXY_BIND_ADDR,
          httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
          letsEncrypt: { enabled: true, email },
        },
        services: [
          { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
        ],
      }),
    );
    expect(issues.some((i) => i.path === "http.letsEncrypt.email")).toBe(true);
  });

  it("accepts a custom PEM certificate for TCP HTTP routes", () => {
    expect(
      validateConfig(
        config({
          http: {
            enabled: true,
            bindAddr: HTTP_PROXY_BIND_ADDR,
            httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
          },
          services: [
            {
              name: "web",
              type: "tcp",
              bindAddr: "0.0.0.0:8080",
              httpHost: "app.example.com",
              customCertificate: {
                enabled: true,
                certificatePem: "-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----",
                privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
              },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("requires both custom certificate PEM fields", () => {
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{
          name: "web",
          type: "tcp",
          bindAddr: "0.0.0.0:8080",
          httpHost: "app.example.com",
          customCertificate: { enabled: true, certificatePem: "", privateKeyPem: "" },
        }],
      }),
    );
    expect(issues.map((issue) => issue.path)).toContain(
      "services[0].customCertificate.certificatePem",
    );
    expect(issues.map((issue) => issue.path)).toContain(
      "services[0].customCertificate.privateKeyPem",
    );
  });

  it("allows Let's Encrypt and per-backend custom certificates together", () => {
    const issues = validateConfig(
      config({
        http: {
          enabled: true,
          bindAddr: HTTP_PROXY_BIND_ADDR,
          letsEncrypt: { enabled: true, email: "admin@example.com" },
        },
        services: [
          {
            name: "custom",
            type: "tcp",
            bindAddr: "0.0.0.0:8080",
            httpHost: "custom.example.com",
            customCertificate: {
              enabled: true,
              certificatePem: "-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----",
              privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
            },
          },
          { name: "acme", type: "tcp", bindAddr: "0.0.0.0:8081", httpHost: "acme.example.com" },
        ],
      }),
    );
    expect(issues).toEqual([]);
  });

  it("migrates a legacy global custom certificate to every HTTP backend", () => {
    const normalized = normalizeConfig(
      config({
        http: {
          enabled: true,
          bindAddr: HTTP_PROXY_BIND_ADDR,
          customCertificate: {
            enabled: true,
            certificatePem: " cert ",
            privateKeyPem: " key ",
          },
        },
        services: [
          { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
          { name: "ssh", type: "tcp", bindAddr: "0.0.0.0:22" },
        ],
      }),
    );
    expect(normalized.http?.customCertificate).toBeUndefined();
    expect(normalized.services[0].customCertificate).toEqual({
      enabled: true,
      certificatePem: "cert",
      privateKeyPem: "key",
    });
    expect(normalized.services[1].customCertificate).toBeUndefined();
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

  it("normalizes legacy single HTTP hosts while keeping the TCP service", () => {
    const normalized = normalizeConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" }],
      }),
    );
    expect(normalized.services[0].type).toBe("tcp");
    expect(normalized.services[0].bindAddr).toBe("0.0.0.0:8080");
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
              type: "tcp",
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

  it("migrates legacy HTTP and HTTPS service types to TCP", () => {
    const normalized = normalizeConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [
          { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHost: "app.example.com" },
          { name: "secure", type: "https", bindAddr: "0.0.0.0:8443", httpHost: "secure.example.com" },
        ],
      }),
    );
    expect(normalized.services.map((service) => service.type)).toEqual(["tcp", "tcp"]);
    expect(normalized.services.map((service) => service.bindAddr)).toEqual([
      "0.0.0.0:8080",
      "0.0.0.0:8443",
    ]);
  });

  it("preserves TCP HTTP routes when the proxy is disabled", () => {
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
    expect(normalized.services.map((service) => service.httpHosts)).toEqual([
      ["app.example.com"],
      ["secure.example.com"],
    ]);
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

describe("httpEnabled", () => {
  describe("isHttpRouteActive", () => {
    const hosted = (httpEnabled?: boolean): RatholeService => ({
      name: "web",
      type: "tcp",
      bindAddr: "0.0.0.0:8080",
      httpHosts: ["app.example.com"],
      httpEnabled,
    });

    it("treats an absent httpEnabled as routed", () => {
      expect(isHttpRouteActive(hosted())).toBe(true);
    });

    it("treats httpEnabled true as routed", () => {
      expect(isHttpRouteActive(hosted(true))).toBe(true);
    });

    it("treats httpEnabled false as paused", () => {
      expect(isHttpRouteActive(hosted(false))).toBe(false);
    });

    it("is inactive when the service has no HTTP hosts", () => {
      expect(
        isHttpRouteActive({ name: "ssh", type: "tcp", bindAddr: "0.0.0.0:22", httpEnabled: true }),
      ).toBe(false);
    });
  });

  describe("normalizeConfig", () => {
    it("defaults httpEnabled to true for a service with hosts", () => {
      const normalized = normalizeConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHosts: ["app.example.com"] }],
        }),
      );
      expect(normalized.services[0].httpEnabled).toBe(true);
    });

    it("preserves httpEnabled false for a service with hosts", () => {
      const normalized = normalizeConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [
            { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHosts: ["app.example.com"], httpEnabled: false },
          ],
        }),
      );
      expect(normalized.services[0].httpEnabled).toBe(false);
    });

    it("drops httpEnabled for a service without hosts even when set", () => {
      const normalized = normalizeConfig(
        config({
          services: [{ name: "ssh", type: "tcp", bindAddr: "0.0.0.0:22", httpEnabled: false }],
        }),
      );
      expect(normalized.services[0].httpEnabled).toBeUndefined();
    });
  });

  describe("validateConfig Let's Encrypt gating", () => {
    const leReady = (httpEnabled?: boolean) =>
      config({
        http: {
          enabled: true,
          bindAddr: HTTP_PROXY_BIND_ADDR,
          httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
          letsEncrypt: { enabled: true, email: "" },
        },
        services: [
          { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHosts: ["app.example.com"], httpEnabled },
        ],
      });

    it("does not require an ACME email when the only hosted backend is paused", () => {
      expect(validateConfig(leReady(false))).toEqual([]);
    });

    it("requires an ACME email when the hosted backend is routed (absent httpEnabled)", () => {
      const issues = validateConfig(leReady(undefined));
      expect(issues.some((i) => i.path === "http.letsEncrypt.email")).toBe(true);
    });

    it("requires an ACME email when httpEnabled is explicitly true", () => {
      const issues = validateConfig(leReady(true));
      expect(issues.some((i) => i.path === "http.letsEncrypt.email")).toBe(true);
    });
  });

  it("still validates HTTP hosts on a paused backend", () => {
    const issues = validateConfig(
      config({
        http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
        services: [
          {
            name: "web",
            type: "tcp",
            bindAddr: "0.0.0.0:8080",
            httpHosts: ["bad_host"],
            httpEnabled: false,
          },
        ],
      }),
    );
    expect(
      issues.some((i) => i.path === "services[0].httpHosts" && /HTTP host 1/.test(i.message)),
    ).toBe(true);
  });
});

describe("httpEnabled — proxy and hosts interplay", () => {
  const routedService = (httpEnabled?: boolean): RatholeService => ({
    name: "web",
    type: "tcp",
    bindAddr: "",
    httpHosts: ["app.example.com"],
    httpEnabled,
  });

  describe("public bind and the proxy switch", () => {
    it("does not flag an empty public bind while the proxy is on (httpEnabled absent)", () => {
      const issues = validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [routedService(undefined)],
        }),
      );
      expect(issues.some((i) => i.path === "services[0].bindAddr")).toBe(false);
    });

    it("does not flag an empty public bind while the proxy is on (httpEnabled true)", () => {
      const issues = validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [routedService(true)],
        }),
      );
      expect(issues.some((i) => i.path === "services[0].bindAddr")).toBe(false);
    });

    it("flags the empty public bind once the proxy is off (httpEnabled absent)", () => {
      const issues = validateConfig(
        config({
          http: { enabled: false, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [routedService(undefined)],
        }),
      );
      expect(issues.some((i) => i.path === "services[0].bindAddr")).toBe(true);
    });

    it("flags the empty public bind once the proxy is off (httpEnabled true)", () => {
      const issues = validateConfig(
        config({
          http: { enabled: false, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [routedService(true)],
        }),
      );
      expect(issues.some((i) => i.path === "services[0].bindAddr")).toBe(true);
    });
  });

  describe("routing on without hosts", () => {
    it("flags services[i].httpHosts and mentions no hosts", () => {
      const issues = validateConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [
            { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpEnabled: true },
          ],
        }),
      );
      const hostIssue = issues.find((i) => i.path === "services[0].httpHosts");
      expect(hostIssue).toBeDefined();
      expect(hostIssue!.message).toMatch(/no hosts/i);
    });
  });

  describe("normalizeConfig httpEnabled retention", () => {
    it("keeps an explicit httpEnabled true on a service that has no hosts", () => {
      const normalized = normalizeConfig(
        config({
          services: [{ name: "ssh", type: "tcp", bindAddr: "0.0.0.0:22", httpEnabled: true }],
        }),
      );
      expect(normalized.services[0].httpEnabled).toBe(true);
    });

    it("drops httpEnabled false on a service that has no hosts", () => {
      const normalized = normalizeConfig(
        config({
          services: [{ name: "ssh", type: "tcp", bindAddr: "0.0.0.0:22", httpEnabled: false }],
        }),
      );
      expect(normalized.services[0].httpEnabled).toBeUndefined();
    });

    it("defaults httpEnabled to true for a service that has hosts", () => {
      const normalized = normalizeConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [{ name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHosts: ["app.example.com"] }],
        }),
      );
      expect(normalized.services[0].httpEnabled).toBe(true);
    });

    it("preserves httpEnabled false for a service that has hosts", () => {
      const normalized = normalizeConfig(
        config({
          http: { enabled: true, bindAddr: HTTP_PROXY_BIND_ADDR },
          services: [
            { name: "web", type: "tcp", bindAddr: "0.0.0.0:8080", httpHosts: ["app.example.com"], httpEnabled: false },
          ],
        }),
      );
      expect(normalized.services[0].httpEnabled).toBe(false);
    });
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

  it("emits HTTP-routed services as TCP rathole services", () => {
    const toml = generateClientToml(
      config({
        services: [{ name: "app", type: "tcp", bindAddr: "0.0.0.0:8443", httpHost: "app.example.com" }],
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
