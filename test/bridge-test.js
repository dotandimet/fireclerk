// End-to-end bridge test that stands in for Firefox.
//
// Spawns the real host, talks the native-messaging protocol to it on stdio
// (pretending to be the extension), then runs the real CLI against the unix
// socket. Exercises: socket framing, id correlation, large payloads, errors.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";
import { createFrameReader, frame } from "../src/protocol.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hostJs = path.join(root, "src", "host.js");
const cliJs = path.join(root, "src", "cli.js");

// Use a dedicated socket so the test never touches the real Firefox host's.
const TEST_ENV = {
  ...process.env,
  FIRECLERK_SOCK: path.join(os.tmpdir(), "fireclerk-test.sock"),
};

// A fat HTML payload to prove >1MB content survives the extension->host hop.
const BIG_HTML = "<html><body>" + "x".repeat(2_000_000) + "</body></html>";

const FAKE_TABS = [
  { id: 1, windowId: 1, index: 0, active: true, title: "Example", url: "https://example.com", cookieStoreId: "firefox-default", container: "default" },
  { id: 7, windowId: 1, index: 1, active: false, title: "Work mail", url: "https://mail.example.com", cookieStoreId: "firefox-container-2", container: "Work" },
];

function startFakeFirefox() {
  const host = spawn(process.execPath, [hostJs], {
    stdio: ["pipe", "pipe", "inherit"],
    env: TEST_ENV,
  });
  // Act as the extension: read commands from host stdout, reply on host stdin.
  host.stdout.on(
    "data",
    createFrameReader((req) => {
      if (req.event) return; // ignore host-originated events (e.g. hello)
      const { id, cmd, args } = req;
      let reply;
      if (cmd === "ping") reply = { ok: true, data: { pong: true } };
      else if (cmd === "listTabs") reply = { ok: true, data: FAKE_TABS };
      else if (cmd === "html") reply = { ok: true, data: { tabId: args.tabId ?? 1, url: "https://example.com", title: "Example", kind: "html", content: BIG_HTML } };
      else if (cmd === "boom") reply = { ok: false, error: "kaboom" };
      else reply = { ok: false, error: "unknown command: " + cmd };
      host.stdin.write(frame({ id, ...reply }));
    })
  );
  return host;
}

function runCli(args) {
  return new Promise((resolve) => {
    const cli = spawn(process.execPath, [cliJs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: TEST_ENV,
    });
    let out = "", err = "";
    cli.stdout.on("data", (d) => (out += d));
    cli.stderr.on("data", (d) => (err += d));
    cli.on("close", (code) => resolve({ code, out, err }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const host = startFakeFirefox();
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ✓", name);
  } catch (e) {
    failures++;
    console.log("  ✗", name, "—", e.message);
  }
}

try {
  await sleep(400); // let the host bind its socket

  const ping = await runCli(["ping"]);
  check("ping returns ok", () => assert.match(ping.out, /pong/));

  const tabsJson = await runCli(["tabs", "--json"]);
  check("tabs --json lists both tabs", () => {
    const parsed = JSON.parse(tabsJson.out);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1].container, "Work");
  });

  const tabsTable = await runCli(["tabs"]);
  check("tabs table marks active tab and shows container", () => {
    assert.match(tabsTable.out, /CONTAINER/);
    assert.match(tabsTable.out, /Work/);
    assert.match(tabsTable.out, /\*/);
  });

  const html = await runCli(["html", "1"]);
  check("html returns full >1MB payload intact", () => {
    assert.equal(html.code, 0);
    assert.ok(html.out.length >= BIG_HTML.length);
    assert.match(html.out, /<html><body>x{100}/);
  });

  // `text` is a real CLI command, but the fake extension doesn't handle it,
  // so it replies with an error — exercising the real ok:false path.
  const boom = await runCli(["text", "1"]);
  check("error replies propagate to exit code + stderr", () => {
    assert.notEqual(boom.code, 0);
    assert.match(boom.err, /unknown command: text/);
  });
} finally {
  host.kill();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
