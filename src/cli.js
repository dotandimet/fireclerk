#!/usr/bin/env node
// FireClerk CLI. Connects to the host's unix socket, sends one command, prints
// the reply. The host (and therefore the socket) only exists while Firefox is
// running with the FireClerk extension loaded.

import net from "node:net";
import fs from "node:fs";
import process from "node:process";
import { createFrameReader, frame, SOCK_PATH } from "./protocol.js";

// Don't crash when a downstream pipe (e.g. `| head`) closes early.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

function request(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK_PATH);
    sock.setTimeout(35_000);
    sock.on("connect", () => sock.write(frame({ cmd, args })));
    sock.on(
      "data",
      createFrameReader((msg) => {
        sock.end();
        if (msg.ok === false) reject(new Error(msg.error || "command failed"));
        else resolve(msg.data);
      })
    );
    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error("timed out talking to the FireClerk host"));
    });
    sock.on("error", (e) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        reject(
          new Error(
            "Cannot reach the FireClerk host.\n" +
              "  • Is Firefox running?\n" +
              "  • Is the FireClerk extension loaded? (about:debugging → Load Temporary Add-on)\n" +
              "  • Did you install globally from the package and run `fireclerk --setup`?"
          )
        );
      } else {
        reject(e);
      }
    });
  });
}

// --- formatting helpers ------------------------------------------------------
function truncate(s, n) {
  s = (s ?? "").toString().replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function table(rows, columns) {
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => String(c.get(r) ?? "").length))
  );
  const line = (cells) =>
    cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(columns.map((c) => c.header))];
  out.push(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) out.push(line(columns.map((c) => c.get(r))));
  return out.join("\n");
}

const VALUE_FLAGS = new Set(["out"]); // flags that take a following value

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i]; // consume the next token as the value
      } else {
        flags[key] = true;
      }
    }
  }
  return { flags, positional };
}

// --- commands ----------------------------------------------------------------
async function cmdTabs(flags) {
  const tabs = await request("listTabs");
  if (flags.json) {
    console.log(JSON.stringify(tabs, null, 2));
    return;
  }
  if (!tabs.length) {
    console.log("(no tabs)");
    return;
  }
  console.log(
    table(tabs, [
      { header: "ID", get: (t) => t.id },
      { header: "WIN", get: (t) => t.windowId },
      { header: "CONTAINER", get: (t) => t.container },
      { header: "", get: (t) => (t.active ? "*" : "") },
      { header: "TITLE", get: (t) => truncate(t.title, 45) },
      { header: "URL", get: (t) => truncate(t.url, 60) },
    ])
  );
}

async function cmdContainers(flags) {
  const list = await request("containers");
  if (flags.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) {
    console.log("(no containers — Multi-Account Containers may be disabled)");
    return;
  }
  console.log(
    table(list, [
      { header: "COOKIE STORE", get: (c) => c.cookieStoreId },
      { header: "NAME", get: (c) => c.name },
      { header: "COLOR", get: (c) => c.color },
      { header: "ICON", get: (c) => c.icon },
    ])
  );
}

async function cmdContent(kind, positional, flags) {
  const args = {};
  if (positional[0] !== undefined) {
    const id = Number(positional[0]);
    if (!Number.isInteger(id)) throw new Error(`invalid tab id: ${positional[0]}`);
    args.tabId = id;
  }
  // No tab id => host falls back to the active tab in the current window.
  const res = await request(kind, args);
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (flags.out) {
    fs.writeFileSync(flags.out, res.content ?? "");
    console.error(`wrote ${kind} of tab ${res.tabId} (${res.title}) to ${flags.out}`);
  } else {
    process.stdout.write(res.content ?? "");
    if (process.stdout.isTTY) process.stdout.write("\n");
  }
}

const HELP = `fireclerk — talk to your running Firefox session

Usage:
  fireclerk --setup                    Install/update Firefox native messaging
  fireclerk tabs [--json]              List all tabs (id, window, container, title, url)
  fireclerk containers [--json]        List configured containers
  fireclerk html [tabId] [--out FILE]  Print outerHTML of a tab (default: active tab)
  fireclerk text [tabId] [--out FILE]  Print visible innerText of a tab
  fireclerk ping                       Check the bridge is alive

Flags:
  --json        Emit JSON instead of a table / raw content
  --out=FILE    Write content to FILE instead of stdout

The host is reached over a unix socket; it only exists while Firefox is running
with the FireClerk extension loaded. Run \`fireclerk --setup\` once after
installing the package globally, then load the extension via about:debugging.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);
  switch (cmd) {
    case "--setup":
      await import("../install.js");
      return;
    case "tabs":
      return cmdTabs(flags);
    case "containers":
      return cmdContainers(flags);
    case "html":
      return cmdContent("html", positional, flags);
    case "text":
      return cmdContent("text", positional, flags);
    case "ping": {
      const r = await request("ping");
      console.log("ok:", JSON.stringify(r));
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("error:", e.message);
  process.exitCode = 1;
});
