#!/usr/bin/env node
// FireClerk CLI. Connects to the host's unix socket, sends one command, prints
// the reply. The host (and therefore the socket) only exists while Firefox is
// running with the FireClerk extension loaded.

import net from "node:net";
import fs from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
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

class UsageError extends Error {}

const HELP_OPTION = { help: { type: "boolean", short: "h" } };
const JSON_OPTION = { json: { type: "boolean" } };
const COMMAND_OPTIONS = {
  tabs: { ...HELP_OPTION, ...JSON_OPTION },
  containers: { ...HELP_OPTION, ...JSON_OPTION },
  html: { ...HELP_OPTION, ...JSON_OPTION, out: { type: "string" } },
  text: { ...HELP_OPTION, ...JSON_OPTION, out: { type: "string" } },
  open: {
    ...HELP_OPTION,
    ...JSON_OPTION,
    background: { type: "boolean" },
    window: { type: "string" },
    container: { type: "string" },
  },
  close: { ...HELP_OPTION, ...JSON_OPTION },
  ping: { ...HELP_OPTION },
  setup: { ...HELP_OPTION },
};

function parseCommandArgs(command, args) {
  const { values, positionals } = parseArgs({
    args,
    options: COMMAND_OPTIONS[command],
    allowPositionals: true,
    strict: true,
  });
  return { flags: values, positional: positionals };
}

function validatePositionals(command, positional) {
  if (["tabs", "containers", "ping", "setup"].includes(command) && positional.length) {
    throw new UsageError(`${command} does not accept positional arguments`);
  }
  if (["html", "text"].includes(command) && positional.length > 1) {
    throw new UsageError(`${command} accepts at most one tab id argument`);
  }
  if (command === "open" && positional.length > 1) {
    throw new UsageError("open accepts at most one URL argument");
  }
  if (command === "close" && !positional.length) {
    throw new UsageError("close requires at least one tab id argument");
  }
}

function validateArguments(command, positional, flags) {
  validatePositionals(command, positional);

  if (["html", "text"].includes(command) && flags.json && flags.out !== undefined) {
    throw new UsageError(`${command} options --json and --out cannot be used together`);
  }

  if (["html", "text"].includes(command) && positional[0] !== undefined) {
    if (!Number.isInteger(Number(positional[0]))) {
      throw new UsageError(`invalid tab id: ${positional[0]}`);
    }
  }
  if (command === "close") {
    const invalidId = positional.find((raw) => !Number.isInteger(Number(raw)));
    if (invalidId !== undefined) throw new UsageError(`invalid tab id: ${invalidId}`);
  }
  if (command === "open" && flags.window !== undefined) {
    if (!Number.isInteger(Number(flags.window))) {
      throw new UsageError(`invalid window id: ${flags.window}`);
    }
  }
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
  if (positional[0] !== undefined) args.tabId = Number(positional[0]);
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

async function cmdOpen(positional, flags) {
  const args = { active: !flags.background };
  if (positional[0]) args.url = positional[0];
  if (flags.window !== undefined) args.windowId = Number(flags.window);
  if (flags.container) args.cookieStoreId = flags.container;

  const tab = await request("openTab", args);
  if (flags.json) {
    console.log(JSON.stringify(tab, null, 2));
    return;
  }
  console.log(`opened tab ${tab.id}: ${tab.url || "(new tab)"}`);
}

async function cmdClose(positional, flags) {
  const tabIds = positional.map(Number);

  const res = await request("closeTabs", { tabIds });
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`closed tab${res.closed.length === 1 ? "" : "s"}: ${res.closed.join(", ")}`);
}

const HELP = `fireclerk — talk to your running Firefox session

Usage:
  fireclerk --setup                    Install/update Firefox native messaging
  fireclerk tabs [--json]              List all tabs (id, window, container, title, url)
  fireclerk containers [--json]        List configured containers
  fireclerk html [tabId] [--out FILE]  Print outerHTML of a tab (default: active tab)
  fireclerk text [tabId] [--out FILE]  Print visible innerText of a tab
  fireclerk open [url]                 Open a new tab (default: browser new tab)
  fireclerk close <tabId...>           Close one or more tabs
  fireclerk ping                       Check the bridge is alive

Run \`fireclerk <command> --help\` for command-specific options.

The host is reached over a unix socket; it only exists while Firefox is running
with the FireClerk extension loaded. Run \`fireclerk --setup\` once after
installing the package globally, then load the extension via about:debugging.`;

const COMMAND_HELP = {
  tabs: `List Firefox tabs.

Usage:
  fireclerk tabs [--json]

Options:
  --json       Emit JSON instead of a table
  -h, --help   Show this help`,
  containers: `List configured Firefox containers.

Usage:
  fireclerk containers [--json]

Options:
  --json       Emit JSON instead of a table
  -h, --help   Show this help`,
  html: `Print the outerHTML of a tab, defaulting to the active tab.

Usage:
  fireclerk html [tabId] [--out FILE | --json]

Options:
  --json       Emit the complete response as JSON
  --out FILE   Write HTML to FILE instead of stdout
  -h, --help   Show this help`,
  text: `Print the visible text of a tab, defaulting to the active tab.

Usage:
  fireclerk text [tabId] [--out FILE | --json]

Options:
  --json       Emit the complete response as JSON
  --out FILE   Write text to FILE instead of stdout
  -h, --help   Show this help`,
  open: `Open a Firefox tab.

Usage:
  fireclerk open [url] [options]

Options:
  --json             Emit the opened tab as JSON
  --background       Do not activate the new tab
  --window ID        Open in a specific Firefox window
  --container STORE  Open in a cookieStoreId/container
  -h, --help         Show this help`,
  close: `Close one or more Firefox tabs.

Usage:
  fireclerk close <tabId...> [--json]

Options:
  --json       Emit the result as JSON
  -h, --help   Show this help`,
  ping: `Check that the FireClerk bridge is alive.

Usage:
  fireclerk ping

Options:
  -h, --help   Show this help`,
  setup: `Install or update Firefox native messaging.

Usage:
  fireclerk --setup

Options:
  -h, --help   Show this help`,
};

async function main() {
  const [rawCommand, ...rest] = process.argv.slice(2);
  if ([undefined, "help", "--help", "-h"].includes(rawCommand)) {
    console.log(HELP);
    return;
  }

  const command = rawCommand === "--setup" ? "setup" : rawCommand;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    console.error(`unknown command: ${rawCommand}\n`);
    console.log(HELP);
    process.exitCode = 2;
    return;
  }

  const { flags, positional } = parseCommandArgs(command, rest);
  if (flags.help) {
    console.log(COMMAND_HELP[command]);
    return;
  }

  validateArguments(command, positional, flags);

  switch (command) {
    case "setup":
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
    case "open":
      return cmdOpen(positional, flags);
    case "close":
      return cmdClose(positional, flags);
    case "ping": {
      const r = await request("ping");
      console.log("ok:", JSON.stringify(r));
      return;
    }
  }
}

main().catch((e) => {
  console.error("error:", e.message);
  process.exitCode = e instanceof UsageError || e.code?.startsWith("ERR_PARSE_ARGS_") ? 2 : 1;
});
