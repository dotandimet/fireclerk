// Reproduces how Firefox launches a native-messaging host, WITHOUT involving
// the extension, so we can see why the host exits.
//
// Firefox spawns the host's `path` with:
//   - argv  = [ <absolute manifest path>, <calling extension id> ]
//   - stdio = pipes for stdin/stdout (held open by Firefox), stderr to console
//   - a normal inherited environment
//
// We mimic that, hold stdin open, and report whether the host stays alive.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const manifest = path.join(
  os.homedir(),
  "Library/Application Support/Mozilla/NativeMessagingHosts/com.fireclerk.host.json"
);
const wrapper = JSON.parse(fs.readFileSync(manifest, "utf8")).path;

const child = spawn(wrapper, [manifest, "fireclerk@local"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = Buffer.alloc(0);
let stderr = "";
child.stdout.on("data", (d) => (stdout = Buffer.concat([stdout, d])));
child.stderr.on("data", (d) => (stderr += d));
child.on("error", (e) => console.log("SPAWN ERROR:", e.message));
child.on("exit", (code, sig) =>
  console.log(`>>> host exited EARLY: code=${code} signal=${sig}`)
);

setTimeout(() => {
  const alive = child.exitCode === null && child.signalCode === null;
  console.log("alive after 1.5s? ", alive);
  console.log("stdout bytes:      ", stdout.length);
  console.log("stderr:            ", stderr.trim() || "(none)");
  child.kill();
  process.exit(0);
}, 1500);
