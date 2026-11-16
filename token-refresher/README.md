# gem-token-refresher

Standalone companion to the miner app. It re-logs each wallet into Bull GEM using
its **seed phrase**, then writes the fresh JWT back into the Google Sheet —
matched by wallet address, so row order never matters.

The miner app is untouched: it keeps reading the sheet and gets new tokens for free.

## Why this exists

The game has no refresh endpoint. A token is only ever minted by signing:

```
POST /api/auth/nonce  { walletAddress }                       → { nonce, message }
sign message with the wallet key                              → signature  (local)
POST /api/auth/login  { walletAddress, signature, message }   → { token }
```

Every token is a JWT that lives exactly **72 hours**, so wallets need re-login
every ~3 days.

## Setup

1. **Install**

   ```bash
   cd token-refresher
   npm install
   ```

2. **Seed workbook** — an .xlsx whose first sheet has three columns, any order:

   | Name | Wallet Address | Seed Phrase |
   |---|---|---|
   | wallet-0 | 0xd54bac…a32b | word word word … |

   Headers are matched loosely (`Seed Phrase`, `Seed`, `Mnemonic`, …). One row per
   wallet; a phrase may repeat across rows if it backs several addresses.

   The sheet must also have a **Proxy** column — the same one the miner uses.

3. **Google service account** (the sheet must be written, not just read):

   - Google Cloud console → new project → enable **Google Sheets API**
   - Create a **service account**, add a JSON key, download it as
     `token-refresher/service-account.json`
   - Open the sheet → **Share** → paste the service account's email
     (`…@….iam.gserviceaccount.com`) → **Editor**

4. **Config**

   ```bash
   cp .env.example .env
   # SHEET_ID, GOOGLE_SERVICE_ACCOUNT_FILE, KEYS_XLSX
   ```

   `SHEET_ID` accepts the full `…/spreadsheets/d/<id>/edit` link.

## Run

```bash
npm run refresh                                   # mint all and write to the sheet
node src/index.js --expired-only                  # only wallets whose token is dead
node src/index.js --dry-run                       # mint, print expiries, write nothing
node src/index.js --only 0xd54bac… --limit 1      # one wallet — do this first
node src/index.js --limit 5 --concurrency 2
```

`--expired-only` reads the Token column first and skips any wallet whose JWT is
still in date, so routine runs only pay for the wallets that actually need a
login. A blank, malformed or missing token counts as expired. It can be combined
with `--only`, `--limit`, `--dry-run` and `--concurrency`.

Run flagged commands with `node src/index.js` directly, **not** `npm run refresh -- --only …`:
npm reserves `--only` for its own config and mangles the remaining arguments
(`invalid config only=…`, then the option never reaches the app). The plain
`npm run refresh` has no flags, so it is unaffected.

Every login leaves through that wallet's own proxy from the sheet's **Proxy**
column (`domain:port:user:pass`, `domain:port::user:pass`, with optional
`http://`/`https://`/`socks5://` scheme, or the URL form
`socks5://user:pass@domain:port`), recycled from a pool of tunnels. That matters because
Cloudflare rate-limits **per IP**: a few hundred logins from one address start
returning 429s, while 400 wallets across their own residential proxies do not.
Transient failures (429/502/503/504, dropped tunnels) are retried three times
with backoff, honouring `Retry-After`. Use `--no-proxy` to deliberately go
direct. This is why hitting the API from a datacenter IP fails: the proxy is
the sanctioned path.

Output is one line per wallet:

```
✓ wallet-0 0xd54bac…a32b [m/44'/60'/0'/0/3] → row 2, valid until 2026-11-14T09:12:03.000Z (72.0 h), via 45.12.7.9:8000
✗ wallet-7 0xabc…: address is not in the sheet — row skipped
```

Exit code is 1 if anything failed, so it is safe to chain in a cron/Task Scheduler job.

## How a row is matched

1. The address column of the seed workbook is the source of truth.
2. The signer is derived from the phrase at `m/44'/60'/0'/0/{0…19}` until the
   derived address equals the row's address — so a single phrase can back many
   wallets, and the wrong index is never used.
3. The sheet row is found by that same address (case-insensitive, any row order).
4. The token is written to the **Token** column. Nothing else is modified.

A raw `0x…` private key in the seed cell also works, but the seed phrase is the
expected input.

## Notes and limits

- Seed phrases are never logged. Only name, address, derivation path and expiry.
- Only the **first worksheet** is used, on both workbooks.
- A blank Proxy cell falls back to your own IP (reported as `direct`), and a
  malformed one fails just that wallet with the proxy host in the message.
- Concurrent logins are capped (`CONCURRENCY`, default 3) because each one is a
  separate tunnel; retries per request are `AUTH_RETRIES` (default 3).
- Proxy credentials are never printed: output shows `host:port` only.
- Writing tokens does not fix other sheet problems — a wallet with an empty
  **Proxy** cell will still be blocked by Cloudflare when the hosted miner calls
  it, and mines still need enough mining power.
