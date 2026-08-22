import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(root, "src", "cli.js");
const tempRoots = [];

function snapshotTree(rootPath) {
  const entries = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      entries.push(path.relative(rootPath, absolutePath));
      if (entry.isDirectory()) visit(absolutePath);
    }
  }

  visit(rootPath);
  return entries.sort();
}

function runCli(args) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fireclerk-cli-test-"));
  tempRoots.push(tempRoot);

  const home = path.join(tempRoot, "home");
  const bin = path.join(tempRoot, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);

  // If the current implementation accidentally runs setup, make it write only
  // inside this fixture rather than touching the developer's real installation.
  fs.symlinkSync(cliJs, path.join(bin, process.platform === "win32" ? "fireclerk.cmd" : "fireclerk"));

  const before = snapshotTree(tempRoot);
  const result = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: "utf8",
    timeout: 3_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: bin,
      FIRECLERK_SOCK: path.join(tempRoot, "host-that-does-not-exist.sock"),
      npm_config_global: "false",
      npm_config_location: "",
    },
  });
  const afterRun = snapshotTree(tempRoot);

  return {
    code: result.status,
    signal: result.signal,
    out: result.stdout,
    err: result.stderr,
    spawnError: result.error,
    createdPaths: afterRun.filter((entry) => !before.includes(entry)),
  };
}

after(() => {
  for (const tempRoot of tempRoots) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function assertCompleted(result) {
  assert.equal(result.signal, null, `CLI terminated with ${result.signal}`);
  assert.equal(result.spawnError, undefined);
}

function assertNoSideEffects(result) {
  assert.deepEqual(result.createdPaths, [], `created fixture paths: ${result.createdPaths.join(", ")}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const args of [["help"], ["--help"], ["-h"]]) {
  test(`root help form: fireclerk ${args.join(" ")}`, () => {
    const result = runCli(args);

    assertCompleted(result);
    assert.equal(result.code, 0);
    assert.equal(result.err, "");
    assert.match(result.out, /fireclerk — talk to your running Firefox session/);
    assert.match(result.out, /fireclerk tabs/);
    assertNoSideEffects(result);
  });
}

const commands = [
  { name: "tabs", args: ["tabs"], usage: "tabs" },
  { name: "containers", args: ["containers"], usage: "containers" },
  { name: "html", args: ["html"], usage: "html" },
  { name: "text", args: ["text"], usage: "text" },
  { name: "open", args: ["open"], usage: "open" },
  { name: "close", args: ["close"], usage: "close" },
  { name: "ping", args: ["ping"], usage: "ping" },
  { name: "setup", args: ["--setup"], usage: "--setup" },
];

for (const command of commands) {
  for (const helpFlag of ["--help", "-h"]) {
    test(`${command.name} ${helpFlag} prints command help without contacting the host`, () => {
      const result = runCli([...command.args, helpFlag]);
      const usage = escapeRegex(command.usage);

      assertCompleted(result);
      assert.equal(result.code, 0);
      assert.equal(result.err, "");
      assert.match(result.out, new RegExp(`Usage:\\s*\\n?\\s*fireclerk ${usage}(?:\\s|$)`));
      assertNoSideEffects(result);
    });
  }
}

test("an unknown option is a usage error and does not contact the host", () => {
  const result = runCli(["open", "--backgrond"]);

  assertCompleted(result);
  assert.equal(result.code, 2);
  assert.match(result.err, /unknown|unrecognized/i);
  assert.match(result.err, /--backgrond/);
  assertNoSideEffects(result);
});

const missingValueCases = [
  ["html", "--out"],
  ["text", "--out"],
  ["open", "--window"],
  ["open", "--container"],
];

for (const args of missingValueCases) {
  test(`${args.join(" ")} rejects the missing option value`, () => {
    const result = runCli(args);

    assertCompleted(result);
    assert.equal(result.code, 2);
    assert.match(result.err, new RegExp(escapeRegex(args[1])));
    assert.match(result.err, /argument|value/i);
    assertNoSideEffects(result);
  });
}

const optionScopeCases = [
  ["tabs", "--out", "page.html"],
  ["containers", "--background"],
  ["html", "--background"],
  ["text", "--window", "1"],
  ["open", "--out", "tab.json"],
  ["close", "1", "--container", "firefox-default"],
  ["ping", "--json"],
  ["--setup", "--json"],
];

for (const args of optionScopeCases) {
  const option = args.find((arg) => arg.startsWith("--") && arg !== "--setup");

  test(`${args.join(" ")} rejects an option belonging to another command`, () => {
    const result = runCli(args);

    assertCompleted(result);
    assert.equal(result.code, 2);
    assert.match(result.err, new RegExp(escapeRegex(option)));
    assertNoSideEffects(result);
  });
}

for (const command of ["html", "text"]) {
  test(`${command} rejects the incompatible --json and --out combination`, () => {
    const result = runCli([command, "--json", "--out", "page.txt"]);

    assertCompleted(result);
    assert.equal(result.code, 2);
    assert.match(result.err, /--json/);
    assert.match(result.err, /--out/);
    assertNoSideEffects(result);
  });
}

const positionalCases = [
  ["tabs", "unexpected"],
  ["containers", "unexpected"],
  ["html", "1", "2"],
  ["text", "1", "2"],
  ["open", "https://example.com", "unexpected"],
  ["close"],
  ["ping", "unexpected"],
  ["--setup", "unexpected"],
];

for (const args of positionalCases) {
  test(`${args.join(" ")} rejects invalid positional arguments`, () => {
    const result = runCli(args);

    assertCompleted(result);
    assert.equal(result.code, 2);
    assert.match(result.err, /argument|requires|usage/i);
    assertNoSideEffects(result);
  });
}
