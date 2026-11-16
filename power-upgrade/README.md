# power-upgrade

Buys **Mining Power I** (`upg-power-1`) for every wallet in the Google Sheet
until its mining power clears the target.

Each purchase is a flat **+5 power for 250 gems**, and a wallet starts at
2 power: 2 → 7 → 12 → … → 62. So `TARGET_POWER=62` is the first stop past 60 —
12 purchases per wallet, 3,000 gems.

```
GET  /api/user/balance              → { gems, miningPower, … }
POST /api/upgrades/upg-power-1      → { success, upgrade: { increment, cost }, user: { miningPower, gems } }
GET  /api/shop/items                → [ { id, name, price, effect }, … ]   (public)
POST /api/shop/purchase  {itemId}   → { success, item, user: { gems, miningPower }, inventory }
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

## Shop items

The same app also buys shop items (`POST /api/shop/purchase` with `{ itemId }`).
Prices come from the public catalog (`GET /api/shop/items`), so any item id
works:

```powershell
node src/index.js --list-items                          # what the shop sells
node src/index.js --items iron-pickaxe --dry-run        # one item, no spend
node src/index.js --items iron-pickaxe,iron-drill,ruby-laser
node src/index.js --items iron-pickaxe --count 3        # repeatable items only
```

Equipment is unique per wallet: buying one it already owns returns
`400 You already own …`, which is reported as `already owned` and skipped, not
as a failure. Energy packs are the repeatable kind, so `--count` applies there.

## Mining loop

`--mine` runs the mining pass for every wallet: claim what finished, then keep
the appointed mine at six digging veins.

```powershell
node src/index.js --mine --dry-run          # what would be claimed and armed
node src/index.js --mine --only 0x…       # one wallet
node src/index.js --mine --concurrency 8  # the whole sheet
```

Each mine now holds **six veins**, and every position is tied to one vein and
one strategy. A pass is:

1. read the wallet's balance and positions;
2. claim every finished position (`POST /api/mining/positions/:id/claim`);
3. for the mine named in the sheet's `Location` column, start the **deep**
   strategy on every vein that is not digging yet (`POST /api/mining/positions`
   with `{ locationId, spotId, strategy: "deep" }`), until all six are busy;
4. only when all six are digging and energy is left over, walk **down** the rank
   list and fill idle veins there too.

Rank, low → high: `greenstone-quarry`, `crystal-cavern`, `ember-mine`,
`frozen-depths`, `void-rift`, `molten-core`. A mine that still has idle veins
after step 3 is reported as `— waiting for the next loop` and left alone, so the
mode can run on a timer.

`Gear` (column G) is optional and only sent when the cell has a value; the
payload is `{ locationId, spotId, strategy, gear }`. Deep costs and durations
come from `GET /api/mining/locations` (e.g. Ember Mine: 63 energy, 13,500 s),
never from a table in the code.

## Daily and weekly check-in

`--quests` runs both sign-in quests for every wallet — nothing else, no buying:

```powershell
node src/index.js --quests --dry-run          # what is claimable, arms nothing
node src/index.js --quests --only 0x…       # one wallet
node src/index.js --quests --concurrency 8  # the whole sheet, 8 wallets at a time
```

A quest is armed with `POST /api/quests/start` and can only be collected after
its own `delaySeconds` (10 s for both check-ins), so each wallet waits once and
then claims both with `POST /api/quests/claim`. A wallet that already claimed is
reported as such with the reset time and pays nothing, so re-running is safe.
Rewards are worth 75 gems daily and 450 weekly.

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
| `Location` (or `Mine`) | optional, the mine `--mine` keeps at six veins; blank means `greenstone-quarry` |
| `Gear` (or `Loadout`) | optional, sent as `gear` when starting a vein |

Rows without a valid `0x…` address in that column are skipped.

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
```

Options: `--dry-run`, `--only <address>`, `--limit <n>`, `--target <power>`,
`--energy`, `--items <ids>`, `--count <n>`, `--list-items`, `--quests`, `--mine`,
`--no-proxy`, `--concurrency <n>`, `--help`. The modes `--quests`, `--mine`,
`--items` and `--energy` cannot be combined.

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
