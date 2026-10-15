// Typed CLI -> host boundary. JSON decoding is trusted here; the shared
// contracts are compile-time checks, not validation of arbitrary socket peers.
import net from "node:net";
import { createFrameReader, frame, SOCK_PATH } from "./protocol.js";

/**
 * @template {import('./contracts.js').Command} K
 * @param {K} cmd
 * @param {import('./contracts.js').CommandArgs<K>} args
 * @param {number} [timeoutMs]
 * @returns {Promise<import('./contracts.js').CommandResult<K>>}
 */
export function request(cmd, args, timeoutMs = 35_000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK_PATH);
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => sock.write(frame({ cmd, args })));
    sock.on(
      "data",
      createFrameReader((message) => {
        const msg = /** @type {import('./contracts.js').Reply<import('./contracts.js').CommandResult<K>>} */ (message);
        sock.end();
        if (msg.ok === false) reject(new Error(msg.error || "command failed"));
        else resolve(msg.data);
      })
    );
    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error("timed out talking to the FireClerk host"));
    });
    sock.on("error", (/** @type {NodeJS.ErrnoException} */ e) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        reject(
          new Error(
            "Cannot reach the FireClerk host.\n" +
              "  • Is Firefox running?\n" +
              "  • Is the signed FireClerk extension installed and enabled? (about:addons)\n" +
              "  • Did you install globally from the package and run `fireclerk --setup`?"
          )
        );
      } else {
        reject(e);
      }
    });
  });
}
