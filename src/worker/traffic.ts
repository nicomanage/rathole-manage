// Monthly traffic accounting for the hub.
//
// Agents report *cumulative* per-service byte counters since their process
// started, so the counter resets to 0 on agent restart. We keep the last
// reported snapshot (persisted as `instance.traffic`) and, on each new report,
// add the delta into the current UTC month's bucket. A drop in the counter is
// treated as a restart (the whole new value is the delta).

import type { Instance, TrafficStat } from "@shared/types";

/** UTC month key like "2026-07". */
export function monthKey(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

type TrafficState = Pick<Instance, "traffic" | "monthlyTraffic">;

/** Fold a new cumulative per-service snapshot into the instance's monthly totals. */
export function accumulateMonthlyTraffic(
  inst: TrafficState,
  next: Record<string, TrafficStat>,
  now: Date = new Date(),
): void {
  const prev = inst.traffic ?? {};
  const key = monthKey(now);
  const monthly = (inst.monthlyTraffic ??= {});
  const bucket = (monthly[key] ??= { bytesIn: 0, bytesOut: 0 });

  for (const [name, cur] of Object.entries(next)) {
    const before = prev[name];
    bucket.bytesIn +=
      before && cur.bytesIn >= before.bytesIn ? cur.bytesIn - before.bytesIn : cur.bytesIn;
    bucket.bytesOut +=
      before && cur.bytesOut >= before.bytesOut ? cur.bytesOut - before.bytesOut : cur.bytesOut;
  }
}
