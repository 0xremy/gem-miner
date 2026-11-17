# Guide: configuration and local runs

Three apps live in this repository. They are independent: separate folders, separate
dependencies, **separate `.env` files**, and separate config loaders. The only thing
they can share is the Google Sheet.

| App | Folder | What it does | Writes to the sheet? |
|---|---|---|---|
| Dashboard ("mother") | repo root (`src/`) | Web UI: positions, mining, claims, side quests | No |
| Token refresher | `token-refresher/` | Logs wallets in with seed phrases, writes fresh JWTs | **Yes** — the `Token` column |
| Power upgrade | `power-upgrade/` | Buys mining power (default), energy capacity (`--energy`) or a shop item (`src/buy.js`), and reports shop ownership as `.xlsx` (`src/audit.js`) | No |

Every app loads `.env` from its own folder, and a **real environment variable always
wins** over the file. `.env` is gitignored in all three; create each one from that
app's `.env.example` and never commit it.

**Order for a new setup:** `token-refresher` first (it fills the `Token` column), then
`power-upgrade` or the dashboard. Both of those only read tokens.

---

## 1. Mother project — the dashboard (repo root)

Config file: **`.env` in the repository root** (`src/config.js` loads `../.env`).
Template: `.env.example` in the repository root.

| Variable | Purpose |
|---|---|
| `WALLETS_SHEET_URL` | **the one you normally change.** Full Google Sheet link or bare id. Every run downloads a fresh `.xlsx`, so edits in Google apply to the next run. |
| `WALLETS_SHEET_ID` | same thing, id only — use one or the other |
| `DASHBOARD_PASSWORD` | Basic-auth password. Always set it for any non-local URL. |
| `DASHBOARD_USER` | login name, defaults to `admin` |
| `WALLETS_FILE` | where the sheet file is kept, defaults to `data/wallets.xlsx` (falls back to `./wallets.xlsx` locally) |
| `AUTO_START_LOOP` | `true` makes the loop resume after a restart with no browser open |
| `LOOP_INTERVAL_MINUTES` | loop interval, 1–1440; otherwise the last value from the UI is used |
| `PORT` / `HOST` | defaults `4173` / `0.0.0.0` |

`WALLETS_SHEET_URL` is genuinely optional here — unlike `SHEET_ID` in the two CLI apps,
which is required. With it unset the dashboard reads the uploaded `data/wallets.xlsx`
(falling back to `./wallets.xlsx`), which is exactly how this checkout runs today: the
root `.env` has no sheet link and `data/wallets.xlsx` holds the upload. Add the variable
only when you want the dashboard to pull the sheet from Google.

### Sheet access — different from the other two apps

This app needs **no Google Cloud project and no service account**. Share the sheet as
*"anyone with the link (viewer)"* and point `WALLETS_SHEET_URL` at it; the server fetches
the xlsx export URL. If the sharing is wrong you get HTML instead of an xlsx, and the
app says so.

Prefer not to link-share? Leave `WALLETS_SHEET_URL` unset and **upload `wallets.xlsx`**
from the dashboard instead. A configured URL wins over an upload.

Only the **first worksheet** is read — there is no tab setting, so the wallet tab must
be leftmost. Headers are matched leniently (`Wallet Address` = `walletaddress`):

| Header | Notes |
|---|---|
| `Wallet Address` | required, `0x…` 40 hex |
| `Token` | required, must look like a bearer JWT |
| `Name` / `Label` | optional |
| `Proxy` | optional, `host:port::user:pass`, `host:port:user:pass`, `socks5://host:port:user:pass` or `socks5://user:pass@host:port` |
| `Location` / `Mine` | optional mine id or alias |
| `Social Daily` | `x` = run the social daily quest for that wallet, blank = skip |

### Run locally

```bash
cd "<repository root>"
npm install
npm run ui            # or: npm start
# → http://127.0.0.1:4173
```

Log in with `DASHBOARD_USER` / `DASHBOARD_PASSWORD`. If 4173 is busy locally the server
walks to the next free port; when `PORT` is set explicitly it must bind exactly (that is
what hosting platforms expect).

`npm run positions`, `npm run claim` and `npm run mine` are the separate single-wallet
CLI mode; they use `GEM_API_TOKEN` + `GEM_WALLET_ADDRESS`, not the sheet. Deployment
details (Docker, Render, Oracle) are in `DEPLOY.md`.

---

## 2. token-refresher

Config file: **`token-refresher/.env`**. Template: `token-refresher/.env.example`.

| Variable | Purpose |
|---|---|
| `SHEET_ID` | the target sheet, full link or bare id |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | path to the service-account key JSON, e.g. `./service-account.json` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | alternative to the file — the whole key on one line |
| `KEYS_XLSX` | seed-phrase workbook: `Name \| Wallet Address \| Seed Phrase` |
| `DERIVATION_LIMIT` | BIP-44 addresses tried per seed phrase before giving up, default 20 |
| `CONCURRENCY` | parallel logins, default 3 |
| `AUTH_RETRIES` | retries on 429/5xx/dropped tunnel, default 3 |
| `GEM_BASE_URL` | defaults to `https://gemapi.bullshot.io` |

**Sheet access:** create a Google Cloud service account, enable the **Google Sheets
API**, download the JSON key, and share the spreadsheet with the key's `client_email`
as **Editor** — this app writes tokens, so viewer access is not enough.

### Run locally

```bash
cd token-refresher
npm install
node src/index.js --dry-run --only 0x<one-wallet>   # mint and print, write nothing
node src/index.js                                  # all rows, writes tokens back
```

Flags: `--dry-run`, `--only <address>`, `--limit <n>`, `--concurrency <n>`, `--no-proxy`.

Use `node src/index.js` when passing flags — `npm run refresh -- --dry-run` also works,
but npm needs the extra `--` to forward them. Tokens last 72 hours; a `401` elsewhere
means that row needs a refresh.

---

## 3. power-upgrade

Config file: **`power-upgrade/.env`**. Template: `power-upgrade/.env.example`.

| Variable | Purpose |
|---|---|
| `SHEET_ID` | the target sheet, full link or bare id |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | path to the service-account key JSON (relative to this app's folder) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | alternative to the file |
| `TARGET_POWER` | stop once mining power reaches this, default `62` (first stop past 60) |
| `UPGRADE_ID` / `UPGRADE_COST` / `UPGRADE_INCREMENT` | Mining Power I, used for the dry-run plan |
| `ENERGY_UPGRADE_ID` / `ENERGY_INCREMENT` | Energy Capacity I, defaults `upg-energy-1` / `20` |
| `SHOP_ITEM_ID` / `SHOP_ITEM_PRICE` | item bought by `src/buy.js`, defaults `mine-cart-1` / `4500` |
| `CONCURRENCY` | parallel wallets, default 3 |
| `AUTH_RETRIES` | retries on 429/5xx, default 3 |
| `GEM_BASE_URL` | defaults to `https://gemapi.bullshot.io` |

There is deliberately **no energy price variable**: the cost varies by level and over
time, so `--energy` buys one level at a time until the API itself refuses. Prices read
from responses are reported, never assumed.

**Sheet access:** same service account as `token-refresher`, shared as **Editor**. Rows
are matched by `Wallet Address`; `Token` must already hold a live token, and each
wallet's `Proxy` is used for all of its requests.

### Run locally

```bash
cd power-upgrade
npm install
node src/index.js --dry-run --limit 2   # read balances, buy nothing
node src/index.js                       # power up to TARGET_POWER
node src/index.js --energy --dry-run    # balances only — the price is unknown before buying
node src/index.js --energy              # buy energy until refused
node src/audit.js                       # shop: who owns Mine Cart Mk I → mine-cart-audit.xlsx
node src/buy.js --dry-run               # shop: who would be charged
node src/buy.js                         # shop: buy it for every wallet that lacks it
```

Also available: `--only <address[,address]>`, `--limit <n>`, `--concurrency <n>`, `--no-proxy`,
`--fallback-direct` (retry a wallet whose proxy is down over your own IP).
`--energy` is the only extra upgrade mode, and `src/buy.js` is a separate one-off
shop purchase; mining, claims and side quests belong to the dashboard (section 1),
so this tool never touches positions or quests.

---

## Handing this to someone else

Give them the code plus `guide.md`, `DEPLOY.md` and the `.env.example` files. Do **not**
copy:

- any `.env` (credentials and their password),
- `service-account.json` anywhere (Google key),
- `data/`, `wallets.xlsx`, `wallets.xlsx.bak`, `wallets.json` (bearer tokens),
- `node_modules/`,
- `*.log` files (wallet addresses and balances).

All of it is gitignored already. Their `.env` files must point at **their** sheet; the
templates use `<your-sheet-id>` placeholders.

**The trap:** the two apps use two different sharing models for the same spreadsheet.

| App | How the sheet is reached | Sharing required |
|---|---|---|
| Dashboard | public `.xlsx` export URL | *Anyone with the link (viewer)* |
| `token-refresher` | Google Sheets API | Service account `client_email` as **Editor** |
| `power-upgrade` | Google Sheets API | Service account `client_email` as **Editor** |

And in every app, only the **first worksheet** of the spreadsheet is read.
