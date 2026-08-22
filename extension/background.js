// FireClerk bridge background script.
//
// Holds a persistent native-messaging port to the host. Each inbound message
// is a command {id, cmd, args}; we run it and post {id, ok, data|error} back.
// If the host dies (e.g. it wasn't installed yet), the port disconnects and we
// retry shortly — so loading the extension before running `npm run setup`, or
// in any order, eventually self-heals.

const HOST_NAME = "com.fireclerk.host";
let port = null;

function connect() {
  console.info("[fireclerk] connecting to native host…");
  try {
    port = browser.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.error("[fireclerk] connectNative threw:", e);
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(handle);
  port.onDisconnect.addListener(() => {
    const err = port && port.error;
    console.warn(
      "[fireclerk] host disconnected:",
      err && err.message ? err.message : "(clean exit / no error)"
    );
    port = null;
    scheduleReconnect();
  });
}

let reconnectTimer = null;
let attempt = 0;
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1500 * 2 ** attempt, 30000);
  attempt++;
  console.warn(`[fireclerk] reconnecting in ${delay}ms (attempt ${attempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function handle(msg) {
  // Host-originated events (not CLI command replies) — e.g. the startup hello.
  if (msg && msg.event) {
    if (msg.event === "hello") {
      attempt = 0; // healthy link; reset backoff
      console.info("[fireclerk] connected to host, pid", msg.pid);
    }
    return;
  }
  const { id, cmd, args = {} } = msg;
  try {
    const data = await dispatch(cmd, args);
    port.postMessage({ id, ok: true, data });
  } catch (e) {
    port.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
}

async function dispatch(cmd, args) {
  switch (cmd) {
    case "ping":
      return { pong: true };
    case "listTabs":
      return listTabs();
    case "containers":
      return listContainers();
    case "html":
      return getContent(args, "html");
    case "text":
      return getContent(args, "text");
    case "openTab":
      return openTab(args);
    case "closeTabs":
      return closeTabs(args);
    case "waitTab":
      return waitForTab(args);
    case "queryTab":
      return queryTab(args);
    case "fetchTab":
      return fetchTab(args);
    case "capturePage":
      return capturePage(args);
    default:
      throw new Error("unknown command: " + cmd);
  }
}

function containerLabel(cookieStoreId, identity) {
  if (identity) return identity.name;
  if (!cookieStoreId || cookieStoreId === "firefox-default") return "default";
  if (cookieStoreId === "firefox-private") return "private";
  return cookieStoreId; // unknown store, show the raw id
}

async function loadIdentities() {
  // contextualIdentities throws if Multi-Account Containers is disabled
  // (privacy.userContext.enabled = false). Degrade gracefully.
  try {
    const list = await browser.contextualIdentities.query({});
    const map = {};
    for (const ci of list) map[ci.cookieStoreId] = ci;
    return map;
  } catch {
    return {};
  }
}

function tabInfo(t, identities = {}) {
  const ci = identities[t.cookieStoreId];
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    active: t.active,
    pinned: t.pinned,
    title: t.title,
    url: t.url,
    cookieStoreId: t.cookieStoreId,
    container: containerLabel(t.cookieStoreId, ci),
    containerColor: ci ? ci.color : null,
    containerIcon: ci ? ci.icon : null,
    status: t.status,
    lastAccessed: t.lastAccessed,
  };
}

async function listTabs() {
  const [tabs, identities] = await Promise.all([
    browser.tabs.query({}),
    loadIdentities(),
  ]);
  return tabs.map((t) => tabInfo(t, identities));
}

async function openTab(args) {
  const createProps = { active: args.active !== false };
  if (args.url) createProps.url = args.url;
  if (args.windowId != null) createProps.windowId = args.windowId;
  if (args.cookieStoreId) createProps.cookieStoreId = args.cookieStoreId;

  const tab = await browser.tabs.create(createProps);
  const identities = await loadIdentities();
  return tabInfo(tab, identities);
}

async function closeTabs(args) {
  const tabIds = Array.isArray(args.tabIds) ? args.tabIds : [];
  if (!tabIds.length) throw new Error("no tab ids supplied");
  await browser.tabs.remove(tabIds);
  return { closed: tabIds };
}

async function listContainers() {
  try {
    return await browser.contextualIdentities.query({});
  } catch (e) {
    throw new Error(
      "contextualIdentities unavailable (containers disabled): " +
        ((e && e.message) || e)
    );
  }
}

async function resolveTabId(args) {
  if (args.tabId != null) return args.tabId;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new Error("no active tab in the current window");
  return active.id;
}

const SELECTOR_POLL_INTERVAL_MS = 50;

function waitResult(tabId, condition, startedAt) {
  return {
    tabId,
    condition,
    elapsedMs: Date.now() - startedAt,
  };
}

function waitForStatus(tabId, status, timeoutMs, startedAt) {
  const condition = { status };
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(waitResult(tabId, condition, startedAt));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === status || (tab && tab.status === status)) succeed();
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        fail(new Error(`tab ${tabId} closed while waiting for status ${status}`));
      }
    };

    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    timeout = setTimeout(() => {
      fail(new Error(`timed out waiting for tab ${tabId} status ${status} after ${timeoutMs} ms`));
    }, timeoutMs);

    browser.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === status) succeed();
      },
      (error) => {
        fail(new Error(`cannot wait for tab ${tabId}: ${error.message || error}`));
      }
    );
  });
}

function waitForSelector(tabId, selector, timeoutMs, startedAt) {
  const condition = { selector };
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer;
    let timeout;
    let lastError;

    const cleanup = () => {
      clearTimeout(pollTimer);
      clearTimeout(timeout);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(waitResult(tabId, condition, startedAt));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        fail(new Error(`tab ${tabId} closed while waiting for selector ${JSON.stringify(selector)}`));
      }
    };
    const check = async () => {
      if (settled) return;
      try {
        await browser.tabs.get(tabId);
      } catch (error) {
        fail(new Error(`cannot wait for tab ${tabId}: ${error.message || error}`));
        return;
      }

      try {
        const result = await browser.tabs.sendMessage(tabId, {
          type: "fireclerk:hasSelector",
          selector,
        });
        lastError = null;
        if (result && result.matched) {
          succeed();
          return;
        }
      } catch (error) {
        const message = String((error && error.message) || error);
        if (/invalid selector/i.test(message)) {
          fail(new Error(message));
          return;
        }
        lastError = message;
      }
      if (!settled) pollTimer = setTimeout(check, SELECTOR_POLL_INTERVAL_MS);
    };

    browser.tabs.onRemoved.addListener(onRemoved);
    timeout = setTimeout(() => {
      const detail = lastError ? ` (last page error: ${lastError})` : "";
      fail(
        new Error(
          `timed out waiting for tab ${tabId} selector ${JSON.stringify(selector)} after ${timeoutMs} ms${detail}`
        )
      );
    }, timeoutMs);
    check();
  });
}

async function waitForTab(args) {
  const tabId = args.tabId;
  const timeoutMs = args.timeoutMs;
  const hasStatus = typeof args.status === "string";
  const hasSelector = typeof args.selector === "string";
  if (!Number.isInteger(tabId)) throw new Error("wait requires an integer tab id");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("wait requires a positive integer timeout");
  }
  if (hasStatus === hasSelector) {
    throw new Error("wait requires exactly one status or selector condition");
  }
  if (hasStatus && args.status !== "complete") {
    throw new Error("wait currently supports only status complete");
  }

  const startedAt = Date.now();
  if (hasStatus) return waitForStatus(tabId, args.status, timeoutMs, startedAt);
  return waitForSelector(tabId, args.selector, timeoutMs, startedAt);
}

async function queryTab(args) {
  const { tabId, selector, mode, attribute } = args;
  if (!Number.isInteger(tabId)) throw new Error("query requires an integer tab id");
  if (typeof selector !== "string") throw new Error("query requires a CSS selector");
  if (!["html", "text", "attr"].includes(mode)) throw new Error("invalid query mode");
  if (mode === "attr" && typeof attribute !== "string") {
    throw new Error("attribute query requires an attribute name");
  }

  let result;
  try {
    result = await browser.tabs.sendMessage(tabId, {
      type: "fireclerk:query",
      selector,
      mode,
      attribute: mode === "attr" ? attribute : undefined,
      all: args.all === true,
    });
  } catch (error) {
    const message = String((error && error.message) || error);
    if (/invalid selector/i.test(message)) throw new Error(message);
    throw new Error(
      `cannot query tab ${tabId}: ${message} (privileged page, or content not yet loaded?)`
    );
  }

  const tab = await browser.tabs.get(tabId);
  return {
    tabId,
    url: tab.url,
    selector,
    mode,
    matches: result && Array.isArray(result.matches) ? result.matches : [],
  };
}

const SENSITIVE_FETCH_HEADERS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
]);

function sanitizeFetchHeaders(headers) {
  const sanitized = {};
  for (const [rawName, value] of Object.entries(headers || {})) {
    const name = rawName.toLowerCase();
    if (!SENSITIVE_FETCH_HEADERS.has(name)) sanitized[name] = value;
  }
  return sanitized;
}

async function fetchTab(args) {
  const { tabId, url } = args;
  if (!Number.isInteger(tabId)) throw new Error("fetch requires an integer tab id");
  if (typeof url !== "string" || !url) throw new Error("fetch requires a URL");

  const tab = await browser.tabs.get(tabId);
  let source;
  let target;
  try {
    source = new URL(tab.url);
    target = new URL(url, source);
  } catch (error) {
    throw new Error(`invalid fetch URL: ${error.message || error}`);
  }
  if (!["http:", "https:"].includes(source.protocol)) {
    throw new Error(`cannot fetch from tab ${tabId} with scheme ${source.protocol}`);
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error(`unsupported fetch URL scheme ${target.protocol}`);
  }
  if (target.origin !== source.origin) {
    throw new Error(`cross-origin fetch rejected: ${target.origin} does not match ${source.origin}`);
  }

  let result;
  try {
    result = await browser.tabs.sendMessage(tabId, {
      type: "fireclerk:fetch",
      url,
    });
  } catch (error) {
    throw new Error(`cannot fetch in tab ${tabId}: ${error.message || error}`);
  }
  if (!result || typeof result.url !== "string") {
    throw new Error(`invalid fetch response from tab ${tabId}`);
  }
  if (new URL(result.url).origin !== source.origin) {
    throw new Error("cross-origin fetch response rejected");
  }

  return {
    tabId,
    status: result.status,
    statusText: result.statusText,
    url: result.url,
    contentType: result.contentType,
    headers: sanitizeFetchHeaders(result.headers),
    bodyEncoding: result.bodyEncoding,
    byteLength: result.byteLength,
    body: result.body,
  };
}

async function capturePage(args) {
  const { sourceTabId, url, wait, format, timeoutMs } = args;
  if (!Number.isInteger(sourceTabId)) throw new Error("capture requires an integer source tab id");
  if (wait !== "complete") throw new Error("capture currently supports only wait complete");
  if (format !== "html") throw new Error("capture currently supports only format html");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("capture requires a positive integer timeout");
  }

  let target;
  try {
    target = new URL(url);
  } catch (error) {
    throw new Error(`invalid capture URL: ${error.message || error}`);
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error(`unsupported capture URL scheme ${target.protocol}`);
  }

  let source;
  try {
    source = await browser.tabs.get(sourceTabId);
  } catch (error) {
    throw new Error(`source tab ${sourceTabId} is unavailable: ${error.message || error}`);
  }

  let temporaryTabId = null;
  let result;
  let primaryError;
  let cleanupError;
  try {
    let temporaryTab;
    try {
      temporaryTab = await browser.tabs.create({
        url: target.href,
        active: false,
        windowId: source.windowId,
        cookieStoreId: source.cookieStoreId,
      });
    } catch (error) {
      throw new Error(`cannot open temporary capture tab: ${error.message || error}`);
    }
    temporaryTabId = temporaryTab.id;

    await waitForTab({
      tabId: temporaryTabId,
      status: wait,
      timeoutMs,
    });
    const captured = await getContent({ tabId: temporaryTabId }, format);
    result = {
      sourceTabId,
      temporaryTabId,
      finalUrl: captured.url,
      containerId: source.cookieStoreId,
      format,
      byteLength: new TextEncoder().encode(captured.content).byteLength,
      content: captured.content,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (temporaryTabId !== null) {
      try {
        await browser.tabs.remove(temporaryTabId);
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (primaryError) {
    if (cleanupError) {
      throw new Error(
        `${primaryError.message || primaryError}; cleanup also failed for temporary tab ${temporaryTabId}: ${cleanupError.message || cleanupError}`
      );
    }
    throw primaryError;
  }
  if (cleanupError) {
    throw new Error(
      `capture succeeded but cleanup failed for temporary tab ${temporaryTabId}: ${cleanupError.message || cleanupError}`
    );
  }

  result.cleanup = { closed: true, tabId: temporaryTabId };
  return result;
}

async function getContent(args, kind) {
  const tabId = await resolveTabId(args);
  const code =
    kind === "text"
      ? "document.body ? document.body.innerText : ''"
      : "document.documentElement ? document.documentElement.outerHTML : ''";

  let results;
  try {
    results = await browser.tabs.executeScript(tabId, { code });
  } catch (e) {
    throw new Error(
      "cannot read tab " +
        tabId +
        ": " +
        ((e && e.message) || e) +
        " (privileged page like about:/addons, or content not yet loaded?)"
    );
  }

  const tab = await browser.tabs.get(tabId);
  return {
    tabId,
    url: tab.url,
    title: tab.title,
    kind,
    content: results && results[0] != null ? results[0] : "",
  };
}

connect();
