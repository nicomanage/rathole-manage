import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Login } from "@/pages/Login";
import { Dashboard } from "@/pages/Dashboard";
import { InstanceDetail } from "@/pages/InstanceDetail";
import { Waypoints, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

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
    <div className="min-h-screen">
      <TopBar onLogout={() => setAuth("out")} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/instances/:id" element={<InstanceDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function TopBar({ onLogout }: { onLogout: () => void }) {
  const nav = useNavigate();
  return (
    <header className="border-b bg-card/50 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <button
          className="flex items-center gap-2 text-sm font-semibold cursor-pointer"
          onClick={() => nav("/")}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Waypoints className="h-4 w-4" />
          </span>
          rathole-manage
        </button>
        <Button
          variant="ghost"
          size="sm"
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
      </div>
    </header>
  );
}
