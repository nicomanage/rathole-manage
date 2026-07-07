import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useHubSocket } from "@/hooks/useHubSocket";
import { api } from "@/lib/api";
import { validateConfig } from "@shared/config-generator";
import type {
  AgentCommand,
  InstanceView,
  RatholeConfig,
  RatholeService,
  TransportType,
} from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
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
import { cn, relativeTime } from "@/lib/utils";
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
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

const TRANSPORTS: TransportType[] = ["tcp", "tls", "noise", "websocket"];

export function InstanceDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { instanceMap, loading, loadError, refresh } = useHubSocket();
  const { isAdmin } = useAuth();
  const [pendingCommand, setPendingCommand] = useState<AgentCommand | null>(null);
  const instance = instanceMap.get(id);

  async function runCommand(command: AgentCommand) {
    setPendingCommand(command);
    try {
      const { delivered } = await api.sendCommand(id, command);
      if (delivered) toast.success(`${command} command sent`);
      else toast.error("Agent is offline");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setPendingCommand(null);
    }
  }

  if (!instance) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => nav("/")}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        {loading ? (
          <p className="text-muted-foreground">Loading instance…</p>
        ) : loadError ? (
          <Card className="border-destructive/40">
            <CardContent className="flex items-center justify-between gap-4 py-4">
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Failed to load instance: {loadError}
              </p>
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <p className="text-muted-foreground">Instance not found.</p>
        )}
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
        {isAdmin && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={instance.status !== "online" || pendingCommand !== null}
              onClick={() => void runCommand("start")}
            >
              <Play className="h-4 w-4" /> Start
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={instance.status !== "online" || pendingCommand !== null}
              onClick={() => void runCommand("restart")}
            >
              <RotateCw className="h-4 w-4" /> Restart
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={instance.status !== "online" || pendingCommand !== null}
              onClick={() => void runCommand("stop")}
            >
              <Square className="h-4 w-4" /> Stop
            </Button>
            <DeleteButton id={id} name={instance.name} onDeleted={() => nav("/")} />
          </div>
        )}
      </div>

      <MetricsRow instance={instance} />

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="logs">Live logs</TabsTrigger>
          <TabsTrigger value="agent">Agent setup</TabsTrigger>
        </TabsList>

        <TabsContent value="config">
          <ConfigEditor
            id={id}
            initial={instance.config}
            serviceStatus={instance.serviceStatus}
            online={instance.status === "online"}
            canEdit={isAdmin}
          />
        </TabsContent>
        <TabsContent value="logs">
          <LogsPanel id={id} />
        </TabsContent>
        <TabsContent value="agent">
          <AgentSetup id={id} bindAddr={instance.config.bindAddr} canReveal={isAdmin} />
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

function ServiceStatusDot({ state }: { state: "online" | "offline" | "unknown" }) {
  const map = {
    online: { cls: "bg-success", title: "Online — a client is connected" },
    offline: { cls: "bg-muted-foreground/40", title: "Offline — no client connected" },
    unknown: { cls: "bg-muted-foreground/25", title: "Unknown (node offline or unsaved)" },
  } as const;
  const { cls, title } = map[state];
  return (
    <span className="inline-flex items-center" title={title}>
      <span className={cn("h-2.5 w-2.5 rounded-full", cls)} />
    </span>
  );
}

function ConfigEditor({
  id,
  initial,
  serviceStatus,
  online,
  canEdit,
}: {
  id: string;
  initial: RatholeConfig;
  serviceStatus?: Record<string, boolean>;
  online: boolean;
  canEdit: boolean;
}) {
  const [config, setConfig] = useState<RatholeConfig>(structuredClone(initial));
  const [saving, setSaving] = useState(false);
  const issues = useMemo(() => validateConfig(config), [config]);
  const issueByPath = useMemo(
    () => new Map(issues.map((issue) => [issue.path, issue.message])),
    [issues],
  );
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

  function serviceState(name: string): "online" | "offline" | "unknown" {
    if (!online || !serviceStatus || !(name in serviceStatus)) return "unknown";
    return serviceStatus[name] ? "online" : "offline";
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
              aria-invalid={issueByPath.has("bindAddr")}
              className={cn("font-mono", issueByPath.has("bindAddr") && "border-destructive")}
              value={config.bindAddr}
              disabled={!canEdit}
              onChange={(e) => patch({ bindAddr: e.target.value })}
            />
            {issueByPath.has("bindAddr") && (
              <p className="text-xs text-destructive">{issueByPath.get("bindAddr")}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Default token</Label>
            <Input
              className="font-mono"
              placeholder="shared secret"
              value={config.defaultToken ?? ""}
              disabled={!canEdit}
              onChange={(e) => patch({ defaultToken: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Transport</Label>
            <Select
              value={config.transport}
              disabled={!canEdit}
              onValueChange={(v) => patch({ transport: v as TransportType })}
            >
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
              disabled={!canEdit}
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
          {canEdit && (
            <Button variant="outline" size="sm" onClick={addService}>
              <Plus className="h-4 w-4" /> Add service
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {config.services.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              No services. {canEdit ? "Add one to forward a port from behind NAT." : ""}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 text-center">Online</TableHead>
                  <TableHead className="min-w-32">Name</TableHead>
                  <TableHead className="w-24">Type</TableHead>
                  <TableHead className="min-w-40">Public bind (server)</TableHead>
                  <TableHead className="min-w-36">Token</TableHead>
                  <TableHead className="w-20 text-center">nodelay</TableHead>
                  {canEdit && <TableHead className="w-12" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {config.services.map((svc, i) => {
                  const publicBindIssue = issueByPath.get(`services[${i}].bindAddr`);
                  return (
                    <TableRow key={i} className="align-top">
                      <TableCell className="text-center">
                        <ServiceStatusDot state={serviceState(svc.name)} />
                      </TableCell>
                      <TableCell>
                        <Input
                          className="h-8 font-mono"
                          value={svc.name}
                          disabled={!canEdit}
                          onChange={(e) => updateService(i, { name: e.target.value })}
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={svc.type}
                          disabled={!canEdit}
                          onValueChange={(v) => updateService(i, { type: v as "tcp" | "udp" })}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="tcp">tcp</SelectItem>
                            <SelectItem value="udp">udp</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-invalid={!!publicBindIssue}
                          className={cn("h-8 font-mono", publicBindIssue && "border-destructive")}
                          value={svc.bindAddr}
                          disabled={!canEdit}
                          onChange={(e) => updateService(i, { bindAddr: e.target.value })}
                        />
                        {publicBindIssue && (
                          <p className="mt-1 text-xs text-destructive">{publicBindIssue}</p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Input
                          className="h-8 font-mono"
                          placeholder="inherits default"
                          value={svc.token ?? ""}
                          disabled={!canEdit}
                          onChange={(e) => updateService(i, { token: e.target.value })}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={!!svc.nodelay}
                          disabled={!canEdit}
                          onCheckedChange={(v) => updateService(i, { nodelay: v })}
                        />
                      </TableCell>
                      {canEdit && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            title="Remove service"
                            onClick={() => removeService(i)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
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

      {canEdit && (
        <div className="sticky bottom-4 flex items-center justify-end gap-3">
          {dirty && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
          <Button onClick={save} disabled={!dirty || saving || issues.length > 0}>
            <Save className="h-4 w-4" />
            {saving ? "Saving…" : "Save & push"}
          </Button>
        </div>
      )}
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
              Waiting for logs… recent agent and rathole output appears here.
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

function AgentSetup({
  id,
  bindAddr,
  canReveal,
}: {
  id: string;
  bindAddr: string;
  canReveal: boolean;
}) {
  const [token, setRevealed] = useState<string | null>(null);
  const origin = location.origin;

  async function reveal() {
    try {
      const { agentToken } = await api.revealToken(id);
      setRevealed(agentToken);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const loginFlow = [
    `# on your rathole server, after installing rathole-agent:`,
    `rathole-agent login    # sign in with your panel account at ${origin}`,
    `#   → enrolls the node and connects it automatically`,
  ].join("\n");

  const staticFlow = [
    `# alternative: provision this instance statically (no interactive login)`,
    `export HUB_URL="${origin}"`,
    `export INSTANCE_ID="${id}"`,
    `export AGENT_TOKEN="${token ?? "<click reveal token>"}"`,
    `rathole-agent run`,
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
            crate and runs the server <span className="font-medium">in-process</span>. Nodes enroll
            themselves via <code className="font-mono">rathole-agent login</code>; this instance was
            created by that flow. Source is in <code className="font-mono">/agent</code>.
          </p>
          <CodeBlock code={loginFlow} filename="enroll.sh" language="bash" />
          {canReveal && (
            <>
              <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" onClick={reveal}>
                  {token ? "Token revealed below" : "Reveal agent token"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  Listens on <code className="font-mono">{bindAddr}</code>
                </span>
              </div>
              <CodeBlock code={staticFlow} filename="agent.env" language="bash" />
            </>
          )}
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
