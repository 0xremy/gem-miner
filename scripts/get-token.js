/**
 * Grab the gem.bullshot.io bearer token out of localStorage.
 *
 * This is a BROWSER snippet, not a Node script: open https://gem.bullshot.io,
 * log in with the wallet you want to add, then paste the whole file into
 * DevTools -> Console and press Enter.
 *
 * It prints:
 *   - the wallet address encoded in the token (payload.walletAddress)
 *   - the token expiry, and whether it has already passed
 *   - the raw token, copied to the clipboard
 *
 * Paste that value into the "Token" column of wallets.xlsx as-is: no
 * "Bearer " prefix, no surrounding quotes. Tokens are per-wallet, so repeat
 * this for each wallet (separate browser profile or reconnect the wallet).
 */
(() => {
  if (typeof localStorage === "undefined") {
    console.error("Run this in the browser console on https://gem.bullshot.io, not with node.");
    return;
  }

  const raw = localStorage.getItem("rg_jwt_token");
  if (!raw) {
    console.error("rg_jwt_token not found — log in on gem.bullshot.io first.");
    return;
  }

  const token = raw.trim().replace(/^"|"$/g, "");
  const parts = token.split(".");
  if (parts.length !== 3) {
    console.error("rg_jwt_token is not a JWT:", raw.slice(0, 40) + "…");
    return;
  }

  const decode = (segment) =>
    JSON.parse(
      atob(segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=")),
    );

  let payload;
  try {
    payload = decode(parts[1]);
  } catch {
    console.error("could not decode the JWT payload");
    return;
  }

  const expires = payload.exp ? new Date(payload.exp * 1000) : null;
  console.log("wallet address:", payload.walletAddress ?? "(not in token)");
  console.log(
    "expires:",
    expires ? expires.toISOString() : "unknown",
    expires && expires < new Date() ? "← EXPIRED, log in again" : "",
  );

  navigator.clipboard
    ?.writeText(token)
    .then(() => console.log('copied to clipboard — paste into the Token column, no "Bearer " prefix'))
    .catch(() => console.log("token:", token));

  return token;
})();
