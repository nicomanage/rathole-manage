import { Badge } from "@/components/ui/badge";
import type { InstanceStatus, ProcessState } from "@shared/types";
import { cn } from "@/lib/utils";

export function StatusDot({ status }: { status: InstanceStatus }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      {status === "online" && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
      )}
      <span
        className={cn(
          "relative inline-flex h-2.5 w-2.5 rounded-full",
          status === "online" ? "bg-success" : "bg-muted-foreground/50",
        )}
      />
    </span>
  );
}

export function ProcessBadge({ state }: { state: ProcessState }) {
  const map: Record<ProcessState, { label: string; variant: "success" | "muted" | "destructive" | "secondary" }> = {
    running: { label: "running", variant: "success" },
    stopped: { label: "stopped", variant: "muted" },
    errored: { label: "errored", variant: "destructive" },
    unknown: { label: "unknown", variant: "secondary" },
  };
  const { label, variant } = map[state];
  return <Badge variant={variant}>{label}</Badge>;
}
