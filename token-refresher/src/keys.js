import ExcelJS from "exceljs";
import { HDNodeWallet, Mnemonic, Wallet } from "ethers";

/**
 * Reads the seed-phrase workbook: three columns, many rows.
 *
 *     Name | Wallet Address | Seed Phrase
 *
 * Headers are matched leniently ("Wallet Address" == "walletaddress",
 * "Seed Phrase" == "seed" / "mnemonic"), so small renames keep working.
 */

const COLUMNS = {
  name: "name",
  walletname: "name",
  profile: "name",
  wallet: "name",
  label: "name",
  walletaddress: "address",
  address: "address",
  seedphrase: "seed",
  seed: "seed",
  mnemonic: "seed",
  secretphrase: "seed",
  privatekey: "seed", // accepted as a fallback, see signerFor()
};

const normalize = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export async function readSeedWorkbook(path) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`${path} has no worksheet`);

  const at = {};
  sheet.getRow(1).eachCell((cell, column) => {
    const field = COLUMNS[normalize(cell.text)];
    if (field && !at[field]) at[field] = column;
  });
  for (const required of ["address", "seed"]) {
    if (!at[required]) {
      throw new Error(
        `the workbook needs a "${required === "seed" ? "Seed Phrase" : "Wallet Address"}" column (found: ${sheet
          .getRow(1)
          .values.filter(Boolean)
          .join(" | ")})`,
      );
    }
  }

  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const pick = (field) => (at[field] ? row.getCell(at[field]).text.trim() : "");
    const address = pick("address");
    const seed = pick("seed").replace(/\s+/g, " ").trim();
    if (!address && !seed) continue; // blank / template rows
    rows.push({ row: r, name: pick("name") || `row-${r}`, address, seed });
  }

  if (rows.length === 0) throw new Error(`${path} has no wallet rows`);
  return rows;
}

const PRIVATE_KEY_RE = /^(0x)?[0-9a-f]{64}$/i;

/**
 * Turns one seed-phrase row into the signer that owns `row.address`.
 *
 * A BIP-39 phrase usually backs several addresses, and which index the game
 * registered is not knowable up front, so we walk the standard Ethereum path
 * m/44'/60'/0'/0/{0..limit-1} until the derived address matches the sheet.
 * The row's own address is the source of truth — we never guess blindly.
 */
export function signerFor({ address, seed }, { limit = 20 } = {}) {
  const want = String(address).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(want)) {
    throw new Error(`wallet address "${address}" is not a 0x… address`);
  }

  // A raw private key is accepted too, in case a row stores one.
  if (PRIVATE_KEY_RE.test(seed)) {
    const wallet = new Wallet(seed);
    if (wallet.address.toLowerCase() !== want) {
      throw new Error(`private key does not belong to ${want}`);
    }
    return { signer: wallet, path: "private-key" };
  }

  let mnemonic;
  try {
    mnemonic = Mnemonic.fromPhrase(seed);
  } catch {
    throw new Error("seed phrase is not a valid BIP-39 mnemonic (word count or checksum is off)");
  }

  for (let index = 0; index < limit; index += 1) {
    const path = `m/44'/60'/0'/0/${index}`;
    const wallet = HDNodeWallet.fromMnemonic(mnemonic, path);
    if (wallet.address.toLowerCase() === want) return { signer: wallet, path };
  }

  throw new Error(
    `seed phrase derives ${limit} addresses but none is ${want} — wrong phrase, or the account sits past m/44'/60'/0'/0/${limit - 1}`,
  );
}
