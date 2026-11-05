# Running the dashboard 24/7

The dashboard is one Node process (`src/server.js`). It holds no wallet sheet in the
image: you upload `wallets.xlsx` from the UI after deploying, and it is stored in
`data/` on a persistent volume.

Auto-run is **off** after every start. Nothing is claimed or started until you press
**Run now** (or **Start loop**).

## What the host must provide

| Requirement | Why |
|---|---|
| Node 22 (the included `Dockerfile` works as-is) | ESM + built-in `fetch` |
| A persistent disk mounted at `/app/data` | holds the uploaded `wallets.xlsx` and `settings.json` |
| `PORT` env var | set automatically by Render/Railway/Fly/Heroku |
| `DASHBOARD_PASSWORD` env var | without it, anyone with the URL can spend your energy |

`GET /healthz` answers `200 {"ok":true}` for platform health checks.

## Docker (any VPS)

```bash
docker build -t gem-miner .
docker run -d --name gem-miner \
  -p 8080:8080 \
  -v gem-miner-data:/app/data \
  -e DASHBOARD_PASSWORD='choose-a-long-random-one' \
  --restart unless-stopped \
  gem-miner
```

Then open `http://YOUR_SERVER:8080` (put HTTPS in front of it — Caddy, nginx, or a
platform that terminates TLS for you).

## Render / Railway / Fly.io

1. Push this folder to a Git repo (or `railway up` / `fly deploy` from the folder).
   The `Dockerfile` is detected automatically. `npm start` also works if the platform
   prefers a Node buildpack.
2. Add a **persistent disk / volume** mounted at `/app/data`. Without it the uploaded
   sheet is lost on every redeploy. On Render, `render.yaml` already declares the
   service, the disk and the health check — use **New → Blueprint** and pick this repo,
   then set `DASHBOARD_PASSWORD` when prompted.
3. Environment variables:
   - `DASHBOARD_PASSWORD` — required in practice
   - `DASHBOARD_USER` — defaults to `admin`
   - `HOST` / `PORT` — the Dockerfile already sets `0.0.0.0` and `8080`; platforms
     that inject their own `PORT` win.
4. Health check path: `/healthz`.

## First run after deploy

1. Open the URL and log in with `DASHBOARD_USER` / `DASHBOARD_PASSWORD`.
2. **Upload wallets.xlsx** — the sheet is validated before saving (missing
   `Wallet Address`/`Token` columns or zero valid rows are rejected, the old file is
   kept).
3. Everything is idle. Press **Run now** for a single cycle, or set *Loop every N
   minutes* and press **Start loop**.
4. The loop never overlaps itself: if a cycle takes longer than the interval, the next
   one starts only after the last wallet has been checked.

## Files and secrets

- `data/wallets.xlsx` — the uploaded sheet (contains bearer tokens: treat as secrets).
- `data/settings.json` — the loop interval you picked; the loop itself always starts off.
- `wallets.xlsx` files are excluded from the image by `.dockerignore`, so no sheet is
  ever baked into a deployment.
- Keep the dashboard behind HTTPS; bearer tokens travel in request bodies only when the
  server talks to the API, but the sheet upload contains them.

## Local use

```bash
npm install
npm run ui        # http://127.0.0.1:4173 (falls back to the next port if busy)
```

Local runs read `./wallets.xlsx` if it exists, otherwise `data/wallets.xlsx`.
