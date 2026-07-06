import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentCommand,
  BrowserToHub,
  HubToBrowser,
  InstanceView,
} from "@shared/types";
import { getToken } from "@/lib/api";

export interface LogLine {
  instanceId: string;
  line: string;
  stream?: "stdout" | "stderr";
  ts: number;
}

type ConnState = "connecting" | "open" | "closed";

/**
 * Maintains a live WebSocket to the hub, keeping an up-to-date map of instances
 * and a rolling buffer of logs for whichever instance is subscribed.
 */
export function useHubSocket() {
  const [instances, setInstances] = useState<Map<string, InstanceView>>(new Map());
  const [conn, setConn] = useState<ConnState>("connecting");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const logSubRef = useRef<string | null>(null);
  const retryRef = useRef(0);
  const closedRef = useRef(false);

  const send = useCallback((msg: BrowserToHub) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const connect = useCallback(() => {
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    setConn("connecting");

    ws.onopen = () => {
      retryRef.current = 0;
      setConn("open");
      ws.send(JSON.stringify({ type: "subscribe" } satisfies BrowserToHub));
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
        case "snapshot":
          setInstances(new Map(msg.instances.map((i) => [i.id, i])));
          break;
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
  }, []);

  useEffect(() => {
    closedRef.current = false;
    connect();
    return () => {
      closedRef.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

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

  const command = useCallback(
    (instanceId: string, cmd: AgentCommand) => send({ type: "command", instanceId, command: cmd }),
    [send],
  );

  return {
    instances: [...instances.values()].sort((a, b) => a.createdAt - b.createdAt),
    instanceMap: instances,
    conn,
    logs,
    subscribeLogs,
    unsubscribeLogs,
    command,
  };
}
