import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useHubSocket } from "@/hooks/useHubSocket";
import { api } from "@/lib/api";
import {
  generateClientGlobalToml,
  generateClientServiceToml,
  HTTP_PROXY_BIND_ADDR,
  HTTPS_PROXY_BIND_ADDR,
  normalizeConfig,
  parseHttpHostsInput,
  serviceHttpHosts,
  validateConfig,
} from "@shared/config-generator";
import type {
  AgentCommand,
  CertificateStatus,
  HttpProxyConfig,
  InstanceView,
  RatholeConfig,
  RatholeService,
  ServiceType,
  TrafficStat,
  TransportType,
} from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { cn, formatBytes, relativeTime } from "@/lib/utils";
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
  Pencil,
  Globe,
  LockKeyhole,
  FileKey,
  Shield,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { toast } from "sonner";

const TRANSPORTS: TransportType[] = ["tcp", "tls", "noise", "websocket"];
const BASIC_SERVICE_TYPES: ServiceType[] = ["tcp", "udp"];

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

  // Control buttons are mutually exclusive by process state: Start only when
  // not running; Stop/Restart only when running.
  const controls = {
    online: instance.status === "online",
    running: instance.processState === "running",
    busy: pendingCommand !== null,
  };

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
            {isAdmin && <EditNodeDialog id={id} name={instance.name} />}
          </h1>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ProcessBadge state={instance.processState} />
            <span>·</span>
            <span>seen {relativeTime(instance.lastSeen)}</span>
            {instance.metrics?.configInSync === false && (
              <Badge variant="destructive">config drift</Badge>
            )}
          </div>
          {instance.lastError && (
            <p
              className="flex max-w-3xl items-start gap-1.5 text-xs text-destructive"
              title="Reported by the agent with its last status; clears once a start completes cleanly"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="font-mono break-all">{instance.lastError}</span>
            </p>
          )}
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!controls.online || controls.busy || controls.running}
              onClick={() => void runCommand("start")}
            >
              <Play className="h-4 w-4" /> Start
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!controls.online || controls.busy || !controls.running}
              onClick={() => void runCommand("restart")}
            >
              <RotateCw className="h-4 w-4" /> Restart
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!controls.online || controls.busy || !controls.running}
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
          <TabsTrigger value="http">HTTP</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="client">Client config</TabsTrigger>
          <TabsTrigger value="traffic">Traffic</TabsTrigger>
          <TabsTrigger value="logs">Live logs</TabsTrigger>
          <TabsTrigger value="agent">Agent setup</TabsTrigger>
        </TabsList>

        <ConfigEditor
          id={id}
          initial={instance.config}
          serviceStatus={instance.serviceStatus}
          traffic={instance.traffic}
          certificate={instance.certificate}
          online={instance.status === "online"}
          canEdit={isAdmin}
        />
        <TabsContent value="client">
          <ClientConfig config={instance.config} publicIp={instance.publicIp} />
        </TabsContent>
        <TabsContent value="traffic">
          <MonthlyTraffic monthly={instance.monthlyTraffic} live={instance.traffic} />
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

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

function MonthlyTraffic({
  monthly,
  live,
}: {
  monthly?: Record<string, TrafficStat>;
  live?: Record<string, TrafficStat>;
}) {
  const months = Object.entries(monthly ?? {}).sort(([a], [b]) => b.localeCompare(a));
  const liveTotal = Object.values(live ?? {}).reduce(
    (acc, t) => ({ bytesIn: acc.bytesIn + t.bytesIn, bytesOut: acc.bytesOut + t.bytesOut }),
    { bytesIn: 0, bytesOut: 0 },
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly traffic</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {months.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              No traffic recorded yet. Totals accumulate here per month as the node forwards data.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">↓ Out</TableHead>
                  <TableHead className="text-right">↑ In</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {months.map(([key, t]) => (
                  <TableRow key={key}>
                    <TableCell className="font-medium">{monthLabel(key)}</TableCell>
                    <TableCell className="text-right font-mono text-success">
                      {formatBytes(t.bytesOut)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {formatBytes(t.bytesIn)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatBytes(t.bytesIn + t.bytesOut)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Live counters (since the agent started): ↓ {formatBytes(liveTotal.bytesOut)} out · ↑{" "}
        {formatBytes(liveTotal.bytesIn)} in. Monthly totals are persisted and survive agent restarts.
      </p>
    </div>
  );
}

function ServiceStatusDot({ state }: { state: "online" | "offline" | "unknown" }) {
  const map = {
    online: { cls: "bg-success", title: "Online — a client is connected" },
    offline: { cls: "bg-yellow-500", title: "Waiting — running, no client connected" },
    unknown: { cls: "bg-muted-foreground/25", title: "Unknown (node offline or unsaved)" },
  } as const;
  const { cls, title } = map[state];
  return (
    <span className="inline-flex items-center" title={title}>
      <span className={cn("h-2.5 w-2.5 rounded-full", cls)} />
    </span>
  );
}

/** Which certificate an HTTP-routed backend is served with. */
type CertificateSource = "letsencrypt" | "custom";

function certificateSource(service: RatholeService): CertificateSource {
  return service.customCertificate?.enabled ? "custom" : "letsencrypt";
}

/** Per-host view of the single multi-SAN certificate the agent provisions. */
type HostCertState = "covered" | "failed" | "pending" | "unknown";

const HOST_STATES: Record<
  HostCertState,
  { dot: string; cls: string; label: string; title: string }
> = {
  covered: {
    dot: "bg-success",
    cls: "text-success",
    label: "Covered",
    title: "Covered by the current certificate",
  },
  failed: {
    dot: "bg-destructive",
    cls: "text-destructive",
    label: "Failed",
    title: "The last issuance attempt failed",
  },
  pending: {
    dot: "bg-muted-foreground/50",
    cls: "text-muted-foreground",
    label: "Pending",
    title: "Not in the current certificate — save to have it provisioned",
  },
  unknown: {
    dot: "bg-muted-foreground/25",
    cls: "text-muted-foreground",
    label: "Unknown",
    title: "Unknown (node offline, or nothing issued yet)",
  },
};

/** Overall panel state: the certificate's own state, or why there is none to show. */
type CertPanelState = CertificateStatus["state"] | "offline" | "unreported";

const CERT_PANEL_STATES: Record<
  CertPanelState,
  { icon: typeof Shield; chip: string; title: string }
> = {
  valid: { icon: ShieldCheck, chip: "bg-success/15 text-success", title: "Certificate active" },
  failed: { icon: ShieldX, chip: "bg-destructive/10 text-destructive", title: "Issuance failed" },
  pending: {
    icon: Shield,
    chip: "bg-muted text-muted-foreground",
    title: "Issuance pending",
  },
  offline: { icon: Shield, chip: "bg-muted text-muted-foreground", title: "Status unknown" },
  unreported: {
    icon: Shield,
    chip: "bg-muted text-muted-foreground",
    title: "Nothing reported yet",
  },
};

function daysUntil(epochMs: number): number {
  return Math.ceil((epochMs - Date.now()) / 86_400_000);
}

/**
 * Live state of the Let's Encrypt certificate for this node.
 *
 * The agent issues one certificate covering every host that is not served by
 * an operator-provided certificate, so a host's state is "is it in that
 * certificate's SAN set, and how is that certificate doing".
 */
function CertificatePanel({
  hosts,
  certificate,
  online,
  staging,
}: {
  hosts: string[];
  certificate?: CertificateStatus;
  online: boolean;
  staging: boolean;
}) {
  if (hosts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
        No backend uses Let's Encrypt yet. Assign HTTP hosts to a backend above and leave its
        certificate on “Let's Encrypt”; the hosts appear here as the certificate covers them.
      </div>
    );
  }

  // Only trust the report while the node is online; a stale one is "unknown".
  const cert = online ? certificate : undefined;
  const covered = new Set((cert?.domains ?? []).map((d) => d.toLowerCase()));
  const state: CertPanelState = !online ? "offline" : !cert ? "unreported" : cert.state;
  const meta = CERT_PANEL_STATES[state];

  function hostState(host: string): HostCertState {
    if (!cert) return "unknown";
    if (cert.state === "failed") return "failed";
    if (!covered.has(host.toLowerCase())) return "pending";
    if (cert.state === "pending") return "pending";
    return "covered";
  }

  const subtitle = !online
    ? "Node is offline — state refreshes when it reconnects."
    : !cert
      ? "The agent has not reported a certificate yet. Save to push this config to it."
      : `${cert.staging ? "Staging" : "Production"} · checked ${relativeTime(cert.checkedAt)}`;

  // 0 carries no expiry, same as absent: the agent has issued nothing yet.
  const notAfter = cert?.notAfter || undefined;
  const daysLeft = notAfter != null ? daysUntil(notAfter) : undefined;
  const expiryDate =
    notAfter != null
      ? new Date(notAfter).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : undefined;
  // Count what the rows below actually say, not bare SAN membership: a failed or
  // pending certificate covers nothing regardless of the domains it lists.
  const coveredCount = hosts.filter((h) => hostState(h) === "covered").length;

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-md", meta.chip)}>
            <meta.icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm leading-tight font-medium">{meta.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {cert && (
          <div className="shrink-0 text-right">
            {daysLeft == null ? (
              <>
                <p className="text-sm font-semibold text-muted-foreground">Not issued</p>
                <p className="text-[11px] text-muted-foreground">no expiry reported</p>
              </>
            ) : daysLeft > 0 ? (
              <>
                <p className="text-sm font-semibold tabular-nums">
                  {daysLeft} {daysLeft === 1 ? "day" : "days"}
                </p>
                <p className="text-[11px] text-muted-foreground">until expiry · {expiryDate}</p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-destructive">Expired</p>
                <p className="text-[11px] text-muted-foreground">{expiryDate}</p>
              </>
            )}
          </div>
        )}
      </div>

      {cert?.error && (
        <div className="border-t bg-destructive/5 px-3 py-2">
          <p className="text-[11px] font-medium tracking-wider text-destructive uppercase">
            Agent error
          </p>
          <p className="mt-1 font-mono text-xs break-words text-destructive/90">{cert.error}</p>
        </div>
      )}

      {cert && cert.staging !== staging && (
        <div className="flex items-start gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>
            This certificate came from the {cert.staging ? "staging" : "production"} directory.
            Save to re-issue from {staging ? "staging" : "production"}.
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-3 py-1.5">
        <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          Let's Encrypt hosts
        </span>
        {cert && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {coveredCount}/{hosts.length} covered
          </span>
        )}
      </div>
      <ul className="divide-y">
        {hosts.map((host) => {
          const s = HOST_STATES[hostState(host)];
          return (
            <li key={host} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate font-mono text-xs" title={host}>
                {host}
              </span>
              <span
                className={cn("flex shrink-0 items-center gap-1.5 text-[11px]", s.cls)}
                title={s.title}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
                {s.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Number of PEM blocks of `kind` in a pasted blob, for the editor's summary line. */
function countPemBlocks(pem: string, kind: RegExp): number {
  return (pem.match(kind) ?? []).length;
}

function ConfigEditor({
  id,
  initial,
  serviceStatus,
  traffic,
  certificate,
  online,
  canEdit,
}: {
  id: string;
  initial: RatholeConfig;
  serviceStatus?: Record<string, boolean>;
  traffic?: Record<string, TrafficStat>;
  certificate?: CertificateStatus;
  online: boolean;
  canEdit: boolean;
}) {
  const [config, setConfig] = useState<RatholeConfig>(() => normalizeConfig(structuredClone(initial)));
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
    if (!dirty) setConfig(normalizeConfig(structuredClone(initial)));
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

  function updateServiceType(i: number, type: ServiceType) {
    setConfig((c) => {
      const services = c.services.slice();
      const previous = services[i];
      services[i] = {
        ...previous,
        type,
        ...(type === "udp"
          ? { httpHost: undefined, httpHosts: undefined, customCertificate: undefined }
          : {}),
      };
      return normalizeConfig({ ...c, services });
    });
  }

  function updateHttp(p: Partial<HttpProxyConfig>) {
    setConfig((c) => {
      const { bindAddr: _bindAddr, httpsBindAddr: _httpsBindAddr, ...rest } = p;
      const enabled = rest.enabled ?? c.http?.enabled ?? false;
      return {
        ...c,
        http: {
          enabled,
          letsEncrypt: c.http?.letsEncrypt ?? { enabled: false, email: "", staging: false },
          ...rest,
          bindAddr: HTTP_PROXY_BIND_ADDR,
          httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
        },
      };
    });
  }

  function updateLetsEncrypt(
    p: Partial<NonNullable<HttpProxyConfig["letsEncrypt"]>>,
  ) {
    setConfig((c) => {
      const current = c.http?.letsEncrypt ?? { enabled: false, email: "", staging: false };
      const next = { ...current, ...p };
      return {
        ...c,
        http: {
          enabled: next.enabled ? true : (c.http?.enabled ?? false),
          bindAddr: HTTP_PROXY_BIND_ADDR,
          httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
          letsEncrypt: next,
        },
      };
    });
  }

  function updateServiceCustomCertificate(
    i: number,
    p: Partial<NonNullable<RatholeService["customCertificate"]>>,
  ) {
    setConfig((c) => {
      const services = c.services.slice();
      const service = services[i];
      const current = service.customCertificate ?? {
        enabled: false,
        certificatePem: "",
        privateKeyPem: "",
      };
      const next = { ...current, ...p };
      services[i] = { ...service, customCertificate: next };
      return {
        ...c,
        http: {
          enabled: next.enabled ? true : (c.http?.enabled ?? false),
          bindAddr: HTTP_PROXY_BIND_ADDR,
          httpsBindAddr: HTTPS_PROXY_BIND_ADDR,
          letsEncrypt: c.http?.letsEncrypt ?? { enabled: false, email: "", staging: false },
        },
        services,
      };
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
      await api.updateInstance(id, { config: normalizeConfig(config) });
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

  const services = config.services.map((service, index) => ({ service, index }));
  const tcpBackends = config.services
    .map((service, index) => ({ service, index }))
    .filter(({ service }) => service.type === "tcp");
  const httpEnabled = !!config.http?.enabled;
  const letsEncryptEnabled = !!config.http?.letsEncrypt?.enabled;
  const routedBackends = tcpBackends.filter(({ service }) => serviceHttpHosts(service).length > 0);
  const customBackends = routedBackends.filter(
    ({ service }) => certificateSource(service) === "custom",
  );
  // The agent provisions one certificate for exactly this set: every routed host
  // not served by an operator-provided certificate (see http_proxy_config in
  // agent/src/runner.rs).
  const letsEncryptHosts = useMemo(
    () =>
      config.services
        .filter((svc) => svc.type === "tcp" && certificateSource(svc) === "letsencrypt")
        .flatMap((svc) => serviceHttpHosts(svc)),
    [config.services],
  );

  const validationPanel =
    issues.length > 0 ? (
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
    ) : null;

  const saveBar = canEdit ? (
    <div className="sticky bottom-4 flex items-center justify-end gap-3">
      {dirty && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
      <Button onClick={save} disabled={!dirty || saving || issues.length > 0}>
        <Save className="h-4 w-4" />
        {saving ? "Saving…" : "Save & push"}
      </Button>
    </div>
  ) : null;

  function serviceTable(
    entries: Array<{ service: RatholeService; index: number }>,
    httpPanel: boolean,
  ) {
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {httpPanel ? "TCP backends" : "TCP/UDP services"} ({entries.length})
          </CardTitle>
          {canEdit && !httpPanel && (
            <Button
              variant="outline"
              size="sm"
              onClick={addService}
            >
              <Plus className="h-4 w-4" /> Add service
            </Button>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {entries.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              {httpPanel
                ? "No TCP services. Add one in the Services tab before assigning HTTP hosts."
                : "No TCP/UDP services. Add one to forward a port from behind NAT."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 text-center">Online</TableHead>
                  <TableHead className="min-w-32">Name</TableHead>
                  <TableHead className={httpPanel ? "min-w-40" : "w-24"}>
                    {httpPanel ? "TCP bind" : "Type"}
                  </TableHead>
                  {httpPanel ? (
                    <TableHead className="min-w-52">HTTP hosts</TableHead>
                  ) : (
                    <TableHead className="min-w-40">Public bind (server)</TableHead>
                  )}
                  {httpPanel && <TableHead className="min-w-44">Certificate</TableHead>}
                  {!httpPanel && (
                    <>
                      <TableHead className="min-w-36">Token</TableHead>
                      <TableHead className="w-20 text-center">nodelay</TableHead>
                    </>
                  )}
                  <TableHead className="w-28 text-right">Traffic</TableHead>
                  {canEdit && !httpPanel && <TableHead className="w-12" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(({ service: svc, index: i }) => {
                  const publicBindIssue = issueByPath.get(`services[${i}].bindAddr`);
                  const httpHostIssue =
                    issueByPath.get(`services[${i}].httpHosts`) ??
                    issueByPath.get(`services[${i}].httpHost`);
                  const certificateEnabledIssue = issueByPath.get(
                    `services[${i}].customCertificate.enabled`,
                  );
                  const customPemIssue =
                    issueByPath.has(`services[${i}].customCertificate.certificatePem`) ||
                    issueByPath.has(`services[${i}].customCertificate.privateKeyPem`);
                  const routed = serviceHttpHosts(svc).length > 0;
                  return (
                    <TableRow key={i} className="align-top">
                      <TableCell className="text-center">
                        <ServiceStatusDot state={serviceState(svc.name)} />
                      </TableCell>
                      <TableCell>
                        <Input
                          className="h-8 font-mono"
                          value={svc.name}
                          disabled={!canEdit || httpPanel}
                          onChange={(e) => updateService(i, { name: e.target.value })}
                        />
                      </TableCell>
                      <TableCell>
                        {httpPanel ? (
                          <span className="font-mono text-sm">{svc.bindAddr}</span>
                        ) : (
                          <Select
                            value={svc.type}
                            disabled={!canEdit}
                            onValueChange={(v) => updateServiceType(i, v as ServiceType)}
                          >
                            <SelectTrigger className="h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {BASIC_SERVICE_TYPES.map((type) => (
                                <SelectItem key={type} value={type}>
                                  {type}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell>
                        {httpPanel ? (
                          <>
                            <Input
                              aria-invalid={!!httpHostIssue}
                              className={cn("h-8 font-mono", httpHostIssue && "border-destructive")}
                              placeholder="app.example.com, www.example.com"
                              value={serviceHttpHosts(svc).join(", ")}
                              disabled={!canEdit}
                              onChange={(e) =>
                                updateService(i, {
                                  httpHost: undefined,
                                  httpHosts: parseHttpHostsInput(e.target.value),
                                })
                              }
                            />
                            {httpHostIssue && (
                              <p className="mt-1 text-xs text-destructive">{httpHostIssue}</p>
                            )}
                          </>
                        ) : (
                          <>
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
                          </>
                        )}
                      </TableCell>
                      {httpPanel && (
                        <TableCell>
                          {routed ? (
                            <>
                              <Select
                                value={certificateSource(svc)}
                                disabled={!canEdit}
                                onValueChange={(v) =>
                                  updateServiceCustomCertificate(i, {
                                    enabled: (v as CertificateSource) === "custom",
                                  })
                                }
                              >
                                <SelectTrigger
                                  className={cn(
                                    "h-8",
                                    (certificateEnabledIssue || customPemIssue) &&
                                      "border-destructive",
                                  )}
                                  aria-label={`${svc.name} certificate source`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="letsencrypt">Let's Encrypt</SelectItem>
                                  <SelectItem value="custom">Custom certificate</SelectItem>
                                </SelectContent>
                              </Select>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {certificateSource(svc) === "custom"
                                  ? customPemIssue
                                    ? "PEM missing — paste it under TLS certificates."
                                    : "Uses the PEM pasted under TLS certificates."
                                  : letsEncryptEnabled
                                    ? "Covered by the automatic certificate."
                                    : "Plain HTTP until automatic certificates are on."}
                              </p>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Assign a host first.
                            </span>
                          )}
                        </TableCell>
                      )}
                      {!httpPanel && (
                        <>
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
                        </>
                      )}
                      <TableCell className="pt-3 text-right font-mono text-xs whitespace-nowrap">
                        <span className="text-success" title="Downloaded by visitors">
                          ↓ {formatBytes(traffic?.[svc.name]?.bytesOut)}
                        </span>
                        <br />
                        <span className="text-muted-foreground" title="Uploaded by visitors">
                          ↑ {formatBytes(traffic?.[svc.name]?.bytesIn)}
                        </span>
                      </TableCell>
                      {canEdit && !httpPanel && (
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
    );
  }

  return (
    <>
      <TabsContent value="config">
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
            <Label>Domain</Label>
            <Input
              className="font-mono"
              placeholder="node.example.com"
              value={config.domain ?? ""}
              disabled={!canEdit}
              onChange={(e) => patch({ domain: e.target.value })}
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

          {validationPanel}
          {saveBar}
        </div>
      </TabsContent>

      <TabsContent value="http">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">HTTP reverse proxy</CardTitle>
              </div>
              <CardDescription>
                Runs the agent's embedded Pingora proxy on{" "}
                <code className="font-mono">{HTTP_PROXY_BIND_ADDR}</code> and routes each request
                by its Host header to the TCP backend that owns that host. Backends are the TCP
                services from the Services tab; assign their hostnames below.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
                <div>
                  <Label>Enable the proxy</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {routedBackends.length > 0
                      ? `${routedBackends.length} ${
                          routedBackends.length === 1 ? "backend has" : "backends have"
                        } hosts assigned. Turning this off keeps them configured but stops routing.`
                      : "Hosts stay configured while the proxy is off; nothing is routed until it is on."}
                  </p>
                  {issueByPath.has("http.enabled") && (
                    <p className="mt-1 text-xs text-destructive">
                      {issueByPath.get("http.enabled")}
                    </p>
                  )}
                </div>
                <Switch
                  checked={httpEnabled}
                  disabled={!canEdit}
                  onCheckedChange={(enabled) => updateHttp({ enabled })}
                />
              </div>
            </CardContent>
          </Card>

          {serviceTable(tcpBackends, true)}

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <LockKeyhole className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">TLS certificates</CardTitle>
              </div>
              <CardDescription>
                HTTPS is served on <code className="font-mono">{HTTPS_PROXY_BIND_ADDR}</code> and
                the certificate is picked per host by SNI. Each backend chooses its source in the
                table above: one automatic Let's Encrypt certificate covering every host that
                needs one, or a PEM pair you paste here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <section className="space-y-4">
                <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
                  <div>
                    <Label>Automatic certificates (Let's Encrypt)</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Issues and renews one certificate for the {letsEncryptHosts.length}{" "}
                      {letsEncryptHosts.length === 1 ? "host" : "hosts"} on “Let's Encrypt”
                      backends. Turning this on also enables the proxy, which answers the HTTP-01
                      challenge on port 80.
                    </p>
                  </div>
                  <Switch
                    checked={letsEncryptEnabled}
                    disabled={!canEdit}
                    onCheckedChange={(enabled) => updateLetsEncrypt({ enabled })}
                  />
                </div>

                {letsEncryptEnabled && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>
                          ACME account email <span className="text-destructive">*</span>
                        </Label>
                        <Input
                          aria-invalid={issueByPath.has("http.letsEncrypt.email")}
                          className={cn(
                            "font-mono",
                            issueByPath.has("http.letsEncrypt.email") && "border-destructive",
                          )}
                          placeholder="admin@example.com"
                          value={config.http?.letsEncrypt?.email ?? ""}
                          disabled={!canEdit}
                          onChange={(e) => updateLetsEncrypt({ email: e.target.value })}
                        />
                        {issueByPath.has("http.letsEncrypt.email") ? (
                          <p className="text-xs text-destructive">
                            {issueByPath.get("http.letsEncrypt.email")}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Let's Encrypt sends expiry warnings here.
                          </p>
                        )}
                      </div>
                      <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2">
                        <div>
                          <Label>Use the staging directory</Label>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Issues untrusted test certificates that browsers reject, but does not
                            consume production rate limits. Switching environments uses a separate
                            ACME account and certificate store.
                          </p>
                        </div>
                        <Switch
                          checked={!!config.http?.letsEncrypt?.staging}
                          disabled={!canEdit}
                          onCheckedChange={(staging) => updateLetsEncrypt({ staging })}
                        />
                      </div>
                    </div>

                    <p className="text-xs text-muted-foreground">
                      HTTP-01 validation requires every host below to resolve to this node and
                      port 80 to be reachable from the internet.
                    </p>

                    <CertificatePanel
                      hosts={letsEncryptHosts}
                      certificate={certificate}
                      online={online}
                      staging={!!config.http?.letsEncrypt?.staging}
                    />
                  </>
                )}
              </section>

              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <FileKey className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-medium">Custom certificates</h3>
                  <span className="text-xs text-muted-foreground">
                    {customBackends.length === 0
                      ? "none"
                      : `${customBackends.length} ${
                          customBackends.length === 1 ? "backend" : "backends"
                        }`}
                  </span>
                </div>
                {customBackends.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
                    No backend uses its own certificate. Switch a backend's certificate to
                    “Custom certificate” in the table above to paste a PEM pair for its hosts.
                  </div>
                ) : (
                  customBackends.map(({ service: svc, index: i }) => {
                    const pem = svc.customCertificate ?? {
                      enabled: true,
                      certificatePem: "",
                      privateKeyPem: "",
                    };
                    const certificatePemIssue = issueByPath.get(
                      `services[${i}].customCertificate.certificatePem`,
                    );
                    const privateKeyPemIssue = issueByPath.get(
                      `services[${i}].customCertificate.privateKeyPem`,
                    );
                    const chainCount = countPemBlocks(
                      pem.certificatePem,
                      /-----BEGIN CERTIFICATE-----/g,
                    );
                    const hasKey =
                      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(pem.privateKeyPem);
                    const complete = chainCount > 0 && hasKey;
                    return (
                      <div key={i} className="overflow-hidden rounded-lg border">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="font-mono text-sm font-medium">{svc.name}</span>
                            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                              {serviceHttpHosts(svc).join(", ")}
                            </span>
                          </div>
                          <span
                            className={cn(
                              "flex shrink-0 items-center gap-1.5 text-[11px]",
                              complete ? "text-success" : "text-muted-foreground",
                            )}
                          >
                            <span
                              className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                complete ? "bg-success" : "bg-muted-foreground/50",
                              )}
                            />
                            {complete
                              ? `${chainCount} certificate${chainCount === 1 ? "" : "s"} in chain · key present`
                              : "Incomplete — paste both parts"}
                          </span>
                        </div>
                        <div className="grid gap-4 p-3 lg:grid-cols-2">
                          <div className="space-y-2">
                            <Label>Certificate chain (PEM)</Label>
                            <Textarea
                              aria-label={`${svc.name} certificate chain`}
                              aria-invalid={!!certificatePemIssue}
                              className={cn(
                                "min-h-36 font-mono text-xs",
                                certificatePemIssue && "border-destructive",
                              )}
                              placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                              value={pem.certificatePem}
                              disabled={!canEdit}
                              onChange={(e) =>
                                updateServiceCustomCertificate(i, {
                                  certificatePem: e.target.value,
                                })
                              }
                            />
                            {certificatePemIssue ? (
                              <p className="text-xs text-destructive">{certificatePemIssue}</p>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                Leaf certificate first, then any intermediates.
                              </p>
                            )}
                          </div>
                          <div className="space-y-2">
                            <Label>Private key (PEM)</Label>
                            <Textarea
                              aria-label={`${svc.name} private key`}
                              aria-invalid={!!privateKeyPemIssue}
                              className={cn(
                                "min-h-36 font-mono text-xs",
                                privateKeyPemIssue && "border-destructive",
                              )}
                              placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
                              value={pem.privateKeyPem}
                              disabled={!canEdit}
                              onChange={(e) =>
                                updateServiceCustomCertificate(i, {
                                  privateKeyPem: e.target.value,
                                })
                              }
                            />
                            {privateKeyPemIssue ? (
                              <p className="text-xs text-destructive">{privateKeyPemIssue}</p>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                Stored on the node with owner-only permissions; the agent verifies
                                it matches the certificate before serving.
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </section>
            </CardContent>
          </Card>

          {validationPanel}
          {saveBar}
        </div>
      </TabsContent>

      <TabsContent value="services">
        <div className="space-y-6">
          {serviceTable(services, false)}
          {validationPanel}
          {saveBar}
        </div>
      </TabsContent>
    </>
  );
}

function ClientConfig({ config, publicIp }: { config: RatholeConfig; publicIp?: string }) {
  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Assemble a <code className="font-mono">client.toml</code> and run it with{" "}
        <code className="font-mono">rathole client.toml</code> on the machine behind NAT. Combine the
        global section with the blocks for the services you want to expose, and adjust each{" "}
        <code className="font-mono">local_addr</code> to your local service.
        {!config.domain?.trim() && publicIp && (
          <>
            {" "}
            No domain is set, so <code className="font-mono">remote_addr</code> uses the node's public
            IP (<code className="font-mono">{publicIp}</code>).
          </>
        )}
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Global client config</CardTitle>
        </CardHeader>
        <CardContent>
          <CodeBlock code={generateClientGlobalToml(config, publicIp)} filename="client.toml" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Service blocks ({config.services.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {config.services.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No services yet. Add services in the Services tab first.
            </p>
          ) : (
            config.services.map((svc, i) => (
              <div key={i} className="space-y-1.5">
                <p className="font-mono text-xs text-muted-foreground">{svc.name}</p>
                <CodeBlock code={generateClientServiceToml(svc)} language="toml" />
              </div>
            ))
          )}
        </CardContent>
      </Card>
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
            crate, embeds a Pingora HTTP/HTTPS proxy, and runs both <span className="font-medium">in-process</span>.
            Nodes enroll themselves via <code className="font-mono">rathole-agent login</code>; this
            instance was created by that flow. Source is in <code className="font-mono">/agent</code>.
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

function EditNodeDialog({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setValue(name);
  }, [open, name]);

  async function save() {
    setBusy(true);
    try {
      await api.updateInstance(id, { name: value });
      toast.success("Node renamed");
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground"
        title="Rename node"
        onClick={() => setOpen(true)}
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename node</DialogTitle>
          <DialogDescription>Set a display name for this node.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="node-name">Node name</Label>
          <Input
            id="node-name"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="edge-tokyo-01"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !value.trim() || value === name}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
