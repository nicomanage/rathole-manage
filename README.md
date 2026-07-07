# rathole-manage

A management panel for [rathole](https://github.com/rapiz1/rathole) servers.
The control plane runs on **Cloudflare Workers** (Worker + Durable Object), the UI
is **React + shadcn/ui**, and each rathole node is driven by a small **Rust agent
that embeds rathole as a library** and talks to the panel over **WebSocket**.

From the panel you can:

- register and manage **multiple rathole instances** in real time
- set global defaults for newly created instances
- edit the control channel + per-service forwarding and generate `client.toml`
- let the Worker generate and push `server.toml`, which the agent applies automatically
- auto-generate a default service token for each new instance
- **start / stop / restart** the embedded rathole remotely
- watch **live logs** and basic metrics (CPU, memory, uptime) streamed from each node

## Architecture

```
                       ┌──────────────────────────────────────────┐
   Browser (shadcn) ───┤  Cloudflare Worker            ASSETS ─────┼─ static SPA
       REST + WS ▲     │    /api/ws          (live updates/logs)   │
               │       │    /api/agent/ws    (agent token)         │
               ▼       │    /api/instances   (REST)                │
        ┌──────────────┴──────────────┐                            │
        │  Durable Object: RatholeHub │  ← hibernatable WS,        │
        │  persists instances/configs │    SQLite storage          │
        └──────────────┬──────────────┘                            │
                       │  WebSocket (wss)                          │
                       ▼                                            │
              ┌──────────────────┐                                 │
              │  rathole-agent   │  (Rust, on each server)         │
              │  ├─ embeds rathole::run() in-process               │
              │  ├─ writes Worker-managed server.toml, hot-reload  │
              │  └─ streams logs + metrics back                    │
              └──────────────────┘
```

- **`src/worker/`** — Worker entry (`index.ts`), Worker-only server config
  generation (`server-config.ts`), and the `RatholeHub` Durable Object (`hub.ts`).
  The hub holds every agent + browser socket using hibernatable WebSockets,
  persists instances/global settings in DO storage, and fans updates out live.
- **`src/react-app/`** — the shadcn/ui dashboard.
- **`src/shared/`** — shared types, validation, and client config generation.
- **`agent/`** — the Rust agent. It depends on the `rathole` crate and calls
  `rathole::run()` directly, so there is **no separate rathole binary** to install.

The web panel uses REST for initial state, resynchronization, CRUD, settings, and
commands. Its WebSocket is reserved for live status/metric deltas and log streams.

## Prerequisites

- Node 20+ and a Cloudflare account (Workers + Durable Objects, available on the
  free plan) for the panel.
- Rust (stable) on each rathole server for the agent.

## Run the panel locally

```bash
npm install
cp .dev.vars.example .dev.vars   # set the session secret
npm run dev                      # Vite + Worker via @cloudflare/vite-plugin
```

Open the printed URL. When the user store is empty, the first username and
password you submit becomes the initial admin account.

## Deploy the panel

```bash
npm run cf-typegen               # generate worker types (first time / after config changes)
npx wrangler secret put SESSION_SECRET
npm run deploy
```

The Durable Object migration in `wrangler.jsonc` is applied automatically on
first deploy.

## Connect a rathole node (Rust agent)

Nodes **self-enroll** — you don't create instances in the panel.

### Install via APT (recommended)

The CI publishes signed-off `.deb` packages (amd64 + arm64) to the APT repo on
GitHub Pages:

```bash
echo "deb [trusted=yes] https://nicomanage.github.io/rathole-manage/apt ./" \
  | sudo tee /etc/apt/sources.list.d/rathole-agent.list
sudo apt-get update
sudo apt-get install rathole-agent

# enroll this node with your panel account, then start it:
sudo rathole-agent login
sudo systemctl enable --now rathole-agent
```

The install page is `https://nicomanage.github.io/rathole-manage/`. Publishing is
done by `.github/workflows/apt-pages.yml`; enable it once under **Settings →
Pages → Build and deployment → GitHub Actions**, then run the `apt-pages`
workflow once. The APT URL starts working after that workflow publishes
`apt/Packages`.

### Build from source

```bash
cd agent
cargo build --release
sudo install -m0755 target/release/rathole-agent /usr/local/bin/

# Interactive TUI: enter the panel URL + your admin username/password.
# This enrolls the node and writes /var/lib/rathole-manage/identity.json.
sudo IDENTITY_PATH=/var/lib/rathole-manage/identity.json rathole-agent login

# Run it as a service (reads the saved identity).
sudo cp rathole-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rathole-agent
```

The node appears in the panel automatically and turns **online**. From there,
edit its services; the Worker generates `server.toml` and pushes it, and the
embedded rathole hot-reloads. Re-running `login` on the same machine reclaims the
same instance (idempotent by machine-id), so it never creates duplicates.

For non-interactive fleets you can skip `login` and set `HUB_URL`, `INSTANCE_ID`
and `AGENT_TOKEN` in the environment instead (see `agent/agent.env.example`).

## Config model → rathole TOML

Each instance has a control channel (`bind_addr`, an auto-generated
`default_token`, transport: `tcp` / `tls` / `noise` / `websocket`) and a list of
services. A service maps a public `bind_addr` on the server to a `local_addr` on
the client behind NAT. `src/worker/server-config.ts` privately generates the
Worker-managed `server.toml`; `src/shared/config-generator.ts` generates the
operator-facing `client.toml`.

## Security notes

- The panel supports **multiple users** with `admin` / `viewer` roles, managed
  under **Users** (admin only). Passwords are stored as PBKDF2-SHA256 hashes. The
  first successful login initializes the first admin account when the user store
  is empty. Viewers get read-only access; only admins mutate instances, settings,
  and users.
- Login uses an HMAC-signed, `HttpOnly`, `SameSite=Strict`, `Secure` session
  cookie. Credentials are never placed in a WebSocket URL or browser storage.
- Each instance has its own random `agentToken`; agents authenticate with it and
  can only act on their own instance.
- Set all production credentials with `wrangler secret put`. Serve the panel
  over HTTPS so `wss`, credentials, and session cookies stay encrypted.

## Scripts

| command | what it does |
| --- | --- |
| `npm run dev` | local dev server (UI + Worker) |
| `npm run build` | typecheck + build the SPA and Worker |
| `npm run check` | typecheck UI and Worker |
| `npm run deploy` | build and `wrangler deploy` |
| `npm run cf-typegen` | regenerate `worker-configuration.d.ts` |
| `cargo build --release` (in `agent/`) | build the Rust agent |
