# Deploying to Oracle Cloud (Always Free)

The dashboard is one Node process (`src/server.js`) that serves a single HTML page,
polls its own JSON, and talks to the Gem API one wallet at a time. There is no
database and no build step, so **any** Always Free shape handles it:

| Shape | Verdict |
| --- | --- |
| `VM.Standard.A1.Flex` — 4 OCPU / 24 GB (ARM, Always Free) | Massive overkill, plenty of headroom |
| `VM.Standard.E2.1.Micro` — 1 OCPU / 1 GB (x86, Always Free) | Works; add 1 GB swap for comfort |
| Any paid shape | Unnecessary |

Measured locally: idle RSS is ~60 MB, a full 106-wallet cycle is a *sequential*
run of small HTTPS requests, so the CPU sits near 0% and the wall-clock time is
network latency, not the server.

The UI is one static page + `/api/report` polling every 5 s. From anywhere on the
internet it feels the same as at home — Caddy puts HTTPS in front, the app keeps
its own Basic auth.

---

## 1. Create the instance

1. Oracle Cloud console → **Compute → Instances → Create instance**.
2. Image: **Canonical Ubuntu 24.04** (or 22.04). Shape: an **Always Free eligible** one
   (Ampere A1 Flex, or `VM.Standard.E2.1.Micro`).
   - If A1 shows "out of capacity", try another availability domain, or take the Micro.
3. Add your SSH key (upload the public half, or let it generate one and download the
   private key).
4. Networking: keep the default VCN. **Assign a public IPv4 address: yes.**
5. Create, then **reserve that public IP** (Instance → Attached VNICs → the public IP →
   *Edit* → *Reserved public IP*). Without this the address can change when the VM
   reboots — that would break your bookmark and the TLS certificate.

## 2. Open ports 80 and 443

Two separate firewalls must both allow them.

**a) VCN security list** — Networking → Virtual Cloud Networks → your VCN →
Security Lists → *Default Security List* → **Add Ingress Rule**, twice:

| Source | IP Protocol | Destination port |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Leave the existing SSH rule (22) alone. Do **not** open 4173 — the app only listens
on localhost.

**b) The OS firewall.** Oracle's Ubuntu images end their `INPUT` chain with a REJECT
rule, so `ufw`/opening the VCN alone is not enough:

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

On Oracle Linux / Rocky images use `firewalld` instead:

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

## 3. Copy the project onto the VM

From your machine, in the project folder (Windows: use Git Bash):

```bash
rsync -av --exclude node_modules --exclude data --exclude .git \
  --exclude '*.xlsx' --exclude '*.xlsx.bak' --exclude wallets.json \
  ./ ubuntu@<PUBLIC_IP>:/tmp/gem-miner/

ssh ubuntu@<PUBLIC_IP>
```

No `rsync` locally? `scp -r` the same folders (`src public scripts package.json
package-lock.json deploy`) or clone the repo on the VM with `git clone <url>`.
**Never ship `wallets.xlsx` / `wallets.json`** — they contain the bearer tokens.

## 4. Install the server pieces

On the VM:

```bash
cd /tmp/gem-miner
sudo bash deploy/oracle/setup.sh
```

That installs Node 22 + Caddy, creates the `gems` user, `/opt/gem-miner`, the
systemd unit, `/etc/gem-miner.env`, and a Caddyfile template.

## 5. Configure secrets

```bash
sudo nano /etc/gem-miner.env
```

```ini
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=<a long random password>
WALLETS_SHEET_URL=https://docs.google.com/spreadsheets/d/<id>/edit?usp=sharing
```

Keep the sheet shared as **anyone with the link (viewer)**; the VM re-downloads it
at the start of every run, so editing the sheet in Google is enough — no redeploy,
no upload from the UI. The file stays `chmod 600`, root-owned.

## 6. Install the app and start it

```bash
cd /tmp/gem-miner
npm ci --omit=dev                                  # dependencies (exceljs, undici)
sudo rsync -a --exclude data /tmp/gem-miner/ /opt/gem-miner/
sudo install -d -o gems -g gems /opt/gem-miner/data
sudo chown -R gems:gems /opt/gem-miner

sudo systemctl enable --now gem-miner
systemctl status gem-miner --no-pager
curl -s http://127.0.0.1:4173/healthz; echo        # → ok
```

Logs (run start/stop, per-wallet lines, sheet import):

```bash
journalctl -u gem-miner -f
```

## 7. Turn on HTTPS

Pick one and put it in `/etc/caddy/Caddyfile`:

- **You own a domain**: add an `A` record `gems.example.com → <reserved public IP>`,
  then use `gems.example.com { … }`.
- **No domain**: use `<PUBLIC_IP_WITH_DASHES>.sslip.io`, e.g.
  `130-61-12-7.sslip.io` — sslip.io resolves that name to the IP, so Let's Encrypt
  can issue a real certificate. (DuckDNS with an A record works the same way.)

```bash
sudo nano /etc/caddy/Caddyfile     # replace gems.example.com with your name
sudo systemctl restart caddy
sudo journalctl -u caddy -n 30 --no-pager
```

Open `https://<your name>` from your phone or any browser: log in, then
**Run 1 loop** / a side quest / **Start loop** behave exactly as locally.
Any second start is refused while one run is in flight, and each section's **Stop**
button ends it — the server is happy to be driven from one tab at a time.

## 8. Updating later

```bash
# after changing files locally
rsync -av --exclude node_modules --exclude data --exclude .git \
  --exclude '*.xlsx' --exclude wallets.json ./ ubuntu@<PUBLIC_IP>:/tmp/gem-miner/
ssh ubuntu@<PUBLIC_IP>
cd /tmp/gem-miner && npm ci --omit=dev
sudo rsync -a --exclude data /tmp/gem-miner/ /opt/gem-miner/ && sudo chown -R gems:gems /opt/gem-miner
sudo systemctl restart gem-miner
```

The `data/` folder is excluded on purpose: it holds the sheet cache and your loop
interval, which should survive an update.

## What survives a reboot

| Thing | After a reboot / restart |
| --- | --- |
| The dashboard service | Comes back up automatically (`enable`) |
| Your loop interval | Kept in `data/settings.json` |
| The wallet sheet | Re-downloaded from Google at the next run (or the cached `data/wallets.xlsx`) |
| The auto loop itself | **Off** — by design. Log in and press **Start loop** if you want it running. |

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Site doesn't load at all | VCN ingress rules missing, or the OS firewall (step 2b) — test `curl -I http://127.0.0.1` on the VM to separate app from network |
| HTTPS fails, browser shows HTTP only | Port 80 not reachable for the ACME challenge; `journalctl -u caddy` says so explicitly |
| `502 Bad Gateway` | `gem-miner` is down or listening elsewhere: `systemctl status gem-miner`, `journalctl -u gem-miner -n 50` |
| `EADDRINUSE` in the unit log | Old manual `node src/server.js` still running: `sudo systemctl stop gem-miner; pkill -f 'node src/server.js'; sudo systemctl start gem-miner` |
| Certificate renewal fails every 60 days | The reserved IP was released or the DNS record changed |
| Wallet rows all error `fetch failed` | The proxies in the sheet can't be reached from that region; try the wallet without its `Proxy` cell to confirm |
| `EACCES` writing the sheet cache | `sudo chown -R gems:gems /opt/gem-miner` (the unit can only write `data/`) |
| Rows appear slowly | Normal: wallets are checked one after another on purpose (~1 s each). A 106-wallet cycle is roughly 2–4 min |

## Notes

- **Keep it local-only if you like:** skip Caddy and use an SSH tunnel instead —
  `ssh -L 4173:127.0.0.1:4173 ubuntu@<ip>` then open `http://127.0.0.1:4173`. No
  ports exposed, but you need the tunnel each time.
- **Docker instead of systemd** is possible (the repo has a `Dockerfile`):
  `docker build -t gem-miner . && docker run -d --name gem-miner --restart unless-stopped -p 127.0.0.1:4173:8080 -v /opt/gem-miner/data:/app/data --env-file /etc/gem-miner.env gem-miner`.
  The systemd route above is lighter on a 1 GB Micro.
- **Secrets:** `DASHBOARD_PASSWORD` is the only thing between the internet and your
  wallet tokens, so make it long; the page is HTTPS-only once Caddy is configured.
