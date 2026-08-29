import { describe, expect, it } from "vitest";
import { mergeAgentState, parseAgentReport } from "./agent-reports";
import type { Instance } from "@shared/types";

const instance: Instance = {
  id: "node-1",
  name: "node",
  agentToken: "secret",
  config: { bindAddr: "0.0.0.0:2333", transport: "tcp", services: [] },
  status: "online",
  processState: "running",
  createdAt: 1,
  updatedAt: 1,
};

describe("parseAgentReport", () => {
  it("accepts a valid status report", () => {
    expect(parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        traffic: { ssh: { bytesIn: 10, bytesOut: 20 } },
      },
    })).not.toBeNull();
  });

  it("rejects invalid and negative counters", () => {
    expect(parseAgentReport({ reportedAt: 100, status: { type: "log" } })).toBeNull();
    expect(parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        traffic: { ssh: { bytesIn: -1, bytesOut: 20 } },
      },
    })).toBeNull();
  });
});

describe("parseAgentReport tolerance", () => {
  it("accepts a status report whose metrics is null and normalizes it to undefined", () => {
    const result = parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        metrics: null,
      },
    });
    expect(result).not.toBeNull();
    expect(result?.status.metrics).toBeUndefined();
  });

  it("rejects a status report whose metrics is neither undefined, null, nor a plain object", () => {
    expect(parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        metrics: "cpu",
      },
    })).toBeNull();
    expect(parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        metrics: [],
      },
    })).toBeNull();
  });

  it("accepts a well-formed certificate, rejects an unknown state and an array certificate", () => {
    expect(parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        certificate: { domains: ["app.example.com"], staging: false, state: "valid", checkedAt: 1 },
      },
    })).not.toBeNull();
    expect(parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        certificate: { domains: ["app.example.com"], staging: false, state: "expiring", checkedAt: 1 },
      },
    })).toBeNull();
    expect(parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        certificate: [],
      },
    })).toBeNull();
  });

  it("accepts a string error but rejects a numeric error", () => {
    expect(parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        error: "boom",
      },
    })).not.toBeNull();
    expect(parseAgentReport({
      reportedAt: 100,
      status: {
        type: "status",
        processState: "running",
        error: 42,
      },
    })).toBeNull();
  });
});

describe("mergeAgentState", () => {
  it("uses a fresh D1 report while the control socket is connected", () => {
    const view = mergeAgentState(instance, {
      reportedAt: 1_000,
      receivedAt: 1_000,
      processState: "stopped",
      metrics: { cpuPercent: 12 },
    }, true);
    expect(view.status).toBe("online");
    expect(view.processState).toBe("stopped");
    expect(view.metrics?.cpuPercent).toBe(12);
  });

  it("uses only the control WebSocket for online state", () => {
    expect(mergeAgentState(instance, undefined, false).status).toBe("offline");
    expect(mergeAgentState(instance, undefined, true).status).toBe("online");
    expect(mergeAgentState(instance, {
      reportedAt: 1,
      receivedAt: 1,
      processState: "running",
    }, true).status).toBe("online");
  });

  it("keeps a newer legacy WebSocket snapshot during a rolling agent upgrade", () => {
    const legacy = {
      ...instance,
      lastSeen: 3_000,
      traffic: { ssh: { bytesIn: 50, bytesOut: 70 } },
      monthlyTraffic: { "2026-08": { bytesIn: 50, bytesOut: 70 } },
    };
    const view = mergeAgentState(legacy, {
      reportedAt: 2_000,
      receivedAt: 2_000,
      processState: "stopped",
      traffic: { ssh: { bytesIn: 10, bytesOut: 10 } },
      monthlyTraffic: { "2026-08": { bytesIn: 10, bytesOut: 10 } },
    }, true);
    expect(view.processState).toBe("running");
    expect(view.monthlyTraffic?.["2026-08"]).toEqual({ bytesIn: 50, bytesOut: 70 });
  });
});
