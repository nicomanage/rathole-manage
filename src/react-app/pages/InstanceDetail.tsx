import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useHubSocket } from "@/hooks/useHubSocket";
import { api } from "@/lib/api";
import {
  generateClientToml,
  generateServerToml,
  validateConfig,
} from "@shared/config-generator";
import type { InstanceView, RatholeConfig, RatholeService, TransportType } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodeBlock } from "@/components/CodeBlock";
import { StatusDot, ProcessBadge } from "@/components/StatusBadge";
import { relativeTime } from "@/lib/utils";
import {
  ArrowLeft,
  Play,
  Square,
  RotateCw,
  Trash2,
  Plus,
  Save,
  AlertTriangle,
  Cpu,
  MemoryStick,
  Clock,
  Tag,
} from "lucide-react";
import { toast } from "sonner";

const TRANSPORTS: TransportType[] = ["tcp", "tls", "noise", "websocket"];

export function InstanceDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { instanceMap, command } = useHubSocket();
  const instance = instanceMap.get(id);

  if (!instance) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => nav("/")}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <p className="text-muted-foreground">Loading instance…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={() => nav("/")}>
        <ArrowLeft className="h-4 w-4" /> All instances
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
            <StatusDot status={instance.status} />
            {instance.name}
          </h1>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ProcessBadge state={instance.processState} />
            <span>·</span>
            <span>seen {relativeTime(instance.lastSeen)}</span>
            {instance.metrics?.configInSync === false && (
              <Badge variant="destructive">config drift</Badge>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={instance.status !== "online"}
            onClick={() => command(id, "start")}
          >
            <Play className="h-4 w-4" /> Start
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={instance.status !== "online"}
            onClick={() => command(id, "restart")}
          >
            <RotateCw className="h-4 w-4" /> Restart
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={instance.status !== "online"}
            onClick={() => command(id, "stop")}
          >
            <Square className="h-4 w-4" /> Stop
          </Button>
          <DeleteButton id={id} name={instance.name} onDeleted={() => nav("/")} />
        </div>
      </div>

      <MetricsRow instance={instance} />

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="files">Config files</TabsTrigger>
          <TabsTrigger value="logs">Live logs</TabsTrigger>
          <TabsTrigger value="agent">Agent setup</TabsTrigger>
        </TabsList>

        <TabsContent value="config">
          <ConfigEditor
            id={id}
            initial={instance.config}
            name={instance.name}
            publicHost={instance.publicHost}
          />
        </TabsContent>
        <TabsContent value="files">
          <ConfigFiles config={instance.config} publicHost={instance.publicHost} name={instance.name} />
        </TabsContent>
        <TabsContent value="logs">
          <LogsPanel id={id} />
        </TabsContent>
        <TabsContent value="agent">
          <AgentSetup id={id} bindAddr={instance.config.bindAddr} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MetricsRow({ instance }: { instance: InstanceView }) {
  const m = instance.metrics ?? {};
  const items = [
    { icon: Cpu, label: "CPU", value: m.cpuPercent != null ? `${m.cpuPercent.toFixed(0)}%` : "—" },
    { icon: MemoryStick, label: "Memory", value: m.memoryMb != null ? `${m.memoryMb.toFixed(0)} MB` : "—" },
    {
      icon: Clock,
      label: "Uptime",
      value: m.uptimeSeconds != null ? formatUptime(m.uptimeSeconds) : "—",
    },
    { icon: Tag, label: "rathole", value: m.ratholeVersion ?? "—" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((it) => (
        <Card key={it.label}>
          <CardContent className="flex items-center gap-3 py-4">
            <it.icon className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">{it.label}</p>
              <p className="font-mono text-sm">{it.value}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function ConfigEditor({
  id,
  initial,
  name,
  publicHost,
}: {
  id: string;
  initial: RatholeConfig;
  name: string;
  publicHost?: string;
}) {
  const [config, setConfig] = useState<RatholeConfig>(structuredClone(initial));
  const [saving, setSaving] = useState(false);
  const issues = useMemo(() => validateConfig(config), [config]);
  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(initial),
    [config, initial],
  );

  // Re-sync if the server pushes an update while we're not editing.
  useEffect(() => {
    if (!dirty) setConfig(structuredClone(initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initial)]);

  function patch(p: Partial<RatholeConfig>) {
    setConfig((c) => ({ ...c, ...p }));
  }

  function updateService(i: number, p: Partial<RatholeService>) {
    setConfig((c) => {
      const services = c.services.slice();
      services[i] = { ...services[i], ...p };
      return { ...c, services };
    });
  }

  function addService() {
    setConfig((c) => ({
      ...c,
      services: [
        ...c.services,
        {
          name: `service_${c.services.length + 1}`,
          type: "tcp",
          bindAddr: "0.0.0.0:5000",
          clientLocalAddr: "127.0.0.1:8080",
        },
      ],
    }));
  }

  function removeService(i: number) {
    setConfig((c) => ({ ...c, services: c.services.filter((_, idx) => idx !== i) }));
  }

  async function save() {
    if (issues.length > 0) {
      toast.error("Fix validation issues before saving");
      return;
    }
    setSaving(true);
    try {
      await api.updateInstance(id, { config });
      toast.success("Configuration saved & pushed to agent");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Control channel</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Bind address</Label>
            <Input
              className="font-mono"
              value={config.bindAddr}
              onChange={(e) => patch({ bindAddr: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Default token</Label>
            <Input
              className="font-mono"
              placeholder="shared secret"
              value={config.defaultToken ?? ""}
              onChange={(e) => patch({ defaultToken: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Transport</Label>
            <Select value={config.transport} onValueChange={(v) => patch({ transport: v as TransportType })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSPORTS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Heartbeat interval (s)</Label>
            <Input
              type="number"
              value={config.heartbeatInterval ?? ""}
              placeholder="30"
              onChange={(e) =>
                patch({ heartbeatInterval: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Services ({config.services.length})</CardTitle>
          <Button variant="outline" size="sm" onClick={addService}>
            <Plus className="h-4 w-4" /> Add service
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {config.services.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No services. Add one to forward a port from behind NAT.
            </p>
          )}
          {config.services.map((svc, i) => (
            <div key={i} className="rounded-lg border p-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Name</Label>
                  <Input
                    className="font-mono"
                    value={svc.name}
                    onChange={(e) => updateService(i, { name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Type</Label>
                  <Select value={svc.type} onValueChange={(v) => updateService(i, { type: v as "tcp" | "udp" })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tcp">tcp</SelectItem>
                      <SelectItem value="udp">udp</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Public bind (server)</Label>
                  <Input
                    className="font-mono"
                    value={svc.bindAddr}
                    onChange={(e) => updateService(i, { bindAddr: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Local addr (client)</Label>
                  <Input
                    className="font-mono"
                    placeholder="127.0.0.1:22"
                    value={svc.clientLocalAddr ?? ""}
                    onChange={(e) => updateService(i, { clientLocalAddr: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Token (optional)</Label>
                  <Input
                    className="font-mono"
                    placeholder="inherits default"
                    value={svc.token ?? ""}
                    onChange={(e) => updateService(i, { token: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-2 pt-6">
                  <Switch
                    checked={!!svc.nodelay}
                    onCheckedChange={(v) => updateService(i, { nodelay: v })}
                  />
                  <Label className="text-xs">nodelay</Label>
                </div>
                <div className="flex items-end justify-end pt-6 lg:col-span-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeService(i)}
                  >
                    <Trash2 className="h-4 w-4" /> Remove
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {issues.length > 0 && (
        <Card className="border-destructive/40">
          <CardContent className="space-y-1.5 py-4 text-sm">
            {issues.map((iss, i) => (
              <p key={i} className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {iss.message}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="sticky bottom-4 flex items-center justify-end gap-3">
        {dirty && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
        <Button onClick={save} disabled={!dirty || saving || issues.length > 0}>
          <Save className="h-4 w-4" />
          {saving ? "Saving…" : "Save & push"}
        </Button>
      </div>

      {/* keep a live preview to reduce guesswork */}
      <details className="rounded-lg border">
        <summary className="cursor-pointer px-4 py-2 text-sm text-muted-foreground">
          Preview generated server.toml for "{name}"
          {publicHost ? ` (public host ${publicHost})` : ""}
        </summary>
        <div className="p-4 pt-0">
          <CodeBlock code={generateServerToml(config, name)} language="toml" />
        </div>
      </details>
    </div>
  );
}

function ConfigFiles({
  config,
  publicHost,
  name,
}: {
  config: RatholeConfig;
  publicHost?: string;
  name: string;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <p className="text-sm font-medium">server.toml</p>
        <p className="text-xs text-muted-foreground">
          Runs on this node. The agent applies it automatically — download only if configuring by hand.
        </p>
        <CodeBlock code={generateServerToml(config, name)} filename="server.toml" />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">client.toml</p>
        <p className="text-xs text-muted-foreground">
          Run this on the machine behind NAT to expose its local services.
        </p>
        <CodeBlock code={generateClientToml(config, publicHost)} filename="client.toml" />
      </div>
    </div>
  );
}

function LogsPanel({ id }: { id: string }) {
  const { logs, subscribeLogs, unsubscribeLogs } = useHubSocket();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    subscribeLogs(id);
    return () => unsubscribeLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const filtered = logs.filter((l) => l.instanceId === id);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [filtered.length]);

  return (
    <Card>
      <CardContent className="p-0">
        <div ref={scrollRef} className="h-[420px] overflow-y-auto p-4 font-mono text-xs leading-relaxed">
          {filtered.length === 0 ? (
            <p className="text-muted-foreground">
              Waiting for logs… the agent streams rathole output here in real time.
            </p>
          ) : (
            filtered.map((l, i) => (
              <div
                key={i}
                className={l.stream === "stderr" ? "text-destructive" : "text-foreground/90"}
              >
                <span className="mr-2 text-muted-foreground">
                  {new Date(l.ts).toLocaleTimeString()}
                </span>
                {l.line}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AgentSetup({ id, bindAddr }: { id: string; bindAddr: string }) {
  const [token, setRevealed] = useState<string | null>(null);
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/agent/ws`;

  async function reveal() {
    try {
      const { agentToken } = await api.revealToken(id);
      setRevealed(agentToken);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const env = [
    `# on your rathole server:`,
    `export HUB_URL="${wsUrl}"`,
    `export INSTANCE_ID="${id}"`,
    `export AGENT_TOKEN="${token ?? "<click reveal token>"}"`,
    ``,
    `# build & run the Rust agent (embeds rathole, no separate binary needed):`,
    `cargo run --release`,
  ].join("\n");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connect the Rust agent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            The agent is a small Rust binary that depends on the <code className="font-mono">rathole</code>{" "}
            crate and runs the server <span className="font-medium">in-process</span>. It dials this hub over
            WebSocket, applies the config the panel generates, and streams logs back. Source is in{" "}
            <code className="font-mono">/agent</code>.
          </p>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={reveal}>
              {token ? "Token revealed below" : "Reveal agent token"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Listens on <code className="font-mono">{bindAddr}</code>
            </span>
          </div>
          <CodeBlock code={env} filename="agent.env" language="bash" />
        </CardContent>
      </Card>
    </div>
  );
}

function DeleteButton({
  id,
  name,
  onDeleted,
}: {
  id: string;
  name: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await api.deleteInstance(id);
      toast.success(`Deleted "${name}"`);
      onDeleted();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" className="text-destructive" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" /> Delete
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete "{name}"?</DialogTitle>
          <DialogDescription>
            This removes the instance and disconnects its agent. The rathole process on the server is
            left as-is. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
