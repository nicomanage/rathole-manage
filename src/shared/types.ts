// Shared types between the Cloudflare Worker (control plane) and the React panel.
// Keep this file free of any runtime/platform imports so both sides can use it.

export type TransportType = "tcp" | "tls" | "noise" | "websocket";
export type ServiceType = "tcp" | "udp";

/** A single forwarded service inside a rathole server instance. */
export interface RatholeService {
  /** Service name, unique within an instance. Becomes the TOML table key. */
  name: string;
  type: ServiceType;
  /** Public address rathole listens on for this service, e.g. "0.0.0.0:5202". */
  bindAddr: string;
  /** Optional per-service token; falls back to the instance default token. */
  token?: string;
  nodelay?: boolean;
}

export interface TlsConfig {
  pkcsPath?: string;
  keystorePassword?: string;
  trustedRoot?: string;
  hostname?: string;
}

export interface NoiseConfig {
  pattern?: string;
  localPrivateKey?: string;
  remotePublicKey?: string;
}

export interface WebsocketConfig {
  tls?: boolean;
}

/** Full configuration for one rathole server instance. */
export interface RatholeConfig {
  /** Control channel bind address, e.g. "0.0.0.0:2333". */
  bindAddr: string;
  /**
   * Operator-facing domain for this server (e.g. "node.example.com"). Metadata
   * only — rathole forwards raw TCP/UDP; the domain documents where the server
   * is reached and is shown in the panel.
   */
  domain?: string;
  defaultToken?: string;
  transport: TransportType;
  tls?: TlsConfig;
  noise?: NoiseConfig;
  websocket?: WebsocketConfig;
  heartbeatInterval?: number;
  services: RatholeService[];
}

export interface GlobalSettings {
  defaultBindAddr: string;
  defaultTransport: TransportType;
  defaultHeartbeatInterval?: number;
}

// ---- users -----------------------------------------------------------------

/** admin = full control; viewer = read-only access to the panel. */
export type Role = "admin" | "viewer";

/** A panel user. Stored in the hub; password is kept only as a PBKDF2 hash. */
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
  role: Role;
  createdAt: number;
  updatedAt: number;
}

/** User shape safe to send to the browser (no password material). */
export type UserView = Omit<User, "passwordHash" | "passwordSalt" | "passwordIterations">;

export interface CreateUserInput {
  username: string;
  password: string;
  role: Role;
}

export interface UpdateUserInput {
  role?: Role;
  /** When set, resets the user's password (admin action). */
  password?: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/** Identity of the currently authenticated user. */
export interface Me {
  username: string;
  role: Role;
}

export type InstanceStatus = "online" | "offline" | "unknown";
/** Reported state of the rathole process managed by an agent. */
export type ProcessState = "running" | "stopped" | "errored" | "unknown";

export interface AgentMetrics {
  cpuPercent?: number;
  memoryMb?: number;
  uptimeSeconds?: number;
  ratholeVersion?: string;
  agentVersion?: string;
  hostname?: string;
  /** Whether the config on disk matches the config the panel expects. */
  configInSync?: boolean;
}

/** An instance = one managed rathole server node. */
export interface Instance {
  id: string;
  name: string;
  /** Secret the agent uses to authenticate its WebSocket to the hub. */
  agentToken: string;
  /**
   * Stable identifier of the node that self-enrolled this instance (e.g. the
   * machine-id). Lets a re-enrolling agent reclaim its instance idempotently.
   */
  enrollNodeId?: string;
  config: RatholeConfig;
  status: InstanceStatus;
  processState: ProcessState;
  lastSeen?: number;
  metrics?: AgentMetrics;
  /**
   * Per-service reachability reported by the agent: true when rathole is
   * listening on the service's public port (i.e. a client is connected).
   * Keyed by service name.
   */
  serviceStatus?: Record<string, boolean>;
  /**
   * Cumulative per-service traffic (since the agent process started), keyed by
   * service name. Used to compute deltas for monthly accounting.
   */
  traffic?: Record<string, TrafficStat>;
  /** Persisted per-month totals for this instance, keyed by UTC month "YYYY-MM". */
  monthlyTraffic?: Record<string, TrafficStat>;
  createdAt: number;
  updatedAt: number;
}

/** Cumulative bytes for one service. in = uploaded by visitors, out = downloaded. */
export interface TrafficStat {
  bytesIn: number;
  bytesOut: number;
}

/** Instance shape sent to the browser (agentToken redacted unless requested). */
export type InstanceView = Omit<Instance, "agentToken"> & {
  agentTokenPreview?: string;
};

// ---- WebSocket protocol ----------------------------------------------------

/** Messages an agent (running on a rathole box) sends to the hub. */
export type AgentToHub =
  | { type: "register"; instanceId: string; token: string; agentVersion?: string; hostname?: string }
  | {
      type: "status";
      processState: ProcessState;
      metrics?: AgentMetrics;
      /** Per-service reachability, keyed by service name. */
      serviceStatus?: Record<string, boolean>;
      /** Cumulative per-service traffic, keyed by service name. */
      traffic?: Record<string, TrafficStat>;
    }
  | { type: "log"; line: string; stream?: "stdout" | "stderr"; ts?: number }
  | { type: "config_ack"; ok: boolean; error?: string }
  | { type: "command_result"; command: AgentCommand; ok: boolean; error?: string }
  | { type: "pong" };

export type AgentCommand = "start" | "stop" | "restart" | "reload" | "status";

/** A service the agent should probe for reachability. */
export interface ServiceRef {
  name: string;
  bindAddr: string;
}

/** Messages the hub sends down to an agent. */
export type HubToAgent =
  | { type: "registered"; instanceId: string; name: string }
  | { type: "apply_config"; config: RatholeConfig; configHash: string; services?: ServiceRef[] }
  | { type: "command"; command: AgentCommand }
  | { type: "ping" }
  | { type: "error"; message: string };

/** Messages a browser dashboard client sends to the hub. */
export type BrowserToHub =
  | { type: "subscribe_logs"; instanceId: string }
  | { type: "unsubscribe_logs"; instanceId: string };

/** Messages the hub pushes to browser dashboard clients. */
export type HubToBrowser =
  | { type: "instance_update"; instance: InstanceView }
  | { type: "instance_removed"; instanceId: string }
  | { type: "log"; instanceId: string; line: string; stream?: "stdout" | "stderr"; ts: number }
  | { type: "error"; message: string };

// ---- REST payloads ---------------------------------------------------------

export interface CreateInstanceInput {
  name: string;
  config?: Partial<RatholeConfig>;
}

export interface UpdateInstanceInput {
  name?: string;
  config?: RatholeConfig;
}

/** Body an agent POSTs to /api/agent/enroll to self-register a node. */
export interface EnrollInput {
  /** Stable node identity (machine-id / persisted uuid) for idempotency. */
  nodeId: string;
  /** Desired instance name; defaults to the node hostname. */
  name?: string;
}

/** Credentials the hub returns to a freshly enrolled (or re-enrolled) agent. */
export interface EnrollResult {
  instanceId: string;
  agentToken: string;
  name: string;
  /** True when this enrollment created a new instance rather than reclaiming one. */
  created: boolean;
}
