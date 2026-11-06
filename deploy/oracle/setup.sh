#!/usr/bin/env bash
# Oracle Cloud Always Free VM setup for the Gem Miner dashboard.
#
#   sudo bash deploy/oracle/setup.sh
#
# Installs Node 22, creates the `gems` service user, installs the systemd unit,
# the env-file template and Caddy (HTTPS). Safe to re-run.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "run me with sudo: sudo bash deploy/oracle/setup.sh" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/gem-miner
ENV_FILE=/etc/gem-miner.env

say() { printf '\n== %s\n' "$*"; }

say "packages"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg rsync unzip
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl ca-certificates gnupg2 rsync unzip
else
  echo "unsupported distro: install Node 22 and Caddy by hand (see README.md)" >&2
  exit 1
fi

say "node 22"
if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == v22.* ]]; then
  echo "already installed: $(node -v) at $(command -v node)"
else
  # NodeSource supports both x86_64 and arm64 (Ampere A1).
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y nodejs
  else
    dnf install -y nodejs
  fi
  echo "installed: $(node -v)"
fi

say "service user + directories"
id -u gems >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin gems
install -d -o gems -g gems "$APP_DIR" "$APP_DIR/data"

say "systemd unit"
install -m 644 "$HERE/gem-miner.service" /etc/systemd/system/gem-miner.service

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  cat >"$ENV_FILE" <<'EOF'
# Gem Miner dashboard settings — keep this file private (chmod 600).
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=change-me

# Google Sheet link (shared with "anyone with the link"), or just the sheet id.
# The sheet is re-downloaded at the start of every run.
WALLETS_SHEET_URL=
EOF
  echo "wrote $ENV_FILE — set DASHBOARD_PASSWORD and WALLETS_SHEET_URL"
else
  echo "kept existing $ENV_FILE"
fi

say "caddy (automatic HTTPS)"
if command -v caddy >/dev/null 2>&1; then
  echo "already installed: $(caddy version | head -1)"
elif command -v apt-get >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  dnf install -y 'dnf-command(copr)'
  dnf copr enable -y @caddy/caddy
  dnf install -y caddy
fi

if [[ ! -f /etc/caddy/Caddyfile ]] || ! grep -q "gem-miner\|gems\." /etc/caddy/Caddyfile 2>/dev/null; then
  install -m 644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
  echo "installed /etc/caddy/Caddyfile — replace gems.example.com with your domain"
fi

systemctl daemon-reload
systemctl enable caddy >/dev/null 2>&1 || true

cat <<EOF

Next (see deploy/oracle/README.md for the copy commands):
  1. edit  $ENV_FILE   (DASHBOARD_PASSWORD, WALLETS_SHEET_URL)
  2. copy the project into $APP_DIR and run: npm ci --omit=dev
  3. sudo systemctl enable --now gem-miner
  4. set your domain in /etc/caddy/Caddyfile, then: sudo systemctl restart caddy
EOF
