import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useHubSocket } from "@/hooks/useHubSocket";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { StatusDot, ProcessBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { AlertTriangle, ArrowRight, Plus, RefreshCw, Server, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import type { GlobalSettings, TransportType } from "@shared/types";

const FALLBACK_SETTINGS: GlobalSettings = {
  defaultBindAddr: "0.0.0.0:2333",
  defaultTransport: "tcp",
};

export function Dashboard() {
  const { instances, conn, loading, loadError, refresh } = useHubSocket();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Instances</h1>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {conn === "open" ? (
              <>
                <Wifi className="h-3.5 w-3.5 text-success" /> Live
              </>
            ) : (
              <>
                <WifiOff className="h-3.5 w-3.5" /> Reconnecting…
              </>
            )}
            <span>· {loading ? "Loading instances…" : `${instances.length} managed`}</span>
          </p>
        </div>
        <CreateInstanceDialog />
      </div>

      {loading ? (
        <InstancesLoading />
      ) : loadError ? (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </span>
            <div>
              <p className="font-medium">Failed to load instances</p>
              <p className="text-sm text-muted-foreground">{loadError}</p>
            </div>
            <Button variant="outline" onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : instances.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Server className="h-6 w-6 text-muted-foreground" />
            </span>
            <div>
              <p className="font-medium">No instances yet</p>
              <p className="text-sm text-muted-foreground">
                Create one, then run the Rust agent on your rathole server to connect it.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {instances.map((inst) => (
            <Link key={inst.id} to={`/instances/${inst.id}`}>
              <Card className="group h-full transition-colors hover:border-ring">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <StatusDot status={inst.status} />
                      {inst.name}
                    </CardTitle>
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Process</span>
                    <ProcessBadge state={inst.processState} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Services</span>
                    <Badge variant="secondary">{inst.config.services.length}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Bind</span>
                    <span className="font-mono text-xs">{inst.config.bindAddr}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Last seen</span>
                    <span className="text-xs">{relativeTime(inst.lastSeen)}</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function InstancesLoading() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className="h-full">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="h-5 w-32 animate-pulse rounded bg-muted" />
              <div className="h-4 w-4 animate-pulse rounded bg-muted" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 4 }).map((__, j) => (
              <div key={j} className="flex items-center justify-between">
                <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CreateInstanceDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [publicHost, setPublicHost] = useState("");
  const [bindAddr, setBindAddr] = useState("0.0.0.0:2333");
  const [transport, setTransport] = useState<TransportType>("tcp");
  const [defaults, setDefaults] = useState<GlobalSettings>(FALLBACK_SETTINGS);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadingDefaults(true);
    api.getSettings()
      .then(({ settings }) => {
        if (!active) return;
        setDefaults(settings);
        setPublicHost("");
        setBindAddr(settings.defaultBindAddr);
        setTransport(settings.defaultTransport);
      })
      .catch((error) => toast.error((error as Error).message))
      .finally(() => {
        if (active) setLoadingDefaults(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  async function create() {
    setBusy(true);
    try {
      await api.createInstance({
        name,
        publicHost: publicHost || undefined,
        config: {
          bindAddr,
          transport,
          heartbeatInterval: defaults.defaultHeartbeatInterval,
          services: [],
        },
      });
      toast.success(`Created "${name}"`);
      setOpen(false);
      setName("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          New instance
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New rathole instance</DialogTitle>
          <DialogDescription>
            A managed rathole server node. You'll connect an agent to it afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              autoFocus
              placeholder="edge-tokyo-01"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="host">Public host (optional)</Label>
            <Input
              id="host"
              placeholder="tunnel.example.com"
              value={publicHost}
              onChange={(e) => setPublicHost(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bind">Control channel bind address</Label>
            <Input
              id="bind"
              className="font-mono"
              value={bindAddr}
              onChange={(e) => setBindAddr(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Transport</Label>
            <Select
              value={transport}
              onValueChange={(value) => setTransport(value as TransportType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["tcp", "tls", "noise", "websocket"] as TransportType[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={busy || loadingDefaults || !name.trim()}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
