import { describe, expect, it } from "vitest";
import { accumulateMonthlyTraffic, monthKey } from "./traffic";
import type { Instance } from "@shared/types";

type State = Pick<Instance, "traffic" | "monthlyTraffic">;

const JULY = new Date("2026-07-15T00:00:00Z");
const AUG = new Date("2026-08-02T00:00:00Z");

describe("monthKey", () => {
  it("formats UTC year-month", () => {
    expect(monthKey(new Date("2026-07-15T23:00:00Z"))).toBe("2026-07");
    expect(monthKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
});

describe("accumulateMonthlyTraffic", () => {
  it("counts the full first snapshot", () => {
    const inst: State = {};
    accumulateMonthlyTraffic(inst, { ssh: { bytesIn: 100, bytesOut: 300 } }, JULY);
    expect(inst.monthlyTraffic?.["2026-07"]).toEqual({ bytesIn: 100, bytesOut: 300 });
  });

  it("adds only the delta between cumulative snapshots", () => {
    const inst: State = { traffic: { ssh: { bytesIn: 100, bytesOut: 300 } } };
    inst.monthlyTraffic = { "2026-07": { bytesIn: 100, bytesOut: 300 } };
    accumulateMonthlyTraffic(inst, { ssh: { bytesIn: 150, bytesOut: 500 } }, JULY);
    expect(inst.monthlyTraffic["2026-07"]).toEqual({ bytesIn: 150, bytesOut: 500 });
  });

  it("treats a counter drop (agent restart) as a fresh delta", () => {
    const inst: State = { traffic: { ssh: { bytesIn: 1000, bytesOut: 2000 } } };
    inst.monthlyTraffic = { "2026-07": { bytesIn: 1000, bytesOut: 2000 } };
    // Agent restarted: counter reset, now reporting a small cumulative again.
    accumulateMonthlyTraffic(inst, { ssh: { bytesIn: 40, bytesOut: 90 } }, JULY);
    expect(inst.monthlyTraffic["2026-07"]).toEqual({ bytesIn: 1040, bytesOut: 2090 });
  });

  it("buckets deltas by month", () => {
    const inst: State = { traffic: { ssh: { bytesIn: 100, bytesOut: 100 } } };
    inst.monthlyTraffic = { "2026-07": { bytesIn: 100, bytesOut: 100 } };
    accumulateMonthlyTraffic(inst, { ssh: { bytesIn: 250, bytesOut: 250 } }, AUG);
    expect(inst.monthlyTraffic["2026-07"]).toEqual({ bytesIn: 100, bytesOut: 100 });
    expect(inst.monthlyTraffic["2026-08"]).toEqual({ bytesIn: 150, bytesOut: 150 });
  });

  it("sums across multiple services", () => {
    const inst: State = {};
    accumulateMonthlyTraffic(
      inst,
      { ssh: { bytesIn: 10, bytesOut: 20 }, web: { bytesIn: 5, bytesOut: 7 } },
      JULY,
    );
    expect(inst.monthlyTraffic?.["2026-07"]).toEqual({ bytesIn: 15, bytesOut: 27 });
  });
});
