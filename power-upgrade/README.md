# power-upgrade

Buys **Mining Power I** (`upg-power-1`) for every wallet in the Google Sheet
until its mining power clears the target, or — with `--energy` — raises Energy
Capacity instead.

Each purchase is a flat **+5 power for 250 gems**, and a wallet starts at
2 power: 2 → 7 → 12 → … → 62. So `TARGET_POWER=62` is the first stop past 60 —
12 purchases per wallet, 3,000 gems.

```
GET  /api/user/balance              → { gems, miningPower, energyCapacity, … }
POST /api/upgrades/upg-power-1      → { success, upgrade: { increment, cost }, user: { miningPower, gems } }
POST /api/upgrades/upg-energy-1     → { success, message, upgrade: { increment, cost }, user: { gems, energyCapacity } }
```

## How a wallet is handled

1. Read the balance once → current `miningPower` and `gems`.
2. `needed = ceil((62 − power) / 5)`, `affordable = floor(gems / 250)`,
   and buy `min(needed, affordable)` times.
3. Loop the `POST`, taking the new power/gems straight from each response, and
   stop early if power reaches the target or gems run out.
4. Read the balance again to confirm the final power instead of trusting the
   running tally.

Wallets that already sit at ≥ 62 are left alone. Wallets that cannot afford a
single upgrade are reported, never partially drained.

## Energy capacity

`--energy` spends each wallet's gems on Energy Capacity upgrades until it can no
longer afford the next level (there is no target):

```powershell
node src/index.js --energy --dry-run          # read balances only; buys nothing
node src/index.js --energy --only 0x…       # one wallet
node src/index.js --energy --concurrency 8  # the whole sheet, 8 wallets at a time
```

The price of this upgrade is not constant — it depends on the level and drifts
over time (observed 420–600 gems per level at low levels, ~1,080 at high ones).
So nothing here is budgeted from a configured price:

- **No configured cost.** `ENERGY_COST` was removed; there is no price to guess.
- **No gems-vs-price pre-check.** The loop asks for the next level and stops only
  when the API itself refuses (out of gems, or at the cap), which is the only
  authoritative answer at that moment.
- **Prices are read from responses** for reporting only; they never gate a buy.

A dry run therefore reads balances and stops there — without buying, the next
price is simply unknown. Results print per wallet as they finish, which matters
here: a funded wallet needs dozens of requests. Leftover gems are normal — that
is whatever is under the next level's live price.

## Shop purchase (Mine Cart Mk I)

`src/buy.js` is a one-off buy for a shop item, default **Mine Cart Mk I**
(`mine-cart-1`, gear: +6% loot yield, 4,500 gems). One purchase per wallet:

```
POST /api/shop/purchase  { "itemId": "mine-cart-1" }
→ { success, item: { id, name, price, … }, user: { gems, … }, inventory: [ … ] }
```

```powershell
node src/audit.js                      # who owns it → mine-cart-audit.xlsx
node src/buy.js --dry-run              # show who would be charged; buys nothing
node src/buy.js --limit 2              # buy for two wallets (smoke test)
node src/buy.js --only 0x…,0x…         # specific wallets
node src/buy.js                        # buy for every wallet that lacks it
node src/buy.js --item mine-cart-2 --price 12000
```

Ownership comes from the inventory endpoint, so nobody is charged twice:

```
GET /api/user/inventory → [ { assetId: "mine-cart-1", name: "Mine Cart Mk I", quantity: 1, … } ]
```

`src/buy.js` reads that list first and skips a wallet that already holds the
item (`= … already owns`), then buys only the rest. A 400 from the shop is still
classified the same way in case the inventory read is unavailable. `--price`
(or `SHOP_ITEM_PRICE`) only pre-skips wallets that clearly cannot pay and
describes the dry run; a live purchase reports the real price from its
response, and the balance is re-read afterwards to confirm the gems spent.

`src/audit.js` is the read-only report: one row per sheet row with name,
address, whether the item is owned, quantity, gems, whether they can afford it,
the proxy used, and any error — plus a summary tab. Nothing is bought. Rows are
filterable in Excel, so "Owns item = no" shows exactly who is left to buy for.
Add `--out report.xlsx` for another path.

Both tools accept `--only a,b`, `--limit n`, `--concurrency n`, `--no-proxy`,
and `--fallback-direct`, which retries a wallet whose proxy refuses the tunnel
over your own IP (the row is labelled `direct fallback` in the report).

## Setup

```powershell
cd power-upgrade
npm install
copy .env.example .env    # or edit the existing .env
```

## Using it with your own sheet

Nothing about the sheet is baked into the code — it all comes from `.env`.

**1. The sheet.** `SHEET_ID` takes either the full link or the bare id:

```ini
SHEET_ID=https://docs.google.com/spreadsheets/d/<your-id>/edit?usp=sharing
# or
SHEET_ID=<your-id>
```

**2. The tab.** There is no tab setting: the app reads the **first worksheet**
in the spreadsheet. If your wallets are on another tab, drag it to the leftmost
position (or make a new spreadsheet whose first tab is the one you want).

**3. The columns.** Headers are found by name on row 1, in any order, case and
spaces ignored. Required:

| Header | Purpose |
|---|---|
| `Wallet Address` (or `Address`) | `0x…` — rows are matched by this, never by position |
| `Token` (or `Bearer`) | the wallet's auth token |
| `Proxy` (or `Proxies`, `Proxy URL`) | optional, `host:port::user:pass`, `host:port:user:pass`, `socks5://host:port:user:pass` or `socks5://user:pass@host:port`; every request for that wallet leaves through it |
| `Name` (or `Wallet`, `Profile`) | optional label for the output |

Other columns (`Location`, `Gear`, `Social Daily`, …) are read by the dashboard
service, not by this tool, and are ignored here. Rows without a valid `0x…`
address in the address column are skipped.

**4. The credentials.** Create a Google Cloud service account, enable the
**Google Sheets API**, download its JSON key, then share the spreadsheet with
the key's `client_email` as **Editor**. Point `.env` at the file:

```ini
GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json
# or paste the whole key on one line:
# GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

Relative paths resolve against this app's folder, so `./service-account.json`
means `power-upgrade/service-account.json`. (In this checkout `.env` points at
`../token-refresher/service-account.json`, but that is a local choice, not a
requirement — use your own key.)

**5. Tokens.** A wallet needs a live token in the `Token` column. Either paste
them in yourself, or run `token-refresher` against the same sheet with the
keys/seed phrases file. Tokens last 72 h; a `401` means that row needs a refresh.

Check it without spending anything:

```powershell
node src/index.js --dry-run --limit 2
```

**When handing the folder to someone:** do not copy `.env`, `service-account.json`
or `node_modules` (all gitignored, all personal), and do not copy the `*.log`
files — they contain wallet addresses and balances. Give them the code plus
`.env.example`, and have them do steps 1–5 with their own sheet and key.

## Usage

```powershell
node src/index.js --dry-run      # read all balances, print the plan and total cost
node src/index.js --limit 2      # upgrade only two wallets (smoke test)
node src/index.js --only 0x…     # one wallet
node src/index.js                # every wallet in the sheet
node src/index.js --target 100   # a different stop point
node src/index.js --energy       # Energy Capacity instead of Mining Power
```

Options: `--dry-run`, `--only <address>`, `--limit <n>`, `--target <power>`,
`--energy`, `--no-proxy`, `--concurrency <n>`, `--help`. `--energy` is the only
extra mode; mining is the dashboard's job (`src/` at the repo root).

Output per wallet:

```
✓ ADS-007 0xe405…427d: 7 → 62 power, gems 6,200 → 3,200 (+11, 3,000 gems), via 45.12.7.9:8000
= ADS-008 0x…: already 62 power
⚠ ADS-009 0x…: 2 power, 300 gems — cannot afford any of 12 upgrade(s)
✗ ADS-010 0x…: GET /api/user/balance → 401 (token expired — run the token refresher)
```

## Notes

- **It spends gems.** Start with `--dry-run` to see what the whole sheet costs,
  then `--limit` for a live sample.
- Tokens live for 72 h; a `401` means that row needs `token-refresher` first.
- Every request leaves through the wallet's own proxy from the sheet, so
  Cloudflare's per-IP limits do not trip on a full run. `--no-proxy` goes direct.
- Proxy credentials are never printed: output shows `host:port` only.
