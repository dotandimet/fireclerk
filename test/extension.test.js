import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backgroundSource = fs.readFileSync(path.join(root, "extension", "background.js"), "utf8");

function extensionEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}

function loadExtension({ tabs = [], onTabMessage } = {}) {
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const onUpdated = extensionEvent();
  const onRemoved = extensionEvent();
  const posted = [];
  const sentMessages = [];
  let nativeMessageListener;

  const port = {
    error: null,
    onMessage: {
      addListener(listener) {
        nativeMessageListener = listener;
      },
    },
    onDisconnect: extensionEvent(),
    postMessage(message) {
      posted.push(message);
    },
  };

  const browser = {
    runtime: {
      connectNative() {
        return port;
      },
    },
    tabs: {
      onUpdated,
      onRemoved,
      async get(tabId) {
        const tab = tabMap.get(tabId);
        if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
        return { ...tab };
      },
      async query() {
        return [...tabMap.values()].map((tab) => ({ ...tab }));
      },
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
        if (!tabMap.has(tabId)) throw new Error(`Invalid tab ID: ${tabId}`);
        if (!onTabMessage) throw new Error("Receiving end does not exist");
        return onTabMessage(tabId, message);
      },
    },
    contextualIdentities: {
      async query() {
        return [];
      },
    },
  };

  vm.runInNewContext(backgroundSource, {
    browser,
    console: { info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  });

  let sequence = 0;
  async function command(cmd, args = {}) {
    const id = ++sequence;
    await nativeMessageListener({ id, cmd, args });
    const response = posted.find((message) => message.id === id);
    assert.ok(response, `extension did not reply to ${cmd}`);
    return response;
  }

  return {
    command,
    tabMap,
    onUpdated,
    onRemoved,
    sentMessages,
  };
}

test("wait returns immediately when the tab already has the requested status", async () => {
  const extension = loadExtension({
    tabs: [{ id: 7, status: "complete", url: "https://example.com" }],
  });

  const response = await extension.command("waitTab", {
    tabId: 7,
    status: "complete",
    timeoutMs: 100,
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.tabId, 7);
  assert.equal(response.data.condition.status, "complete");
  assert.ok(response.data.elapsedMs < 100);
  assert.equal(extension.onUpdated.size, 0);
  assert.equal(extension.onRemoved.size, 0);
});

test("wait resolves a delayed status and removes all listeners", async () => {
  const extension = loadExtension({
    tabs: [{ id: 7, status: "loading", url: "https://example.com" }],
  });

  const waiting = extension.command("waitTab", {
    tabId: 7,
    status: "complete",
    timeoutMs: 500,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const tab = extension.tabMap.get(7);
  tab.status = "complete";
  extension.onUpdated.emit(7, { status: "complete" }, { ...tab });

  const response = await waiting;
  assert.equal(response.ok, true);
  assert.equal(response.data.condition.status, "complete");
  assert.equal(extension.onUpdated.size, 0);
  assert.equal(extension.onRemoved.size, 0);
});

test("wait fails promptly if the target tab closes and removes listeners", async () => {
  const extension = loadExtension({
    tabs: [{ id: 7, status: "loading", url: "https://example.com" }],
  });

  const waiting = extension.command("waitTab", {
    tabId: 7,
    status: "complete",
    timeoutMs: 500,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  extension.tabMap.delete(7);
  extension.onRemoved.emit(7, { windowId: 1, isWindowClosing: false });

  const response = await waiting;
  assert.equal(response.ok, false);
  assert.match(response.error, /tab 7.*closed/i);
  assert.equal(extension.onUpdated.size, 0);
  assert.equal(extension.onRemoved.size, 0);
});

test("wait reports its domain timeout before a transport timeout and cleans up", async () => {
  const extension = loadExtension({
    tabs: [{ id: 7, status: "loading", url: "https://example.com" }],
  });

  const response = await extension.command("waitTab", {
    tabId: 7,
    status: "complete",
    timeoutMs: 20,
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /timed out.*tab 7.*20 ms/i);
  assert.equal(extension.onUpdated.size, 0);
  assert.equal(extension.onRemoved.size, 0);
});

test("selector waiting passes hostile selector text strictly as message data", async () => {
  const selector = "article[data-value=\"'\\\\\n) => pageFunction()\"]";
  const extension = loadExtension({
    tabs: [{ id: 7, status: "complete", url: "https://example.com" }],
    onTabMessage: async (_tabId, message) => {
      assert.equal(message.selector, selector);
      return { matched: true };
    },
  });

  const response = await extension.command("waitTab", {
    tabId: 7,
    selector,
    timeoutMs: 100,
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.condition.selector, selector);
  assert.equal(extension.sentMessages.length, 1);
  assert.equal(extension.sentMessages[0].message.selector, selector);
});

test("selector waiting retries until a match appears", async () => {
  let checks = 0;
  const extension = loadExtension({
    tabs: [{ id: 7, status: "complete", url: "https://example.com" }],
    onTabMessage: async () => ({ matched: ++checks >= 2 }),
  });

  const response = await extension.command("waitTab", {
    tabId: 7,
    selector: "article",
    timeoutMs: 500,
  });

  assert.equal(response.ok, true);
  assert.ok(checks >= 2);
  assert.equal(extension.onRemoved.size, 0);
});

test("selector waiting reports invalid selectors", async () => {
  const extension = loadExtension({
    tabs: [{ id: 7, status: "complete", url: "https://example.com" }],
    onTabMessage: async () => {
      throw new Error("invalid selector: SyntaxError");
    },
  });

  const response = await extension.command("waitTab", {
    tabId: 7,
    selector: "[",
    timeoutMs: 100,
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /invalid selector/i);
  assert.equal(extension.onRemoved.size, 0);
});
