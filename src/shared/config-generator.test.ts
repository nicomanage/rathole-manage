import { describe, expect, it } from "vitest";
import { defaultConfig, validateConfig } from "./config-generator";
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
});

describe("hashServerConfig", () => {
  it("is deterministic and changes with content", () => {
    const a = hashServerConfig("hello");
    expect(a).toBe(hashServerConfig("hello"));
    expect(a).not.toBe(hashServerConfig("hello!"));
  });
});
