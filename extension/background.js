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
