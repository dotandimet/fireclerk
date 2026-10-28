#!/usr/bin/env node
// FireClerk CLI. Connects to the host's unix socket, sends one command, prints
// the reply. The host (and therefore the socket) only exists while Firefox is
// running with the FireClerk extension loaded.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { request } from "./client.js";
import { htmlToMarkdown } from "./markdown.js";
import { errorCode, errorMessage } from "./errors.js";

// File/JSON boundary: do not let JSON.parse's unchecked result leak into the CLI.
function readPackageVersion() {
  /** @type {unknown} */
  const metadata = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  if (typeof metadata !== "object" || metadata === null ||
      !("version" in metadata) || typeof metadata.version !== "string") {
    throw new Error("package.json must contain a string version");
  }
  return metadata.version;
}
const CLI_VERSION = readPackageVersion();

// Don't crash when a downstream pipe (e.g. `| head`) closes early.
process.stdout.on("error", (/** @type {unknown} */ e) => {
  if (errorCode(e) === "EPIPE") process.exit(0);
  throw e;
});

// --- formatting helpers ------------------------------------------------------
/** @param {string | undefined} s @param {number} n */
function truncate(s, n) {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

/**
 * @template T
 * @param {T[]} rows
 * @param {{ header: string, get: (row: T) => string | number | undefined }[]} columns
 */
function table(rows, columns) {
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => String(c.get(r) ?? "").length))
  );
  const line = (/** @type {(string | number | undefined)[]} */ cells) =>
    cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(columns.map((c) => c.header))];
  out.push(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) out.push(line(columns.map((c) => c.get(r))));
  return out.join("\n");
}

class UsageError extends Error {}

/**
 * Parsed CLI options (strings until validateArguments checks their values).
 * @typedef {object} Flags
 * @property {boolean} [help]
 * @property {boolean} [json]
 * @property {boolean} [background]
 * @property {boolean} [private]
 * @property {boolean} [html]
 * @property {boolean} [text]
 * @property {boolean} [all]
 * @property {string} [window]
 * @property {string} [container]
 * @property {string} [out]
 * @property {string} [status]
 * @property {string} [selector]
 * @property {string} [timeout]
 * @property {string} [attr]
 * @property {string} [tab]
 * @property {string} [container-of]
 * @property {string} [wait]
 * @property {string} [format]
 */

/** @satisfies {import('node:util').ParseArgsConfig['options']} */
const HELP_OPTION = { help: { type: "boolean", short: "h" } };
/** @satisfies {import('node:util').ParseArgsConfig['options']} */
const JSON_OPTION = { json: { type: "boolean" } };
/** @satisfies {Record<string, import('node:util').ParseArgsConfig['options']>} */
const COMMAND_OPTIONS = {
  tabs: { ...HELP_OPTION, ...JSON_OPTION },
  containers: { ...HELP_OPTION, ...JSON_OPTION },
  html: { ...HELP_OPTION, ...JSON_OPTION, out: { type: "string" } },
  text: { ...HELP_OPTION, ...JSON_OPTION, out: { type: "string" } },
  markdown: { ...HELP_OPTION, ...JSON_OPTION, out: { type: "string" } },
  open: {
    ...HELP_OPTION,
    ...JSON_OPTION,
    background: { type: "boolean" },
    private: { type: "boolean" },
    window: { type: "string" },
    container: { type: "string" },
  },
  close: { ...HELP_OPTION, ...JSON_OPTION },
  ping: { ...HELP_OPTION },
  wait: {
    ...HELP_OPTION,
    ...JSON_OPTION,
    status: { type: "string" },
    selector: { type: "string" },
    timeout: { type: "string" },
  },
  query: {
    ...HELP_OPTION,
    ...JSON_OPTION,
    html: { type: "boolean" },
    text: { type: "boolean" },
    attr: { type: "string" },
    all: { type: "boolean" },
  },
  fetch: {
    ...HELP_OPTION,
    ...JSON_OPTION,
    tab: { type: "string" },
    out: { type: "string" },
  },
  capture: {
    ...HELP_OPTION,
    ...JSON_OPTION,
    "container-of": { type: "string" },
    wait: { type: "string" },
    format: { type: "string" },
    out: { type: "string" },
    timeout: { type: "string" },
  },
  setup: { ...HELP_OPTION },
};

/**
 * @param {keyof typeof COMMAND_OPTIONS} command
 * @param {string[]} args
 * @returns {{ flags: Flags, positional: string[] }}
 */
function parseCommandArgs(command, args) {
  const { values, positionals } = parseArgs({
    args,
    options: COMMAND_OPTIONS[command],
    allowPositionals: true,
    strict: true,
  });
  return { flags: /** @type {Flags} */ (values), positional: positionals };
}

/** @param {string} command @param {string[]} positional */
function validatePositionals(command, positional) {
  if (["tabs", "containers", "ping", "setup"].includes(command) && positional.length) {
    throw new UsageError(`${command} does not accept positional arguments`);
  }
  if (["html", "text", "markdown"].includes(command) && positional.length > 1) {
    throw new UsageError(`${command} accepts at most one tab id argument`);
  }
  if (command === "open" && positional.length > 1) {
    throw new UsageError("open accepts at most one URL argument");
  }
  if (command === "close" && !positional.length) {
    throw new UsageError("close requires at least one tab id argument");
  }
  if (command === "wait" && positional.length !== 1) {
    throw new UsageError("wait requires exactly one tab id argument");
  }
  if (command === "query" && positional.length !== 2) {
    throw new UsageError("query requires exactly a tab id and CSS selector argument");
  }
  if (command === "fetch" && positional.length !== 1) {
    throw new UsageError("fetch requires exactly one URL argument");
  }
  if (command === "capture" && positional.length !== 1) {
    throw new UsageError("capture requires exactly one URL argument");
  }
}

/** @param {string} command @param {string[]} positional @param {Flags} flags */
function validateArguments(command, positional, flags) {
  validatePositionals(command, positional);

  if (["html", "text", "markdown"].includes(command) && flags.json && flags.out !== undefined) {
    throw new UsageError(`${command} options --json and --out cannot be used together`);
  }

  if (["html", "text", "markdown"].includes(command) && positional[0] !== undefined) {
    if (!Number.isInteger(Number(positional[0]))) {
      throw new UsageError(`invalid tab id: ${positional[0]}`);
    }
  }
  if (command === "close") {
    const invalidId = positional.find((raw) => !Number.isInteger(Number(raw)));
    if (invalidId !== undefined) throw new UsageError(`invalid tab id: ${invalidId}`);
  }
  if (command === "open") {
    if (flags.window !== undefined && !Number.isInteger(Number(flags.window))) {
      throw new UsageError(`invalid window id: ${flags.window}`);
    }
    if (flags.private && flags.window !== undefined) {
      throw new UsageError("open options --private and --window cannot be used together");
    }
    if (flags.private && flags.container !== undefined) {
      throw new UsageError("open options --private and --container cannot be used together");
    }
  }
  if (command === "wait") {
    if (!Number.isInteger(Number(positional[0]))) {
      throw new UsageError(`invalid tab id: ${positional[0]}`);
    }
    const hasStatus = flags.status !== undefined;
    const hasSelector = flags.selector !== undefined;
    if (hasStatus === hasSelector) {
      throw new UsageError("wait requires exactly one of --status or --selector");
    }
    if (hasStatus && flags.status !== "complete") {
      throw new UsageError("wait --status currently supports only 'complete'");
    }
    if (flags.selector !== undefined && flags.selector.length === 0) {
      throw new UsageError("wait --selector requires a non-empty value");
    }
    if (flags.timeout !== undefined) {
      const timeoutMs = Number(flags.timeout);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
        throw new UsageError("wait --timeout must be an integer from 1 to 300000 ms");
      }
    }
  }
  if (command === "query") {
    if (!Number.isInteger(Number(positional[0]))) {
      throw new UsageError(`invalid tab id: ${positional[0]}`);
    }
    const modeCount =
      Number(Boolean(flags.html)) +
      Number(Boolean(flags.text)) +
      Number(flags.attr !== undefined);
    if (modeCount !== 1) {
      throw new UsageError("query requires exactly one of --html, --text, or --attr NAME");
    }
    if (flags.attr !== undefined && flags.attr.length === 0) {
      throw new UsageError("query attribute name must not be empty");
    }
  }
  if (command === "fetch") {
    if (flags.tab === undefined) throw new UsageError("fetch requires --tab TAB_ID");
    if (!Number.isInteger(Number(flags.tab))) {
      throw new UsageError(`invalid tab id: ${flags.tab}`);
    }
    if (positional[0].length === 0) throw new UsageError("fetch URL must not be empty");
  }
  if (command === "capture") {
    if (flags["container-of"] === undefined) {
      throw new UsageError("capture requires --container-of SOURCE_TAB_ID");
    }
    if (flags.wait === undefined) throw new UsageError("capture requires --wait complete");
    if (flags.format === undefined) throw new UsageError("capture requires --format html");
    if (!Number.isInteger(Number(flags["container-of"]))) {
      throw new UsageError(`invalid source tab id: ${flags["container-of"]}`);
    }
    if (flags.wait !== "complete") {
      throw new UsageError("capture --wait currently supports only 'complete'");
    }
    if (flags.format !== "html") {
      throw new UsageError("capture --format currently supports only 'html'");
    }
    if (positional[0].length === 0) throw new UsageError("capture URL must not be empty");
    if (flags.timeout !== undefined) {
      const timeoutMs = Number(flags.timeout);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
        throw new UsageError("capture --timeout must be an integer from 1 to 300000 ms");
      }
    }
  }
}

// --- commands ----------------------------------------------------------------
/** @param {boolean} json @returns {Promise<void>} */
async function cmdTabs(json) {
  const tabs = await request("listTabs", {});
  if (json) {
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
      { header: "PRIVATE", get: (t) => (t.incognito ? "yes" : "") },
      { header: "", get: (t) => (t.active ? "*" : "") },
      { header: "TITLE", get: (t) => truncate(t.title, 45) },
      { header: "URL", get: (t) => truncate(t.url, 60) },
    ])
  );
}

/** @param {boolean} json @returns {Promise<void>} */
async function cmdContainers(json) {
  const list = await request("containers", {});
  if (json) {
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

/**
 * @param {import('./contracts.js').ContentKind | 'markdown'} kind
 * @param {number | undefined} tabId
 * @param {string | undefined} outputFile
 * @param {boolean} json
 * @returns {Promise<void>}
 */
async function cmdContent(kind, tabId, outputFile, json) {
  // No tab id => extension falls back to the active tab in the current window.
  const page = await request(kind === "markdown" ? "html" : kind, { tabId });
  const res = kind === "markdown"
    ? { ...page, kind, content: await htmlToMarkdown(page.content, page.url) }
    : page;
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (outputFile) {
    fs.writeFileSync(outputFile, res.content ?? "");
    console.error(`wrote ${kind} of tab ${res.tabId} (${res.title}) to ${outputFile}`);
  } else {
    process.stdout.write(res.content ?? "");
    if (process.stdout.isTTY) process.stdout.write("\n");
  }
}

/**
 * @param {string | undefined} url
 * @param {number | undefined} windowId
 * @param {string | undefined} cookieStoreId
 * @param {boolean} isPrivate
 * @param {boolean} background
 * @param {boolean} json
 * @returns {Promise<void>}
 */
async function cmdOpen(url, windowId, cookieStoreId, isPrivate, background, json) {
  const tab = isPrivate
    ? await request("openPrivateWindow", { url, focused: !background })
    : await request("openTab", { url, active: !background, windowId, cookieStoreId });

  if (json) {
    console.log(JSON.stringify(tab, null, 2));
    return;
  }
  const kind = tab.incognito ? "private tab" : "tab";
  console.log(`opened ${kind} ${tab.id}: ${tab.url || "(new tab)"}`);
}

/** @param {number[]} tabIds @param {boolean} json @returns {Promise<void>} */
async function cmdClose(tabIds, json) {
  const res = await request("closeTabs", { tabIds });
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`closed tab${res.closed.length === 1 ? "" : "s"}: ${res.closed.join(", ")}`);
}

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const TRANSPORT_GRACE_MS = 40_000;

/**
 * @param {number} tabId
 * @param {'complete' | undefined} status
 * @param {string | undefined} selector
 * @param {number} timeoutMs
 * @param {boolean} json
 * @returns {Promise<void>}
 */
async function cmdWait(tabId, status, selector, timeoutMs, json) {
  /** @type {import('./contracts.js').WaitArgs} */
  let args;
  if (status !== undefined && selector === undefined) {
    args = { tabId, timeoutMs, status };
  } else if (selector !== undefined && status === undefined) {
    args = { tabId, timeoutMs, selector };
  } else {
    throw new UsageError("wait requires exactly one status or selector condition");
  }

  const res = await request("waitTab", args, timeoutMs + TRANSPORT_GRACE_MS);
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const condition = res.condition.status
    ? `status ${res.condition.status}`
    : `selector ${JSON.stringify(res.condition.selector)}`;
  console.log(`tab ${res.tabId} satisfied ${condition} after ${res.elapsedMs} ms`);
}

/**
 * @param {number} tabId
 * @param {string} selector
 * @param {'html' | 'text' | 'attr'} mode
 * @param {string | undefined} attribute
 * @param {boolean} all
 * @param {boolean} json
 * @returns {Promise<void>}
 */
async function cmdQuery(tabId, selector, mode, attribute, all, json) {
  /** @type {import('./contracts.js').QueryArgs} */
  let args;
  if (mode === "attr") {
    if (attribute === undefined) throw new UsageError("attribute query requires an attribute name");
    args = { tabId, selector, mode, attribute, all };
  } else {
    args = { tabId, selector, mode, all };
  }

  const res = await request("queryTab", args);
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.matches.length) return;

  const values = res.matches.map((value) => (value === null ? "null" : String(value)));
  if (all) console.log(values.join("\n"));
  else {
    process.stdout.write(values[0]);
    if (process.stdout.isTTY) process.stdout.write("\n");
  }
}

/**
 * @param {number} tabId
 * @param {string} url
 * @param {string | undefined} outputFile
 * @param {boolean} json
 * @returns {Promise<void>}
 */
async function cmdFetch(tabId, url, outputFile, json) {
  const res = await request("fetchTab", { tabId, url });
  if (res.bodyEncoding !== "base64" || typeof res.body !== "string") {
    throw new Error("invalid fetch body encoding from extension");
  }
  const body = Buffer.from(res.body, "base64");
  if (body.byteLength !== res.byteLength) {
    throw new Error(`fetch body length mismatch: expected ${res.byteLength}, received ${body.byteLength}`);
  }

  if (outputFile !== undefined) {
    fs.writeFileSync(outputFile, body);
    console.error(`wrote ${body.byteLength} bytes from ${res.url} to ${outputFile}`);
  }
  if (json) {
    const { body: encodedBody, ...metadata } = res;
    const output = outputFile !== undefined
      ? { ...metadata, outputFile }
      : { ...metadata, body: encodedBody };
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (outputFile === undefined) process.stdout.write(body);
}

/** @param {string} destination @param {string} content */
function writeFileAtomic(destination, content) {
  const absoluteDestination = path.resolve(destination);
  const directory = path.dirname(absoluteDestination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, absoluteDestination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function cmdVersion() {
  let extensionVersion = "unavailable (not connected)";
  try {
    const bridge = await request("ping", {});
    extensionVersion = bridge.extensionVersion || "unknown";
  } catch {
    // The CLI version remains useful when Firefox or the extension is offline.
  }
  console.log(`FireClerk CLI: ${CLI_VERSION}`);
  console.log(`FireClerk extension: ${extensionVersion}`);
}

/**
 * @param {string} url
 * @param {number} sourceTabId
 * @param {'complete'} wait
 * @param {'html'} format
 * @param {number} timeoutMs
 * @param {string | undefined} outputFile
 * @param {boolean} json
 * @returns {Promise<void>}
 */
async function cmdCapture(url, sourceTabId, wait, format, timeoutMs, outputFile, json) {
  const res = await request(
    "capturePage",
    { sourceTabId, url, wait, format, timeoutMs },
    timeoutMs + TRANSPORT_GRACE_MS
  );
  if (typeof res.content !== "string") throw new Error("invalid capture content from extension");
  const byteLength = Buffer.byteLength(res.content);
  if (byteLength !== res.byteLength) {
    throw new Error(`capture length mismatch: expected ${res.byteLength}, received ${byteLength}`);
  }

  if (outputFile !== undefined) {
    writeFileAtomic(outputFile, res.content);
    console.error(`wrote ${res.format} of temporary tab ${res.temporaryTabId} to ${outputFile}`);
  }
  if (json) {
    const { content, ...metadata } = res;
    const output = outputFile !== undefined
      ? { ...metadata, outputFile }
      : { ...metadata, content };
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (outputFile === undefined) process.stdout.write(res.content);
}

const HELP = `fireclerk — talk to your running Firefox session

Usage:
  fireclerk --version                  Show CLI and linked extension versions
  fireclerk --setup                    Install/update Firefox native messaging
  fireclerk tabs [--json]              List all tabs (window, container, private, URL)
  fireclerk containers [--json]        List configured containers
  fireclerk html [tabId] [--out FILE]  Print outerHTML of a tab (default: active tab)
  fireclerk text [tabId] [--out FILE]  Print visible innerText of a tab
  fireclerk markdown [tabId] [--out FILE]  Extract readable Markdown with Defuddle
  fireclerk open [url]                 Open a tab or private window
  fireclerk close <tabId...>           Close one or more tabs
  fireclerk ping                       Check the bridge is alive
  fireclerk wait <tabId> CONDITION     Wait for a load status or CSS selector
  fireclerk query <tabId> SELECTOR     Extract matching DOM content safely
  fireclerk fetch --tab ID URL         Fetch a same-origin resource in a tab
  fireclerk capture URL [options]      Capture a temporary container-aware tab

Run \`fireclerk <command> --help\` for command-specific options.

The host is reached over a unix socket; it only exists while Firefox is running
with the FireClerk extension loaded. Run \`fireclerk --setup\` once after
installing the package, then install and enable the signed Firefox extension.`;

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
  markdown: `Extract readable Markdown from a tab with Defuddle, defaulting to the active tab.

Usage:
  fireclerk markdown [tabId] [--out FILE | --json]

Options:
  --json       Emit tab metadata and Markdown content (kind: markdown) as JSON
  --out FILE   Write Markdown to FILE instead of stdout
  -h, --help   Show this help

Converts live page HTML locally, removing clutter. Does not re-fetch the page
or use third-party extraction services. Use html for the unmodified DOM.`,
  open: `Open a Firefox tab.

Usage:
  fireclerk open [url] [options]

Options:
  --json             Emit the opened tab as JSON
  --background       Do not focus the new tab or window
  --private          Open a new private window
  --window ID        Open in a specific Firefox window
  --container STORE  Open in a cookieStoreId/container
  -h, --help         Show this help

Private windows require FireClerk's “Run in Private Windows” permission. Enable
it from about:addons → FireClerk. --private cannot be combined with --window or
--container.`,
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
  wait: `Wait for a Firefox tab condition.

Usage:
  fireclerk wait <tabId> (--status complete | --selector SELECTOR) [options]

Options:
  --status complete    Wait for the tab load status
  --selector SELECTOR  Wait for a top-level CSS selector
  --timeout MS         Timeout in milliseconds (default: 10000; max: 300000)
  --json               Emit the result as JSON
  -h, --help           Show this help`,
  query: `Extract matching content from a tab's top-level document.

Usage:
  fireclerk query <tabId> <selector> (--html | --text | --attr NAME) [options]

Options:
  --html       Return each matched element's outerHTML
  --text       Return each matched node's textContent
  --attr NAME  Return an attribute value (null when missing)
  --all        Return every match in document order (default: first only)
  --json       Emit metadata and a matches array as JSON
  -h, --help   Show this help`,
  fetch: `Fetch a same-origin resource using a tab's Firefox context.

Usage:
  fireclerk fetch --tab <tabId> <url> [options]

Options:
  --tab ID     Select the source tab and container context (required)
  --out FILE   Write decoded response bytes to FILE
  --json       Emit response metadata and base64 body as JSON
  -h, --help   Show this help

Only GET requests are supported. Redirects are not followed. Responses are
limited to 10 MiB. With --out --json, JSON contains outputFile instead of body.`,
  capture: `Capture a URL in a temporary tab using a source tab's container.

Usage:
  fireclerk capture <url> --container-of <tabId> --wait complete --format html [options]

Options:
  --container-of ID  Inherit this tab's container and window (required)
  --wait complete    Wait for full page load (required)
  --format html      Capture outerHTML (required)
  --timeout MS       Timeout in milliseconds (default: 10000; max: 300000)
  --out FILE         Atomically replace FILE with the captured HTML
  --json             Emit capture and cleanup metadata as JSON
  -h, --help         Show this help`,
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
  if (rawCommand === "--version") {
    if (rest.length) throw new UsageError("--version does not accept arguments");
    return cmdVersion();
  }

  const command = /** @type {keyof typeof COMMAND_OPTIONS} */ (
    rawCommand === "--setup" ? "setup" : rawCommand
  );
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

  // Keep raw parser values here; command functions receive domain values only.
  const json = Boolean(flags.json);
  const outputFile = flags.out;
  const timeoutMs = flags.timeout === undefined ? DEFAULT_WAIT_TIMEOUT_MS : Number(flags.timeout);

  switch (command) {
    case "setup":
      await import("../install.js");
      return;
    case "tabs":
      return cmdTabs(json);
    case "containers":
      return cmdContainers(json);
    case "html":
    case "text":
    case "markdown": {
      const tabId = positional[0] === undefined ? undefined : Number(positional[0]);
      return cmdContent(command, tabId, outputFile, json);
    }
    case "open": {
      const url = positional[0] || undefined;
      const windowId = flags.window === undefined ? undefined : Number(flags.window);
      const cookieStoreId = flags.container || undefined;
      const isPrivate = Boolean(flags.private);
      const background = Boolean(flags.background);
      return cmdOpen(url, windowId, cookieStoreId, isPrivate, background, json);
    }
    case "close": {
      const tabIds = positional.map(Number);
      return cmdClose(tabIds, json);
    }
    case "ping": {
      const r = await request("ping", {});
      console.log("ok:", JSON.stringify(r));
      return;
    }
    case "wait": {
      const tabId = Number(positional[0]);
      const status = flags.status === "complete" ? flags.status : undefined;
      const selector = flags.selector;
      return cmdWait(tabId, status, selector, timeoutMs, json);
    }
    case "query": {
      const tabId = Number(positional[0]);
      const selector = positional[1];
      const mode = flags.html ? "html" : flags.text ? "text" : "attr";
      const attribute = flags.attr;
      const all = Boolean(flags.all);
      return cmdQuery(tabId, selector, mode, attribute, all, json);
    }
    case "fetch": {
      const tabId = Number(flags.tab);
      const url = positional[0];
      return cmdFetch(tabId, url, outputFile, json);
    }
    case "capture": {
      const url = positional[0];
      const sourceTabId = Number(flags["container-of"]);
      // validateArguments permits only these wait/format values.
      return cmdCapture(url, sourceTabId, "complete", "html", timeoutMs, outputFile, json);
    }
  }
}

main().catch((/** @type {unknown} */ e) => {
  console.error("error:", errorMessage(e));
  process.exitCode = e instanceof UsageError || errorCode(e)?.startsWith("ERR_PARSE_ARGS_") ? 2 : 1;
});
