import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { Login } from "@/pages/Login";
import { Dashboard } from "@/pages/Dashboard";
import { InstanceDetail } from "@/pages/InstanceDetail";
import { Settings } from "@/pages/Settings";
import { Waypoints, LogOut, Server, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Auth = "checking" | "in" | "out";

export default function App() {
  const [auth, setAuth] = useState<Auth>("checking");

  useEffect(() => {
    localStorage.removeItem("rathole-admin-token");
    api.checkSession()
      .then((ok) => setAuth(ok ? "in" : "out"))
      .catch(() => setAuth("out"));
  }, []);

  if (auth === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (auth === "out") {
    return <Login onAuthed={() => setAuth("in")} />;
  }

  return (
    <AppShell onLogout={() => setAuth("out")}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/instances/:id" element={<InstanceDetail />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

const NAV_ITEMS = [
  {
    to: "/",
    label: "Instances",
    icon: Server,
    matches: (path: string) => path === "/" || path.startsWith("/instances/"),
  },
  {
    to: "/settings",
    label: "Global settings",
    icon: Settings2,
    matches: (path: string) => path === "/settings",
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
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                item.matches(location.pathname)
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
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
            <SignOutButton onLogout={onLogout} />
          </div>
          <nav className="flex gap-1 overflow-x-auto border-t px-3 py-2">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm",
                  item.matches(location.pathname)
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground",
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))}
          </nav>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function SignOutButton({
  onLogout,
  className,
}: {
  onLogout: () => void;
  className?: string;
}) {
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
