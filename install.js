#!/usr/bin/env node
// One-time setup. Two things matter on macOS:
//
//  1. Firefox spawns the host with a minimal environment, so the launcher must
//     reference Node by absolute path (not rely on PATH).
//  2. macOS TCC blocks Firefox from executing files under protected folders
//     (~/Documents, ~/Desktop, ~/Downloads, iCloud Drive, etc). If this repo
//     lives in one of those, a launcher pointing back into it never runs and
//     the native port disconnects with NO error. So we install a self-contained
//     copy of the host (host.js + protocol.js + launcher) into ~/.fireclerk/host,
//     which is not TCC-protected, and point the manifest there.

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

// 1. Self-contained host runtime outside any protected folder.
//    ~/.local is known-good here: Node itself runs from ~/.local/share/mise.
const installDir = path.join(home, ".local", "share", "fireclerk");
fs.mkdirSync(installDir, { recursive: true });
for (const f of ["host.js", "protocol.js"]) {
  fs.copyFileSync(path.join(root, "src", f), path.join(installDir, f));
}

// 2. Launcher next to the copied host, with absolute Node path.
const launcher = path.join(installDir, "fireclerk-host");
const stderrLog = path.join(home, ".fireclerk", "host.stderr.log");
fs.writeFileSync(
  launcher,
  `#!/bin/sh\n` +
    `exec "${nodeBin}" "${path.join(installDir, "host.js")}" "$@" 2>> "${stderrLog}"\n`
);
fs.chmodSync(launcher, 0o755);

// 3. Native-messaging host manifest, in the per-user Firefox location.
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
console.log("  host runtime:  ", installDir, "(self-contained, TCC-safe)");
console.log("  launcher:      ", launcher);
console.log("  host manifest: ", manifestPath);
if (underProtected(nodeBin)) {
  console.log(
    "\n⚠️  Node lives in a macOS-protected folder:\n     " +
      nodeBin +
      "\n   Firefox may be blocked from executing it. Consider a Node install under ~/.local or /usr/local."
  );
}
console.log("\nThe `fireclerk` command is provided by the npm install.");
console.log("\nNow load (or reload) the extension in Firefox:");
console.log("  1. Open  about:debugging#/runtime/this-firefox");
console.log("  2. 'Load Temporary Add-on…' →", path.join(root, "extension", "manifest.json"));
console.log("\nAfter changing the host (src/host.js, src/protocol.js): reinstall");
console.log("(`npm install -g .`) then re-run `fireclerk-setup` — the host is a copy.");
