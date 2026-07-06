import { useState } from "react";
import { api, setToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Waypoints } from "lucide-react";
import { toast } from "sonner";

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [token, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const ok = await api.checkSession(token.trim());
      if (!ok) {
        toast.error("Invalid admin token");
        return;
      }
      setToken(token.trim());
      onAuthed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <span className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Waypoints className="h-6 w-6" />
          </span>
          <CardTitle className="text-xl">rathole-manage</CardTitle>
          <CardDescription>Enter your admin token to manage rathole instances.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="token">Admin token</Label>
              <Input
                id="token"
                type="password"
                autoFocus
                placeholder="••••••••••••"
                value={token}
                onChange={(e) => setTokenInput(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy || !token.trim()}>
              {busy ? "Checking…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
