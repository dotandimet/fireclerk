import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempRoots = [];

function tempRoot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fireclerk-install-test-"));
  tempRoots.push(directory);
  return directory;
}

after(() => {
  for (const directory of tempRoots) fs.rmSync(directory, { recursive: true, force: true });
});

function copyPackage(destination) {
  fs.mkdirSync(path.join(destination, "src"), { recursive: true });
  for (const relativePath of ["install.js", "src/cli.js", "src/host.js", "src/protocol.js"]) {
    fs.copyFileSync(path.join(root, relativePath), path.join(destination, relativePath));
  }
}

function manifestPath(home) {
  return process.platform === "darwin"
    ? path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts/com.fireclerk.host.json")
    : path.join(home, ".mozilla/native-messaging-hosts/com.fireclerk.host.json");
}

test("fireclerk --setup configures only an installed package under its npm prefix", () => {
  const fixture = tempRoot();
  const home = path.join(fixture, "home");
  const prefix = path.join(fixture, ".local");
  const packageRoot = path.join(prefix, "lib", "node_modules", "fireclerk");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  copyPackage(packageRoot);

  const result = spawnSync(process.execPath, [path.join(packageRoot, "src/cli.js"), "--setup"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${path.join(prefix, "bin")}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr);
  const launcher = path.join(prefix, "bin", "fireclerk-host");
  assert.equal(fs.existsSync(launcher), true);
  assert.match(fs.readFileSync(launcher, "utf8"), new RegExp(path.join(packageRoot, "src/host.js")));

  const manifest = JSON.parse(fs.readFileSync(manifestPath(home), "utf8"));
  assert.equal(manifest.path, launcher);
  assert.equal(manifest.allowed_extensions[0], "fireclerk@local");
  assert.match(result.stdout, /installed release package/i);
  assert.doesNotMatch(result.stdout, /Load Temporary Add-on/i);
});

test("fireclerk --setup refuses a development checkout without changing Firefox configuration", () => {
  const fixture = tempRoot();
  const home = path.join(fixture, "home");
  const checkout = path.join(fixture, "checkout");
  fs.mkdirSync(home);
  copyPackage(checkout);

  const result = spawnSync(process.execPath, [path.join(checkout, "src/cli.js"), "--setup"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: process.env.PATH },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed release package/i);
  assert.equal(fs.existsSync(manifestPath(home)), false);
  assert.equal(fs.existsSync(path.join(checkout, "bin", "fireclerk-host")), false);
});

test("the release installer installs into ~/.local and runs setup", () => {
  const fixture = tempRoot();
  const home = path.join(fixture, "home");
  const prefix = path.join(home, ".local");
  const fakeBin = path.join(fixture, "fake-bin");
  const log = path.join(fixture, "commands.log");
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);
  fs.symlinkSync(process.execPath, path.join(fakeBin, "node"));
  fs.writeFileSync(
    path.join(fakeBin, "npm"),
    `#!/bin/sh\n` +
      `printf 'npm:%s\\n' "$*" >> "$FIRECLERK_TEST_LOG"\n` +
      `mkdir -p "$FIRECLERK_PREFIX/bin"\n` +
      `cat > "$FIRECLERK_PREFIX/bin/fireclerk" <<'SCRIPT'\n` +
      `#!/bin/sh\n` +
      `printf 'fireclerk:%s\\n' "$*" >> "$FIRECLERK_TEST_LOG"\n` +
      `SCRIPT\n` +
      `chmod +x "$FIRECLERK_PREFIX/bin/fireclerk"\n`
  );
  fs.chmodSync(path.join(fakeBin, "npm"), 0o755);

  const result = spawnSync("/bin/sh", [path.join(root, "install-fireclerk.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: fakeBin,
      FIRECLERK_PREFIX: prefix,
      FIRECLERK_PACKAGE_URL: "https://example.invalid/fireclerk.tgz",
      FIRECLERK_TEST_LOG: log,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const commands = fs.readFileSync(log, "utf8");
  assert.match(commands, /npm:install --global --prefix .* https:\/\/example\.invalid\/fireclerk\.tgz/);
  assert.match(commands, /fireclerk:--setup/);
  assert.match(result.stdout, /\.local\/bin/);
  assert.match(result.stdout, /installed/i);
});
