#!/usr/bin/env node
// One-time setup. Two things matter on macOS:
//
//  1. Firefox spawns the host with a minimal environment, so the launcher must
//     reference Node by absolute path (not rely on PATH).
//  2. macOS TCC blocks Firefox from executing files under protected folders
//     (~/Documents, ~/Desktop, ~/Downloads, iCloud Drive, etc). If this repo
//     lives in one of those, a launcher pointing back into it never runs and the
//     native port disconnects with NO error. Install from the built npm package
//     so the launcher points at npm's installed package copy, not this checkout.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { HOST_NAME, EXTENSION_ID } from "./src/protocol.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const home = os.homedir();
const isGlobalNpmInstall =
  process.env.npm_config_global === "true" || process.env.npm_config_location === "global";

// Sanity: warn if Node itself sits in a TCC-protected place (Firefox couldn't
// exec it either). Rare, but worth flagging clearly.
const PROTECTED = ["Documents", "Desktop", "Downloads"].map((d) => path.join(home, d));
function underProtected(p) {
  return PROTECTED.some((dir) => p === dir || p.startsWith(dir + path.sep));
}

function executableName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function findLinkedBinDir() {
  const cliScript = path.join(root, "src", "cli.js");
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, executableName("fireclerk"));
    try {
      if (fs.realpathSync(candidate) === cliScript) return dir;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function installedPackageBinDir() {
  const nodeModules = path.dirname(root);
  const lib = path.dirname(nodeModules);
  const prefix = path.dirname(lib);
  if (path.basename(root) === "fireclerk" && path.basename(nodeModules) === "node_modules") {
    if (process.platform === "win32") return prefix;
    if (path.basename(lib) === "lib") return path.join(prefix, "bin");
  }
  return null;
}

function npmBinDir() {
  if (isGlobalNpmInstall && process.env.npm_config_prefix) {
    return process.platform === "win32"
      ? process.env.npm_config_prefix
      : path.join(process.env.npm_config_prefix, "bin");
  }
  const installed = installedPackageBinDir();
  if (installed) return installed;
  const linked = findLinkedBinDir();
  if (linked) return linked;

  // Development fallback for `npm run setup`; ignored by git.
  return path.join(root, "bin");
}

// 1. Launcher in the same bin directory as `fireclerk`,
//    with an absolute Node path because Firefox may not provide PATH.
const binDir = npmBinDir();
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

console.log("FireClerk setup complete.\n");
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
console.log("\nThe `fireclerk` command is provided by the npm install.");
console.log("\nNow load (or reload) the extension in Firefox:");
console.log("  1. Open  about:debugging#/runtime/this-firefox");
console.log("  2. 'Load Temporary Add-on…' →", path.join(root, "extension", "manifest.json"));
console.log("\nAfter changing the host (src/host.js, src/protocol.js): reinstall");
console.log("(`npm run build && npm install -g ./dist/fireclerk-*.tgz`).");
