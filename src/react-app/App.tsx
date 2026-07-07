import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, type SessionState } from "@/lib/api";
import { AuthContext, useAuth } from "@/lib/auth";
import { Login } from "@/pages/Login";
import { Dashboard } from "@/pages/Dashboard";
import { InstanceDetail } from "@/pages/InstanceDetail";
import { Settings } from "@/pages/Settings";
import { Users } from "@/pages/Users";
import { Waypoints, LogOut, Server, Settings2, Users as UsersIcon, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Phase = "checking" | "in" | "out";

export default function App() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [session, setSession] = useState<SessionState>({ authenticated: false });

  async function refreshSession() {
    const s = await api.session().catch(() => ({ authenticated: false }) as SessionState);
    setSession(s);
    setPhase(s.authenticated ? "in" : "out");
  }

  useEffect(() => {
    localStorage.removeItem("rathole-admin-token");
    void refreshSession();
  }, []);

  if (phase === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (phase === "out") {
    return <Login onAuthed={refreshSession} />;
  }

  const isAdmin = session.role === "admin";

  return (
    <AuthContext.Provider value={{ username: session.username, role: session.role, isAdmin }}>
      <AppShell onLogout={() => setPhase("out")}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/instances/:id" element={<InstanceDetail />} />
          <Route
            path="/settings"
            element={isAdmin ? <Settings /> : <Navigate to="/" replace />}
          />
          <Route
            path="/users"
            element={isAdmin ? <Users currentUsername={session.username} /> : <Navigate to="/" replace />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </AuthContext.Provider>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: typeof Server;
  matches: (path: string) => boolean;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    to: "/",
    label: "Instances",
    icon: Server,
    matches: (path) => path === "/" || path.startsWith("/instances/"),
  },
  {
    to: "/settings",
    label: "Global settings",
    icon: Settings2,
    matches: (path) => path === "/settings",
    adminOnly: true,
  },
  {
    to: "/users",
    label: "Users",
    icon: UsersIcon,
    matches: (path) => path === "/users",
    adminOnly: true,
  },
];

function AppShell({
  children,
  onLogout,
}: {
  children: React.ReactNode;
  onLogout: () => void;
}) {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-muted/20 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r bg-card lg:flex">
        <Link to="/" className="flex h-16 items-center gap-2.5 border-b px-5 font-semibold">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Waypoints className="h-4 w-4" />
          </span>
          rathole-manage
        </Link>
        <nav className="flex-1 space-y-1 p-3">
          <NavLinks pathname={location.pathname} />
        </nav>
        <div className="border-t p-3">
          <SignOutButton onLogout={onLogout} className="w-full justify-start" />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="border-b bg-card lg:hidden">
          <div className="flex h-14 items-center justify-between px-4">
            <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Waypoints className="h-4 w-4" />
              </span>
              rathole-manage
            </Link>
            <div className="flex items-center gap-1">
              <ChangePasswordDialog />
              <SignOutButton onLogout={onLogout} />
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto border-t px-3 py-2">
            <NavLinks pathname={location.pathname} compact />
          </nav>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

function NavLinks({ pathname, compact }: { pathname: string; compact?: boolean }) {
  const { isAdmin } = useAuth();
  return (
    <>
      {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={cn(
            compact
              ? "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm"
              : "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            item.matches(pathname)
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <item.icon className="h-4 w-4" />
          {item.label}
        </Link>
      ))}
    </>
  );
}

function ChangePasswordDialog() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.changePassword(current, next);
      toast.success("Password changed");
      setOpen(false);
      setCurrent("");
      setNext("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" title="Change password">
          <KeyRound className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Update the password for your account.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cur">Current password</Label>
            <Input
              id="cur"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new">New password</Label>
            <Input
              id="new"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="at least 8 characters"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !current || next.length < 8}>
            {busy ? "Saving…" : "Change password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SignOutButton({ onLogout, className }: { onLogout: () => void; className?: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      onClick={async () => {
        try {
          await api.logout();
        } finally {
          onLogout();
        }
      }}
    >
      <LogOut className="h-4 w-4" />
      Sign out
    </Button>
  );
}
