import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";

export const TEMPLATE_COLUMNS = [
  { header: "Name", key: "name", width: 20 },
  { header: "Wallet Address", key: "address", width: 46 },
  { header: "Token", key: "token", width: 100 },
  { header: "Proxy", key: "proxy", width: 40 },
  { header: "Location", key: "location", width: 24 },
];

export function buildTemplate() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "gem-api-client";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("wallets", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = TEMPLATE_COLUMNS;
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEDEDED" },
  };
  sheet.getRow(1).alignment = { vertical: "middle" };

  // One clearly-marked example row; delete or overwrite it.
  sheet.addRow({
    name: "example",
    address: "0x0000000000000000000000000000000000000000",
    token: "paste this wallet's bearer token",
    proxy: "proxy.example.com:8000::user:pass",
    location: "crystal-cavern",
  });
  sheet.getRow(2).font = { italic: true, color: { argb: "FF808080" } };

  return workbook;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = fileURLToPath(new URL("../wallets.template.xlsx", import.meta.url));
  await buildTemplate().xlsx.writeFile(out);
  console.log(`Wrote ${out}`);
}
