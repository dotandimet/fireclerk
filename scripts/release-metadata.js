#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [, , version, xpiName] = process.argv;

if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: node scripts/release-metadata.js VERSION [SIGNED_XPI_NAME]");
  process.exit(2);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), JSON.stringify(value, null, 2) + "\n");
}

const packageJson = readJson("package.json");
if (packageJson.version !== version) {
  throw new Error(`package.json is ${packageJson.version}, expected ${version}`);
}

const extensionPath = path.join(root, "extension/manifest.json");
const extensionSource = fs.readFileSync(extensionPath, "utf8");
const extensionManifest = JSON.parse(extensionSource);
const currentVersionField = `"version": "${extensionManifest.version}"`;
if (extensionSource.split(currentVersionField).length !== 2) {
  throw new Error("could not identify the extension manifest version field uniquely");
}
fs.writeFileSync(extensionPath, extensionSource.replace(currentVersionField, `"version": "${version}"`));

if (xpiName) {
  if (path.basename(xpiName) !== xpiName || !xpiName.endsWith(".xpi")) {
    throw new Error(`invalid signed XPI filename: ${xpiName}`);
  }

  const extensionId = extensionManifest.browser_specific_settings.gecko.id;
  const updates = readJson("updates.json");
  const addon = updates.addons && updates.addons[extensionId];
  if (!addon || !Array.isArray(addon.updates)) {
    throw new Error(`updates.json has no update list for ${extensionId}`);
  }

  const repository = process.env.GITHUB_REPOSITORY || "dotandimet/fireclerk";
  const update = {
    version,
    update_link: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(xpiName)}`,
  };
  addon.updates = addon.updates.filter((entry) => entry.version !== version);
  addon.updates.push(update);
  writeJson("updates.json", updates);
}
