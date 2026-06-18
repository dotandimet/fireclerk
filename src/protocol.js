// Shared wire framing used on BOTH hops:
//   - the native-messaging channel (host <-> Firefox over stdio)
//   - the unix socket (CLI <-> host)
//
// Frame = 4-byte unsigned length prefix in native byte order + UTF-8 JSON body.
// macOS/Linux on Intel & Apple silicon are little-endian, which is what
// Firefox's native-messaging protocol expects, so we use LE explicitly.

import os from "node:os";
import path from "node:path";

export const HOST_NAME = "com.fireclerk.host";
export const EXTENSION_ID = "fireclerk@local";

// Where the host's unix socket lives. The CLI dials this; the host serves it.
// Overridable so tests/debug hosts don't clobber the real Firefox-spawned one.
export const SOCK_PATH =
  process.env.FIRECLERK_SOCK || path.join(os.homedir(), ".fireclerk", "host.sock");

// Returns a function you feed raw chunks; it invokes onMessage(obj) per frame.
export function createFrameReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        continue; // skip a corrupt frame rather than wedge the stream
      }
      onMessage(msg);
    }
  };
}

// Serialize an object into a length-prefixed frame Buffer.
export function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
