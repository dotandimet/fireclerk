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

function loadExtension({
  tabs = [],
  onTabMessage,
  onCreateTab,
  onRemoveTabs,
  onExecuteScript,
} = {}) {
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
      async create(properties) {
        if (!onCreateTab) throw new Error("tabs.create is not configured");
        const tab = await onCreateTab(properties, tabMap);
        tabMap.set(tab.id, { ...tab });
        return { ...tab };
      },
      async remove(tabIds) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        if (onRemoveTabs) await onRemoveTabs(ids, tabMap);
        for (const tabId of ids) {
          tabMap.delete(tabId);
          onRemoved.emit(tabId, { windowId: 1, isWindowClosing: false });
        }
      },
      async executeScript(tabId, details) {
        if (!tabMap.has(tabId)) throw new Error(`Invalid tab ID: ${tabId}`);
        if (!onExecuteScript) throw new Error("tabs.executeScript is not configured");
        return onExecuteScript(tabId, details, tabMap);
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
    URL,
    TextEncoder,
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

test("query forwards structured data and returns stable tab metadata", async () => {
  const selector = "a[data-value=\"'\\\\\n\"]";
  const attribute = "data-'\\\\\n";
  const extension = loadExtension({
    tabs: [{ id: 7, status: "complete", url: "https://example.com/page" }],
    onTabMessage: async (_tabId, message) => {
      assert.equal(message.type, "fireclerk:query");
      assert.equal(message.selector, selector);
      assert.equal(message.mode, "attr");
      assert.equal(message.attribute, attribute);
      assert.equal(message.all, true);
      return { matches: ["one", null] };
    },
  });

  const response = await extension.command("queryTab", {
    tabId: 7,
    selector,
    mode: "attr",
    attribute,
    all: true,
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.tabId, 7);
  assert.equal(response.data.url, "https://example.com/page");
  assert.equal(response.data.selector, selector);
  assert.equal(response.data.mode, "attr");
  assert.deepEqual([...response.data.matches], ["one", null]);
});

test("fetch targets the selected tab and sanitizes returned metadata", async () => {
  const extension = loadExtension({
    tabs: [
      { id: 7, url: "https://example.com/work", cookieStoreId: "firefox-container-1" },
      { id: 8, url: "https://example.com/personal", cookieStoreId: "firefox-container-2" },
    ],
    onTabMessage: async (tabId, message) => {
      assert.equal(message.type, "fireclerk:fetch");
      assert.equal(message.url, "/api");
      return {
        status: 200,
        statusText: "OK",
        url: "https://example.com/api",
        contentType: "text/plain",
        headers: {
          "x-tab": String(tabId),
          Cookie: "secret",
          Authorization: "secret",
          "Set-Cookie": "secret",
        },
        bodyEncoding: "base64",
        byteLength: 2,
        body: "b2s=",
      };
    },
  });

  const work = await extension.command("fetchTab", { tabId: 7, url: "/api" });
  const personal = await extension.command("fetchTab", { tabId: 8, url: "/api" });

  for (const [response, tabId] of [[work, 7], [personal, 8]]) {
    assert.equal(response.ok, true);
    assert.equal(response.data.tabId, tabId);
    assert.equal(response.data.headers["x-tab"], String(tabId));
    assert.equal(response.data.headers.cookie, undefined);
    assert.equal(response.data.headers.authorization, undefined);
    assert.equal(response.data.headers["set-cookie"], undefined);
  }
  assert.deepEqual(extension.sentMessages.map(({ tabId }) => tabId), [7, 8]);
});

const captureArgs = {
  sourceTabId: 7,
  url: "https://example.com/target",
  wait: "complete",
  format: "html",
  timeoutMs: 100,
};

function captureSourceTab() {
  return {
    id: 7,
    windowId: 3,
    active: true,
    status: "complete",
    url: "https://example.com/source",
    cookieStoreId: "firefox-container-2",
  };
}

test("capture inherits the source container, captures, and closes only its temporary tab", async () => {
  const creates = [];
  const removals = [];
  const extension = loadExtension({
    tabs: [captureSourceTab(), { id: 8, windowId: 3, url: "https://example.com/existing" }],
    async onCreateTab(properties) {
      creates.push(properties);
      return { id: 99, ...properties, status: "complete", title: "Target" };
    },
    async onExecuteScript(tabId, _details, tabMap) {
      tabMap.get(tabId).url = "https://example.com/final";
      return ["<html><body>captured</body></html>"];
    },
    async onRemoveTabs(tabIds) {
      removals.push(...tabIds);
    },
  });

  const response = await extension.command("capturePage", captureArgs);

  assert.equal(response.ok, true);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].active, false);
  assert.equal(creates[0].windowId, 3);
  assert.equal(creates[0].cookieStoreId, "firefox-container-2");
  assert.equal(creates[0].url, captureArgs.url);
  assert.deepEqual(removals, [99]);
  assert.equal(extension.tabMap.has(7), true);
  assert.equal(extension.tabMap.has(8), true);
  assert.equal(extension.tabMap.has(99), false);
  assert.equal(response.data.sourceTabId, 7);
  assert.equal(response.data.temporaryTabId, 99);
  assert.equal(response.data.finalUrl, "https://example.com/final");
  assert.equal(response.data.containerId, "firefox-container-2");
  assert.equal(response.data.format, "html");
  assert.equal(response.data.content, "<html><body>captured</body></html>");
  assert.equal(response.data.byteLength, Buffer.byteLength(response.data.content));
  assert.equal(response.data.cleanup.closed, true);
  assert.equal(JSON.stringify(response.data).includes("cookie"), false);
});

test("capture does not create a tab when the source tab is gone or opening fails", async () => {
  let creates = 0;
  const missingSource = loadExtension({
    async onCreateTab() {
      creates++;
    },
  });
  const missingResponse = await missingSource.command("capturePage", captureArgs);
  assert.equal(missingResponse.ok, false);
  assert.match(missingResponse.error, /source tab 7/i);
  assert.equal(creates, 0);

  const openFailure = loadExtension({
    tabs: [captureSourceTab()],
    async onCreateTab() {
      creates++;
      throw new Error("open failed");
    },
  });
  const openResponse = await openFailure.command("capturePage", captureArgs);
  assert.equal(openResponse.ok, false);
  assert.match(openResponse.error, /open failed/i);
  assert.equal(creates, 1);
});

test("capture closes its temporary tab after wait and extraction failures", async () => {
  for (const failure of ["wait", "extract"]) {
    const removals = [];
    const extension = loadExtension({
      tabs: [captureSourceTab()],
      async onCreateTab(properties) {
        return {
          id: 99,
          ...properties,
          status: failure === "wait" ? "loading" : "complete",
        };
      },
      async onExecuteScript() {
        throw new Error("capture extraction failed");
      },
      async onRemoveTabs(tabIds) {
        removals.push(...tabIds);
      },
    });

    const response = await extension.command("capturePage", {
      ...captureArgs,
      timeoutMs: 20,
    });
    assert.equal(response.ok, false);
    assert.match(response.error, failure === "wait" ? /timed out/i : /extraction failed/i);
    assert.deepEqual(removals, [99]);
    assert.equal(extension.tabMap.has(99), false);
  }
});

test("capture fails if cleanup fails after an otherwise successful capture", async () => {
  const extension = loadExtension({
    tabs: [captureSourceTab()],
    async onCreateTab(properties) {
      return { id: 99, ...properties, status: "complete" };
    },
    async onExecuteScript() {
      return ["<html>captured</html>"];
    },
    async onRemoveTabs() {
      throw new Error("cleanup close failure");
    },
  });

  const response = await extension.command("capturePage", captureArgs);
  assert.equal(response.ok, false);
  assert.match(response.error, /cleanup close failure/i);
});

test("capture reports cleanup failures without hiding the primary error", async () => {
  const extension = loadExtension({
    tabs: [captureSourceTab()],
    async onCreateTab(properties) {
      return { id: 99, ...properties, status: "complete" };
    },
    async onExecuteScript() {
      throw new Error("primary capture failure");
    },
    async onRemoveTabs() {
      throw new Error("cleanup close failure");
    },
  });

  const response = await extension.command("capturePage", captureArgs);
  assert.equal(response.ok, false);
  assert.match(response.error, /primary capture failure/i);
  assert.match(response.error, /cleanup close failure/i);
});

test("capture continues after the source closes once the temporary tab exists", async () => {
  const removals = [];
  const extension = loadExtension({
    tabs: [captureSourceTab()],
    async onCreateTab(properties, tabMap) {
      tabMap.delete(7);
      return { id: 99, ...properties, status: "complete" };
    },
    async onExecuteScript() {
      return ["<html>ok</html>"];
    },
    async onRemoveTabs(tabIds) {
      removals.push(...tabIds);
    },
  });

  const response = await extension.command("capturePage", captureArgs);
  assert.equal(response.ok, true);
  assert.deepEqual(removals, [99]);
});
