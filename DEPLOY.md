# Running the dashboard 24/7

The dashboard is one Node process (`src/server.js`). It holds no wallet sheet in the
image: you upload `wallets.xlsx` from the UI after deploying, and it is stored in
`data/` on a persistent volume.

Auto-run is **off** after every start. Nothing is claimed or started until you press
**Run 1 loop** (or **Start loop**).

## What the host must provide

| Requirement | Why |
|---|---|
| Node 22 (the included `Dockerfile` works as-is) | ESM + built-in `fetch` |
| A persistent disk mounted at `/app/data` | holds the uploaded `wallets.xlsx` and `settings.json` |
| `PORT` env var | set automatically by Render/Railway/Fly/Heroku |
| `DASHBOARD_PASSWORD` env var | without it, anyone with the URL can spend your energy |

`GET /healthz` answers `200 {"ok":true}` for platform health checks.

**Oracle Cloud Always Free VM (systemd + Caddy, HTTPS, no Docker needed):** see
[`deploy/oracle/README.md`](deploy/oracle/README.md) — one VM handles the UI fine,
and a free `sslip.io` hostname gets a real certificate even without a domain.

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
   sheet is lost on every redeploy (the Render free plan has no disk — see the free
   plan notes below). On Render, `render.yaml` declares the service and the health
   check — use **New → Blueprint** and pick this repo, then set
   `DASHBOARD_PASSWORD` when prompted.
3. Environment variables:
   - `DASHBOARD_PASSWORD` — required in practice
   - `DASHBOARD_USER` — defaults to `admin`
   - `WALLETS_SHEET_URL` — the Google Sheet link (see below); without it you upload
     `wallets.xlsx` from the UI instead
   - `AUTO_START_LOOP=true` — start the loop on boot, so a deploy or crash resumes
     cycling with no browser open (leave it unset to keep the dashboard idle)
   - `LOOP_INTERVAL_MINUTES` — the interval at boot (1–1440). Without it the interval
     comes from `data/settings.json`, which a host without a disk loses on restart
   - `HOST` / `PORT` — the Dockerfile already sets `0.0.0.0` and `8080`; platforms
     that inject their own `PORT` win.
4. Health check path: `/healthz`.

### Render free plan (what you get, what breaks)

The free instance is fine for one always-on service if you keep it warm, but it has
no disk:

- **Spin-down:** after 15 minutes with no inbound traffic Render stops the process.
  A free UptimeRobot monitor on `https://YOUR-APP.onrender.com/healthz` every 5
  minutes keeps it running (HTTP(s) monitor, keyword `"ok":true` optional).
- **Ephemeral filesystem:** `data/wallets.xlsx` and `data/settings.json` are lost on
  every deploy, restart, or spin-down. Setting `WALLETS_SHEET_URL` avoids the upload
  entirely (the sheet is re-downloaded on every run); without it, log in, **upload
  wallets.xlsx** again, and press **Start loop** (the loop is off after a restart
  unless `AUTO_START_LOOP=true`).
- Render may restart a free service at any time, and 750 free instance hours per
  month is just under a full month (~744 h) — an always-on service consumes all of it.
- No shell/SSH and no persistent disk on free. `render.yaml` here is configured for
  free; the paid variant (Starter + 1 GB disk at `/app/data`) is commented inside it.
- If losing the sheet on restart becomes annoying, two fixes: move to Starter + disk,
  or keep the sheet in Supabase Storage and download it at cycle start.

**Running with no browser open.** Two things are needed, and they are separate: the
monitor keeps the instance awake, and `AUTO_START_LOOP=true` makes the process start
cycling by itself. With both set — UptimeRobot on `/healthz` every 5 minutes plus
`AUTO_START_LOOP=true` and `LOOP_INTERVAL_MINUTES` — the loop survives a closed tab, a
deploy and a crash. Limits that remain: a spin-down can land mid-cycle (the rows
already published are kept, the remaining wallets wait for the next cycle), 750 free
instance hours is about one month of being always on, and the watchdog is pointing at
`/healthz`, which is unauthenticated on purpose.


## First run after deploy

1. Open the URL and log in with `DASHBOARD_USER` / `DASHBOARD_PASSWORD`.
2. **Upload wallets.xlsx** — only when no Google Sheet is configured. With
   `WALLETS_SHEET_URL` the upload controls are hidden, because the server downloads
   the sheet itself. An upload is validated before saving (missing
   `Wallet Address`/`Token` columns or zero valid rows are rejected, the old file is
   kept).
3. Everything is idle. Press **Run 1 loop** for a single cycle, or set *Loop every N
   minutes* and press **Start loop** — the first cycle starts immediately and the table
   fills one wallet at a time; the next one is booked from its end.
4. The loop never overlaps itself: if a cycle takes longer than the interval, the next
   one starts only after the last wallet has been checked.
5. **Stop** sits next to each section. Mining and side quests share one run slot —
   only one can run at a time (a second start is refused with a 409 naming the run
   that holds it). Stop finishes the wallet in progress, ends the run, and turns the
   auto loop off so it cannot restart by itself; the rows already done stay on screen
   and the log says `stopped after N/M wallet(s)`.

## Files and secrets

- `data/wallets.xlsx` — the uploaded sheet (contains bearer tokens: treat as secrets).
- `data/settings.json` — the loop interval you picked; the loop itself always starts off.
- `wallets.xlsx` files are excluded from the image by `.dockerignore`, so no sheet is
  ever baked into a deployment.
- Keep the dashboard behind HTTPS; bearer tokens travel in request bodies only when the
  server talks to the API, but the sheet upload contains them.

## Wallets from a Google Sheet

Set `WALLETS_SHEET_URL` to the normal Google Sheets link
(`https://docs.google.com/spreadsheets/d/<id>/edit?usp=sharing`) or just the sheet id,
and share the sheet with **anyone with the link (viewer)**. Then:

- every run (**Run 1 loop** and each side-quest button) downloads a fresh `.xlsx`
  before reading the wallets, so edits made in Google apply to the next click — no
  restart, no upload;
- the download is cached as `data/wallets.xlsx`, so if Google is unreachable the run
  continues with the last copy and logs a warning;
- the **Social Daily** column decides who runs the social daily quest: an `x` means
  yes, blank means that wallet is skipped for it. A sheet without that column runs it
  for every wallet.

Columns: `Name`, `Wallet Address`, `Token`, `Proxy`, `Location`, `Social Daily`.
Uploads from the UI still work; a configured `WALLETS_SHEET_URL` wins over them.

## Local use

```bash
npm install
WALLETS_SHEET_URL='https://docs.google.com/spreadsheets/d/<id>/edit?usp=sharing' npm run ui
# http://127.0.0.1:4173 (falls back to the next port if busy)
```

Without `WALLETS_SHEET_URL`, local runs read `data/wallets.xlsx` if it exists,
otherwise `./wallets.xlsx`.
