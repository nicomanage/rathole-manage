import { describe, expect, it } from "vitest";
import { defaultConfig, generateClientToml, validateConfig } from "./config-generator";
import { generateServerToml, hashServerConfig } from "../worker/server-config";
import type { RatholeConfig } from "./types";

function config(overrides: Partial<RatholeConfig> = {}): RatholeConfig {
  return {
    ...defaultConfig(),
    bindAddr: "0.0.0.0:2333",
    defaultToken: "secret",
    transport: "tcp",
    services: [
      { name: "ssh", type: "tcp", bindAddr: "0.0.0.0:5202", clientLocalAddr: "127.0.0.1:22" },
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
});

describe("generateServerToml", () => {
  it("emits server + service tables with tokens", () => {
    const toml = generateServerToml(config(), "edge-1");
    expect(toml).toContain("[server]");
    expect(toml).toContain('bind_addr = "0.0.0.0:2333"');
    expect(toml).toContain('default_token = "secret"');
    expect(toml).toContain("[server.services.ssh]");
    expect(toml).toContain('bind_addr = "0.0.0.0:5202"');
  });

  it("quotes service names that are not bare keys", () => {
    const toml = generateServerToml(
      config({ services: [{ name: "my nas", type: "tcp", bindAddr: "0.0.0.0:1" }] }),
    );
    expect(toml).toContain('[server.services."my nas"]');
  });

  it("emits an empty services map when no services are configured", () => {
    const toml = generateServerToml(config({ services: [] }));
    expect(toml).toContain("services = {}");
  });
});

describe("generateClientToml", () => {
  it("uses the public host and a sensible local default", () => {
    const toml = generateClientToml(config(), "tunnel.example.com");
    expect(toml).toContain('remote_addr = "tunnel.example.com:2333"');
    expect(toml).toContain("[client.services.ssh]");
    expect(toml).toContain('local_addr = "127.0.0.1:22"');
  });
});

describe("hashServerConfig", () => {
  it("is deterministic and changes with content", () => {
    const a = hashServerConfig("hello");
    expect(a).toBe(hashServerConfig("hello"));
    expect(a).not.toBe(hashServerConfig("hello!"));
  });
});
