import { useEffect, useState } from "react";
import { Save, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { GlobalSettings, TransportType } from "@shared/types";

const FALLBACK_SETTINGS: GlobalSettings = {
  defaultBindAddr: "0.0.0.0:2333",
  defaultTransport: "tcp",
};

const TRANSPORTS: TransportType[] = ["tcp", "tls", "noise", "websocket"];

export function Settings() {
  const [settings, setSettings] = useState<GlobalSettings>(FALLBACK_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings()
      .then(({ settings: loaded }) => setSettings(loaded))
      .catch((error) => toast.error((error as Error).message))
      .finally(() => setLoading(false));
  }, []);

  function patch(update: Partial<GlobalSettings>) {
    setSettings((current) => ({ ...current, ...update }));
  }

  async function save() {
    setSaving(true);
    try {
      const { settings: saved } = await api.updateSettings(settings);
      setSettings(saved);
      toast.success("Global settings saved");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Global settings</h1>
        <p className="text-sm text-muted-foreground">
          Defaults applied when a new rathole instance is created.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Instance defaults</CardTitle>
          </div>
          <CardDescription>
            Existing instances are not changed. Their server configuration remains managed and
            distributed by the Worker. Each new instance gets an auto-generated default service
            token.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="default-bind">Control bind address</Label>
            <Input
              id="default-bind"
              className="font-mono"
              value={settings.defaultBindAddr}
              disabled={loading}
              onChange={(event) => patch({ defaultBindAddr: event.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>Transport</Label>
            <Select
              value={settings.defaultTransport}
              disabled={loading}
              onValueChange={(value) => patch({ defaultTransport: value as TransportType })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSPORTS.map((transport) => (
                  <SelectItem key={transport} value={transport}>
                    {transport}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="default-heartbeat">Heartbeat interval (seconds)</Label>
            <Input
              id="default-heartbeat"
              type="number"
              min={1}
              placeholder="30"
              value={settings.defaultHeartbeatInterval ?? ""}
              disabled={loading}
              onChange={(event) =>
                patch({
                  defaultHeartbeatInterval: event.target.value
                    ? Number(event.target.value)
                    : undefined,
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={loading || saving}>
          <Save className="h-4 w-4" />
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
