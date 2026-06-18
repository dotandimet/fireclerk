#!/usr/bin/env node
// FireClerk native-messaging host.
//
// Firefox spawns this process when the extension calls connectNative(). It
// bridges two channels:
//   - stdin/stdout: the native-messaging link to the extension (length-framed)
//   - a unix socket: where the `fireclerk` CLI connects to issue commands
//
// A CLI request arrives on the socket as {cmd, args}. We tag it with an id,
// forward it to the extension over stdout, and route the extension's reply
// (matched by id) back to the originating socket. Nothing is ever written to
// stdout except framed native messages — stray output would corrupt the link,
// so all diagnostics go to stderr.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createFrameReader, frame, SOCK_PATH } from "./protocol.js";

const REQUEST_TIMEOUT_MS = 30_000;

const pending = new Map(); // id -> socket awaiting a reply
let seq = 0;

const LOG_PATH = path.join(path.dirname(SOCK_PATH), "host.log");
function log(...args) {
  const line = "[fireclerk-host] " + args.join(" ");
  console.error(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* best effort */
  }
}

// Firefox invokes the host with argv = [hostManifestPath, extensionId].
log("spawned pid=" + process.pid + " argv=" + JSON.stringify(process.argv.slice(2)));

// --- Extension -> host (replies) ---------------------------------------------
process.stdin.on(
  "data",
  createFrameReader((msg) => {
    const sock = pending.get(msg.id);
    if (!sock) return; // late/duplicate reply, or timed out already
    pending.delete(msg.id);
    try {
      sock.write(frame(msg));
      sock.end();
    } catch {
      /* client went away */
    }
  })
);
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdout.on("error", () => process.exit(0)); // EPIPE if Firefox closes

// --- CLI <-> host (the unix socket) ------------------------------------------
fs.mkdirSync(path.dirname(SOCK_PATH), { recursive: true });
try {
  fs.unlinkSync(SOCK_PATH); // clear a stale socket from a previous run
} catch {
  /* nothing to remove */
}

const server = net.createServer((sock) => {
  sock.on(
    "data",
    createFrameReader((req) => {
      const id = ++seq;
      pending.set(id, sock);
      try {
        process.stdout.write(frame({ id, cmd: req.cmd, args: req.args || {} }));
      } catch (e) {
        pending.delete(id);
        try {
          sock.write(frame({ id, ok: false, error: "host->extension write failed: " + e.message }));
          sock.end();
        } catch {
          /* ignore */
        }
        return;
      }
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        try {
          sock.write(frame({ id, ok: false, error: "timed out waiting for the extension" }));
          sock.end();
        } catch {
          /* ignore */
        }
      }, REQUEST_TIMEOUT_MS);
    })
  );
  sock.on("error", () => {});
});

let rebound = false;
server.on("error", (e) => {
  // A stale socket from a crashed/replaced host: clear it and retry once.
  if (e.code === "EADDRINUSE" && !rebound) {
    rebound = true;
    try {
      fs.unlinkSync(SOCK_PATH);
    } catch {
      /* ignore */
    }
    server.listen(SOCK_PATH);
    return;
  }
  log("socket server error:", e.message);
  process.exit(1);
});

server.listen(SOCK_PATH, () => {
  log("listening on", SOCK_PATH);
  // Announce ourselves so the extension can confirm a live link in DevTools.
  try {
    process.stdout.write(frame({ event: "hello", pid: process.pid }));
  } catch {
    /* Firefox not listening yet; harmless */
  }
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
