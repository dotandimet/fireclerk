#!/usr/bin/env node
// One-time setup. Two things matter on macOS:
//
//  1. Firefox spawns the host with a minimal environment, so the launcher must
//     reference Node by absolute path (not rely on PATH).
//  2. macOS TCC blocks Firefox from executing files under protected folders
//     (~/Documents, ~/Desktop, ~/Downloads, iCloud Drive, etc). If this repo
//     lives in one of those, a launcher pointing back into it never runs and the
//     native port disconnects with NO error. Install from a released npm package
//     so the launcher points at npm's installed package copy, not a checkout.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { HOST_NAME, EXTENSION_ID } from "./src/protocol.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const home = os.homedir();

// Sanity: warn if Node itself sits in a TCC-protected place (Firefox couldn't
// exec it either). Rare, but worth flagging clearly.
const PROTECTED = ["Documents", "Desktop", "Downloads"].map((d) => path.join(home, d));
function underProtected(p) {
  return PROTECTED.some((dir) => p === dir || p.startsWith(dir + path.sep));
}

function executableName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function installedPackageBinDir() {
  const nodeModules = path.dirname(root);
  if (path.basename(root) !== "fireclerk" || path.basename(nodeModules) !== "node_modules") {
    return null;
  }

  if (process.platform === "win32") return path.dirname(nodeModules);
  const lib = path.dirname(nodeModules);
  if (path.basename(lib) !== "lib") return null;
  return path.join(path.dirname(lib), "bin");
}

// Setup must point Firefox at a stable installed package location, never a
// development checkout that may live under a macOS-protected directory.
const binDir = installedPackageBinDir();
if (!binDir) {
  throw new Error(
    "fireclerk --setup must run from an installed release package. " +
      "Install the latest release into ~/.local before running setup."
  );
}

// 1. Launcher in the same bin directory as `fireclerk`,
//    with an absolute Node path because Firefox may not provide PATH.
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(path.join(home, ".fireclerk"), { recursive: true });

const hostJs = path.join(root, "src", "host.js");
const launcher = path.join(binDir, executableName("fireclerk-host"));
const stderrLog = path.join(home, ".fireclerk", "host.stderr.log");
fs.writeFileSync(
  launcher,
  `#!/bin/sh\n` +
    `exec "${nodeBin}" "${hostJs}" "$@" 2>> "${stderrLog}"\n`
);
fs.chmodSync(launcher, 0o755);

// 2. Native-messaging host manifest, in the per-user Firefox location.
const manifestDir =
  process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts")
    : path.join(home, ".mozilla", "native-messaging-hosts");

fs.mkdirSync(manifestDir, { recursive: true });
const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      name: HOST_NAME,
      description: "FireClerk native messaging host",
      path: launcher,
      type: "stdio",
      allowed_extensions: [EXTENSION_ID],
    },
    null,
    2
  ) + "\n"
);

console.log("FireClerk setup complete using the installed release package.\n");
console.log("  package root:  ", root);
console.log("  host command:  ", launcher);
console.log("  host manifest: ", manifestPath);
if (underProtected(nodeBin) || underProtected(hostJs) || underProtected(launcher)) {
  console.log(
    "\n⚠️  The host launcher, package, or Node lives in a macOS-protected folder.\n" +
      "   Firefox may be blocked from executing it. Install the npm package from a\n" +
      "   global prefix outside ~/Documents, ~/Desktop, ~/Downloads, or iCloud Drive."
  );
}
console.log("\nInstall the signed Firefox extension once from:");
console.log("  https://github.com/dotandimet/fireclerk/releases/latest/download/fireclerk.xpi");
console.log("\nTo update FireClerk, rerun the release installer.");
console.log("After an update, restart Firefox so it launches the updated native host.");
console.log("The signed extension updates through Firefox.");
