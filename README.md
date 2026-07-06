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
cp .dev.vars.example .dev.vars   # set username, password, and session secret
npm run dev                      # Vite + Worker via @cloudflare/vite-plugin
```

Open the printed URL and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## Deploy the panel

```bash
npm run cf-typegen               # generate worker types (first time / after config changes)
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run deploy
```

The Durable Object migration in `wrangler.jsonc` is applied automatically on
first deploy.

## Connect a rathole node (Rust agent)

1. In the panel, create an instance and open its **Agent setup** tab. Reveal the
   agent token.
2. On the server:

   ```bash
   cd agent
   cargo build --release
   sudo install -m0755 target/release/rathole-agent /usr/local/bin/

   sudo mkdir -p /etc/rathole-manage /var/lib/rathole-manage
   sudo cp agent.env.example /etc/rathole-manage/agent.env
   sudo $EDITOR /etc/rathole-manage/agent.env      # HUB_URL / INSTANCE_ID / AGENT_TOKEN

   sudo cp rathole-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now rathole-agent
   ```

The instance turns **online** in the panel, the config you built is pushed down,
and rathole starts serving. Editing config in the panel re-pushes it and rathole
hot-reloads.

## Config model → rathole TOML

Each instance has a control channel (`bind_addr`, an auto-generated
`default_token`, transport: `tcp` / `tls` / `noise` / `websocket`) and a list of
services. A service maps a public `bind_addr` on the server to a `local_addr` on
the client behind NAT. `src/worker/server-config.ts` privately generates the
Worker-managed `server.toml`; `src/shared/config-generator.ts` generates the
operator-facing `client.toml`.

## Security notes

- The panel uses username/password login and an HMAC-signed, `HttpOnly`,
  `SameSite=Strict`, `Secure` session cookie. Credentials are never placed in a
  WebSocket URL or browser storage.
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
