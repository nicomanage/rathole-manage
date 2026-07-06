import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserToHub,
  HubToBrowser,
  InstanceView,
} from "@shared/types";
import { api } from "@/lib/api";

export interface LogLine {
  instanceId: string;
  line: string;
  stream?: "stdout" | "stderr";
  ts: number;
}

type ConnState = "connecting" | "open" | "closed";

/**
 * Loads queryable state through REST, then uses WebSocket only for live instance
 * deltas and a rolling log stream for the subscribed instance.
 */
export function useHubSocket() {
  const [instances, setInstances] = useState<Map<string, InstanceView>>(new Map());
  const [conn, setConn] = useState<ConnState>("connecting");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const logSubRef = useRef<string | null>(null);
  const retryRef = useRef(0);
  const closedRef = useRef(false);
  const initialLoadSettledRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const { instances: loaded } = await api.listInstances();
      setInstances(new Map(loaded.map((instance) => [instance.id, instance])));
      setLoadError(null);
    } catch (error) {
      setLoadError((error as Error).message);
      throw error;
    } finally {
      if (!initialLoadSettledRef.current) {
        initialLoadSettledRef.current = true;
        setLoading(false);
      }
    }
  }, []);

  const send = useCallback((msg: BrowserToHub) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    wsRef.current = ws;
    setConn("connecting");

    ws.onopen = () => {
      retryRef.current = 0;
      setConn("open");
      void refresh().catch(() => undefined);
      if (logSubRef.current)
        ws.send(JSON.stringify({ type: "subscribe_logs", instanceId: logSubRef.current }));
    };

    ws.onmessage = (ev) => {
      let msg: HubToBrowser;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case "instance_update":
          setInstances((prev) => new Map(prev).set(msg.instance.id, msg.instance));
          break;
        case "instance_removed":
          setInstances((prev) => {
            const next = new Map(prev);
            next.delete(msg.instanceId);
            return next;
          });
          break;
        case "log":
          setLogs((prev) => {
            const next = [...prev, { instanceId: msg.instanceId, line: msg.line, stream: msg.stream, ts: msg.ts }];
            return next.length > 500 ? next.slice(-500) : next;
          });
          break;
      }
    };

    ws.onclose = () => {
      setConn("closed");
      if (closedRef.current) return;
      const delay = Math.min(1000 * 2 ** retryRef.current, 15000);
      retryRef.current++;
      setTimeout(connect, delay);
    };
    ws.onerror = () => ws.close();
  }, [refresh]);

  useEffect(() => {
    closedRef.current = false;
    void refresh().catch(() => undefined);
    connect();
    return () => {
      closedRef.current = true;
      wsRef.current?.close();
    };
  }, [connect, refresh]);

  const subscribeLogs = useCallback(
    (instanceId: string) => {
      if (logSubRef.current && logSubRef.current !== instanceId)
        send({ type: "unsubscribe_logs", instanceId: logSubRef.current });
      logSubRef.current = instanceId;
      setLogs([]);
      send({ type: "subscribe_logs", instanceId });
    },
    [send],
  );

  const unsubscribeLogs = useCallback(() => {
    if (logSubRef.current) send({ type: "unsubscribe_logs", instanceId: logSubRef.current });
    logSubRef.current = null;
  }, [send]);

  return {
    instances: [...instances.values()].sort((a, b) => a.createdAt - b.createdAt),
    instanceMap: instances,
    conn,
    loading,
    loadError,
    logs,
    subscribeLogs,
    unsubscribeLogs,
    refresh,
  };
}
