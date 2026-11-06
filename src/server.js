import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  snapshot,
  triggerNow,
  setLoop,
  loopState,
  runQuestFeature,
  requestStop,
} from "./runner.js";
import { AUTO_QUESTS } from "./features/quests.js";
import { inspectXlsxBuffer, loadWallets, walletsFilePath } from "./wallets.js";
import { sheetSource } from "./sheet-source.js";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const pagePath = fileURLToPath(new URL("../public/index.html", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Optional gate so a public deployment is not open to anyone with the URL. */
const AUTH_USER = process.env.DASHBOARD_USER || "admin";
const AUTH_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function authorized(req) {
  if (!AUTH_PASSWORD) return true;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const [user, ...rest] = Buffer.from(encoded, "base64").toString("utf8").split(":");
  return user === AUTH_USER && rest.join(":") === AUTH_PASSWORD;
}

/**
 * Mining and side quests share one run slot: a second start is refused and the
 * 409 says which run is holding it, so the dashboard can point at the right Stop.
 */
function busyMessage(kind) {
  return kind === "quests"
    ? "a side-quest run is already in progress — press Stop in Side quests first"
    : "a mining run is already in progress — press Stop in Mining first";
}

function readBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error(`file is larger than ${Math.round(limit / 1024 / 1024)} MB`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function walletFileInfo() {
  const file = walletsFilePath();
  let size = null;
  let modifiedAt = null;
  try {
    const info = await stat(file);
    size = info.size;
    modifiedAt = info.mtime.toISOString();
  } catch {
    // not uploaded yet
  }

  let count = null;
  let skipped = [];
  if (size !== null) {
    try {
      count = (await loadWallets({ quiet: true, fresh: true })).length;
    } catch (error) {
      count = null;
      skipped = [error.message];
    }
  }

  return {
    file: relative(projectRoot, file).replaceAll("\\", "/"),
    source: sheetSource(),
    exists: size !== null,
    size,
    modifiedAt,
    count,
    skipped,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Health check for cloud platforms (unauthenticated on purpose).
    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!authorized(req)) {
      res.writeHead(401, {
        "www-authenticate": 'Basic realm="Gem Miner", charset="UTF-8"',
        "content-type": "text/plain; charset=utf-8",
      });
      res.end("authentication required");
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(pagePath, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/report") {
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const current = snapshot();
      const started = triggerNow("manual");
      sendJson(res, started ? 202 : 409, {
        started,
        error: started ? undefined : busyMessage(current.runKind),
        runningKind: current.runKind,
      });
      return;
    }

    // Stop: shared by the mining and the side-quests section — only one run ever
    // exists, so a single flag ends whichever one is in flight.
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const result = requestStop();
      sendJson(res, result.stopped ? 202 : 409, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/quests/run") {
      const body = await readBody(req, 8 * 1024);
      let payload = {};
      if (body.length) {
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          sendJson(res, 400, { error: "body must be JSON" });
          return;
        }
      }

      try {
        const questId = String(payload.questId ?? "");
        const feature = AUTO_QUESTS.find((quest) => quest.id === questId);
        if (!feature) {
          sendJson(res, 400, { error: `unknown quest "${questId}"` });
          return;
        }
        const current = snapshot();
        if (current.running) {
          sendJson(res, 409, {
            error: busyMessage(current.runKind),
            started: false,
            runningKind: current.runKind,
          });
          return;
        }
        // Fire and forget: the dashboard polls /api/report for the result.
        runQuestFeature(questId, { reason: `quest: ${feature.label}` });
        sendJson(res, 202, { started: true, questId, label: feature.label });
      } catch (error) {
        sendJson(res, error.status || 400, { error: error.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/wallets") {
      sendJson(res, 200, await walletFileInfo());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/wallets") {
      const buffer = await readBody(req);
      if (!buffer.length) {
        sendJson(res, 400, { error: "empty upload — pick a .xlsx file" });
        return;
      }

      let inspected;
      try {
        inspected = await inspectXlsxBuffer(buffer);
      } catch (error) {
        sendJson(res, 400, { error: `not a usable .xlsx sheet: ${error.message}` });
        return;
      }
      if (inspected.count === 0) {
        sendJson(res, 400, {
          error: "the sheet has no valid wallet rows (need the Wallet Address and Token columns)",
          skipped: inspected.skipped,
        });
        return;
      }

      const target = walletsFilePath();
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buffer);

      // Force the next cycle to re-read from disk.
      await loadWallets({ quiet: true, fresh: true }).catch(() => {});

      sendJson(res, 200, {
        saved: true,
        file: relative(projectRoot, target).replaceAll("\\", "/"),
        count: inspected.count,
        skipped: inspected.skipped,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/loop") {
      const body = await readBody(req, 64 * 1024);
      let payload = {};
      if (body.length) {
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          sendJson(res, 400, { error: "body must be JSON" });
          return;
        }
      }
      try {
        const loop = setLoop({
          enabled: typeof payload.enabled === "boolean" ? payload.enabled : undefined,
          intervalMinutes: payload.intervalMinutes,
        });
        sendJson(res, 200, { loop });
      } catch (error) {
        sendJson(res, 400, { error: error.message, loop: loopState() });
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "unknown endpoint" });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
});

/** A stale local dashboard can hold the port; on a platform PORT must be exact. */
const PORT_ATTEMPTS = process.env.PORT ? 1 : 10;

function listen(port, attempt = 0) {
  server.once("error", onError);

  function onError(error) {
    if (error.code === "EADDRINUSE" && attempt < PORT_ATTEMPTS) {
      const next = port + 1;
      console.log(`port ${port} is busy (another dashboard running?), trying ${next}…`);
      listen(next, attempt + 1);
      return;
    }
    console.error(`could not start dashboard: ${error.message}`);
    if (error.code === "EADDRINUSE") {
      console.error(`stop the other process or run with a free port: PORT=4200 npm run ui`);
    }
    process.exitCode = 1;
  }

  server.listen(port, HOST, () => {
    server.off("error", onError);
    console.log(`Gem miner dashboard → http://${HOST}:${port}`);
    if (AUTH_PASSWORD) console.log(`login required (user "${AUTH_USER}")`);
    console.log("auto-run is OFF — nothing happens until you click Run 1 loop, a side quest or Start loop");
    const source = sheetSource();
    console.log(
      source.kind === "google-sheet"
        ? `wallets source: Google Sheet ${source.url ? "(re-imported on every run)" : `(invalid: ${source.error})`}`
        : "wallets source: local .xlsx (re-read on every run)",
    );
    console.log(`wallets file: ${relative(projectRoot, walletsFilePath()).replaceAll("\\", "/")}`);
  });
}

listen(PORT);
