// FireClerk bridge background script.
//
// Holds a persistent native-messaging port to the host. Each inbound message
// is a command {id, cmd, args}; we run it and post {id, ok, data|error} back.
// If the host dies (e.g. it wasn't installed yet), the port disconnects and we
// retry shortly — so loading the extension before running `npm run setup`, or
// in any order, eventually self-heals.

// Standalone Firefox scripts cannot import the Node error helper.
// Error/rejection boundary: browser errors may come from another realm.
/** @param {unknown} error @returns {string} */
function backgroundErrorMessage(error) {
  if (typeof error === "object" && error !== null &&
      "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return String(error);
}

const HOST_NAME = "com.fireclerk.host";
/** @type {browser.runtime.Port | null} */
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
  // The native host owns this envelope; the assertion is the JSON trust boundary.
  port.onMessage.addListener((message) => handle(
    /** @type {import('../src/contracts.js').NativeRequest | import('../src/contracts.js').HostHello} */ (message)
  ));
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

/** @type {ReturnType<typeof setTimeout> | null} */
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

/** @param {import('../src/contracts.js').NativeRequest | import('../src/contracts.js').HostHello} msg */
async function handle(msg) {
  // Host-originated events (not CLI command replies) — e.g. the startup hello.
  if (msg && "event" in msg) {
    if (msg.event === "hello") {
      attempt = 0; // healthy link; reset backoff
      console.info("[fireclerk] connected to host, pid", msg.pid);
    }
    return;
  }
  const { id } = msg;
  try {
    const data = await dispatch(msg.cmd, msg.args);
    port?.postMessage({ id, ok: true, data });
  } catch (e) {
    port?.postMessage({ id, ok: false, error: backgroundErrorMessage(e) });
  }
}

// The mapped type checks coverage AND each command's argument/result pairing.
/** @type {import('../src/contracts.js').CommandHandlers} */
const commandHandlers = {
  ping: pingInfo,
  listTabs,
  containers: listContainers,
  html: (args) => getContent(args, "html"),
  text: (args) => getContent(args, "text"),
  openTab,
  openPrivateWindow,
  closeTabs,
  waitTab: waitForTab,
  queryTab,
  fetchTab,
  capturePage,
};

/**
 * @template {import('../src/contracts.js').Command} K
 * @param {K} cmd
 * @param {import('../src/contracts.js').CommandArgs<K>} args
 * @returns {Promise<import('../src/contracts.js').CommandResult<K>>}
 */
async function dispatch(cmd, args) {
  if (!Object.hasOwn(commandHandlers, cmd)) throw new Error("unknown command: " + cmd);
  return commandHandlers[cmd](args);
}

/**
 * @param {string | undefined} cookieStoreId
 * @param {browser.contextualIdentities.ContextualIdentity | undefined} identity
 */
function containerLabel(cookieStoreId, identity) {
  if (identity) return identity.name;
  if (!cookieStoreId || cookieStoreId === "firefox-default") return "default";
  if (cookieStoreId === "firefox-private") return "private";
  return cookieStoreId; // unknown store, show the raw id
}

/** @returns {Promise<Record<string, browser.contextualIdentities.ContextualIdentity>>} */
async function loadIdentities() {
  // contextualIdentities throws if Multi-Account Containers is disabled
  // (privacy.userContext.enabled = false). Degrade gracefully.
  try {
    const list = await browser.contextualIdentities.query({});
    /** @type {Record<string, browser.contextualIdentities.ContextualIdentity>} */
    const map = {};
    for (const ci of list) map[ci.cookieStoreId] = ci;
    return map;
  } catch {
    return {};
  }
}

/**
 * @param {browser.tabs.Tab} t
 * @param {Record<string, browser.contextualIdentities.ContextualIdentity>} identities
 * @returns {import('../src/contracts.js').TabInfo}
 */
function tabInfo(t, identities = {}) {
  const ci = t.cookieStoreId ? identities[t.cookieStoreId] : undefined;
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    active: t.active,
    incognito: t.incognito === true,
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

/** @returns {Promise<import('../src/contracts.js').CommandResult<'listTabs'>>} */
async function listTabs() {
  const [tabs, identities] = await Promise.all([
    browser.tabs.query({}),
    loadIdentities(),
  ]);
  return tabs.map((t) => tabInfo(t, identities));
}

async function privateAccessAllowed() {
  if (!browser.extension || typeof browser.extension.isAllowedIncognitoAccess !== "function") {
    return null;
  }
  return browser.extension.isAllowedIncognitoAccess();
}

function privateAccessError() {
  return new Error(
    "FireClerk is not allowed in private windows. Open about:addons, select FireClerk, " +
      "and set 'Run in Private Windows' to 'Allow'."
  );
}

async function requirePrivateAccess() {
  if ((await privateAccessAllowed()) === false) throw privateAccessError();
}

/** @returns {Promise<import('../src/contracts.js').CommandResult<'ping'>>} */
async function pingInfo() {
  return {
    pong: true,
    extensionVersion: browser.runtime.getManifest().version,
    privateAccess: await privateAccessAllowed(),
  };
}

/**
 * @param {import('../src/contracts.js').OpenTabArgs} args
 * @returns {Promise<import('../src/contracts.js').CommandResult<'openTab'>>}
 */
async function openTab(args) {
  /** @type {browser.tabs._CreateCreateProperties} */
  const createProps = { active: args.active !== false };
  if (args.url) createProps.url = args.url;
  if (args.windowId != null) createProps.windowId = args.windowId;
  if (args.cookieStoreId) createProps.cookieStoreId = args.cookieStoreId;

  const tab = await browser.tabs.create(createProps);
  const identities = await loadIdentities();
  return tabInfo(tab, identities);
}

/**
 * @param {import('../src/contracts.js').OpenPrivateWindowArgs} args
 * @returns {Promise<import('../src/contracts.js').CommandResult<'openPrivateWindow'>>}
 */
async function openPrivateWindow(args) {
  await requirePrivateAccess();
  /** @type {browser.windows._CreateCreateData} */
  const createProps = {
    incognito: true,
    focused: args.focused !== false,
  };
  if (args.url) createProps.url = args.url;

  /** @type {browser.windows.Window} */
  let window;
  try {
    window = await browser.windows.create(createProps);
  } catch (error) {
    const message = backgroundErrorMessage(error);
    throw new Error(`${message}. ${privateAccessError().message}`);
  }

  const [tab] = await browser.tabs.query({ windowId: window.id });
  if (!tab) throw new Error(`private window ${window.id} opened without a tab`);
  const identities = await loadIdentities();
  return {
    ...tabInfo(tab, identities),
    windowFocused: window.focused,
  };
}

/**
 * @param {import('../src/contracts.js').CommandArgs<'closeTabs'>} args
 * @returns {Promise<import('../src/contracts.js').CommandResult<'closeTabs'>>}
 */
async function closeTabs(args) {
  const tabIds = Array.isArray(args.tabIds) ? args.tabIds : [];
  if (!tabIds.length) throw new Error("no tab ids supplied");
  await browser.tabs.remove(tabIds);
  return { closed: tabIds };
}

/** @returns {Promise<import('../src/contracts.js').CommandResult<'containers'>>} */
async function listContainers() {
  try {
    return await browser.contextualIdentities.query({});
  } catch (e) {
    throw new Error(
      "contextualIdentities unavailable (containers disabled): " +
        backgroundErrorMessage(e)
    );
  }
}

/** @param {import('../src/contracts.js').TabTarget} args @returns {Promise<number>} */
async function resolveTabId(args) {
  if (args.tabId != null) return args.tabId;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id === undefined) throw new Error("no active tab in the current window");
  return active.id;
}

/**
 * Typed background -> content-script boundary; Firefox transports JSON values.
 * @template {keyof import('../src/contracts.js').ContentApi} K
 * @param {number} tabId
 * @param {K} type
 * @param {import('../src/contracts.js').ContentApi[K]['args']} args
 * @returns {Promise<import('../src/contracts.js').ContentReply<K>>}
 */
function sendContentMessage(tabId, type, args) {
  return browser.tabs.sendMessage(tabId, { type, ...args });
}

const SELECTOR_POLL_INTERVAL_MS = 50;

/**
 * @param {number} tabId
 * @param {import('../src/contracts.js').WaitCondition} condition
 * @param {number} startedAt
 * @returns {import('../src/contracts.js').WaitResult}
 */
function waitResult(tabId, condition, startedAt) {
  return {
    tabId,
    condition,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * @param {number} tabId
 * @param {'complete'} status
 * @param {number} timeoutMs
 * @param {number} startedAt
 * @returns {Promise<import('../src/contracts.js').WaitResult>}
 */
function waitForStatus(tabId, status, timeoutMs, startedAt) {
  const condition = { status };
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
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
    const fail = (/** @type {Error} */ error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    /** @type {Parameters<typeof browser.tabs.onUpdated.addListener>[0]} */
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === status || (tab && tab.status === status)) succeed();
    };
    const onRemoved = (/** @type {number} */ removedTabId) => {
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
      (/** @type {unknown} */ error) => {
        fail(new Error(`cannot wait for tab ${tabId}: ${backgroundErrorMessage(error)}`));
      }
    );
  });
}

/**
 * @param {number} tabId
 * @param {string} selector
 * @param {number} timeoutMs
 * @param {number} startedAt
 * @returns {Promise<import('../src/contracts.js').WaitResult>}
 */
function waitForSelector(tabId, selector, timeoutMs, startedAt) {
  const condition = { selector };
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let pollTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout;
    /** @type {string | null | undefined} */
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
    const fail = (/** @type {Error} */ error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onRemoved = (/** @type {number} */ removedTabId) => {
      if (removedTabId === tabId) {
        fail(new Error(`tab ${tabId} closed while waiting for selector ${JSON.stringify(selector)}`));
      }
    };
    const check = async () => {
      if (settled) return;
      try {
        await browser.tabs.get(tabId);
      } catch (error) {
        fail(new Error(`cannot wait for tab ${tabId}: ${backgroundErrorMessage(error)}`));
        return;
      }

      try {
        const result = await sendContentMessage(tabId, "fireclerk:hasSelector", { selector });
        lastError = null;
        if (result && result.matched) {
          succeed();
          return;
        }
      } catch (error) {
        const message = backgroundErrorMessage(error);
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

/**
 * @param {import('../src/contracts.js').WaitArgs} args
 * @returns {Promise<import('../src/contracts.js').WaitResult>}
 */
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

/**
 * @param {import('../src/contracts.js').QueryArgs} args
 * @returns {Promise<import('../src/contracts.js').QueryResult>}
 */
async function queryTab(args) {
  const { tabId, selector, mode, attribute } = args;
  if (!Number.isInteger(tabId)) throw new Error("query requires an integer tab id");
  if (typeof selector !== "string") throw new Error("query requires a CSS selector");
  if (!["html", "text", "attr"].includes(mode)) throw new Error("invalid query mode");
  if (mode === "attr" && typeof attribute !== "string") {
    throw new Error("attribute query requires an attribute name");
  }

  /** @type {import('../src/contracts.js').ContentReply<'fireclerk:query'>} */
  let result;
  try {
    const selection = mode === "attr"
      ? { selector, mode, attribute, all: args.all === true }
      : { selector, mode, all: args.all === true };
    result = await sendContentMessage(tabId, "fireclerk:query", selection);
  } catch (error) {
    const message = backgroundErrorMessage(error);
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

/** @param {Record<string, string>} headers @returns {Record<string, string>} */
function sanitizeFetchHeaders(headers) {
  /** @type {Record<string, string>} */
  const sanitized = {};
  for (const [rawName, value] of Object.entries(headers || {})) {
    const name = rawName.toLowerCase();
    if (!SENSITIVE_FETCH_HEADERS.has(name)) sanitized[name] = value;
  }
  return sanitized;
}

/**
 * @param {import('../src/contracts.js').FetchArgs} args
 * @returns {Promise<import('../src/contracts.js').CommandResult<'fetchTab'>>}
 */
async function fetchTab(args) {
  const { tabId, url } = args;
  if (!Number.isInteger(tabId)) throw new Error("fetch requires an integer tab id");
  if (typeof url !== "string" || !url) throw new Error("fetch requires a URL");

  const tab = await browser.tabs.get(tabId);
  /** @type {URL} */
  let source;
  /** @type {URL} */
  let target;
  try {
    source = new URL(tab.url || "");
    target = new URL(url, source);
  } catch (error) {
    throw new Error(`invalid fetch URL: ${backgroundErrorMessage(error)}`);
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

  /** @type {import('../src/contracts.js').ContentReply<'fireclerk:fetch'>} */
  let result;
  try {
    result = await sendContentMessage(tabId, "fireclerk:fetch", { url });
  } catch (error) {
    throw new Error(`cannot fetch in tab ${tabId}: ${backgroundErrorMessage(error)}`);
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

/**
 * @param {import('../src/contracts.js').CaptureArgs} args
 * @returns {Promise<import('../src/contracts.js').CaptureResult>}
 */
async function capturePage(args) {
  const { sourceTabId, url, wait, format, timeoutMs } = args;
  if (!Number.isInteger(sourceTabId)) throw new Error("capture requires an integer source tab id");
  if (wait !== "complete") throw new Error("capture currently supports only wait complete");
  if (format !== "html") throw new Error("capture currently supports only format html");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("capture requires a positive integer timeout");
  }

  /** @type {URL} */
  let target;
  try {
    target = new URL(url);
  } catch (error) {
    throw new Error(`invalid capture URL: ${backgroundErrorMessage(error)}`);
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error(`unsupported capture URL scheme ${target.protocol}`);
  }

  /** @type {browser.tabs.Tab} */
  let source;
  try {
    source = await browser.tabs.get(sourceTabId);
  } catch (error) {
    throw new Error(`source tab ${sourceTabId} is unavailable: ${backgroundErrorMessage(error)}`);
  }

  /** @type {number | null} */
  let temporaryTabId = null;
  /** @type {Omit<import('../src/contracts.js').CaptureResult, 'cleanup'> | undefined} */
  let result;
  /** @type {Error | undefined} */
  let primaryError;
  /** @type {Error | undefined} */
  let cleanupError;
  try {
    /** @type {browser.tabs.Tab} */
    let temporaryTab;
    try {
      if (source.incognito) await requirePrivateAccess();
      /** @type {browser.tabs._CreateCreateProperties} */
      const createProperties = {
        url: target.href,
        active: false,
        windowId: source.windowId,
      };
      if (!source.incognito) createProperties.cookieStoreId = source.cookieStoreId;
      temporaryTab = await browser.tabs.create(createProperties);
    } catch (error) {
      throw new Error(`cannot open temporary capture tab: ${backgroundErrorMessage(error)}`);
    }
    if (temporaryTab.id === undefined) throw new Error("capture tab has no id");
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
    primaryError = new Error(backgroundErrorMessage(error));
  } finally {
    if (temporaryTabId !== null) {
      try {
        await browser.tabs.remove(temporaryTabId);
      } catch (error) {
        cleanupError = new Error(backgroundErrorMessage(error));
      }
    }
  }

  if (primaryError) {
    if (cleanupError) {
      throw new Error(
        `${primaryError.message}; cleanup also failed for temporary tab ${temporaryTabId}: ${cleanupError.message}`
      );
    }
    throw primaryError;
  }
  if (cleanupError) {
    throw new Error(
      `capture succeeded but cleanup failed for temporary tab ${temporaryTabId}: ${cleanupError.message}`
    );
  }

  if (!result || temporaryTabId === null) throw new Error("capture produced no result");
  return { ...result, cleanup: { closed: true, tabId: temporaryTabId } };
}

/**
 * @template {import('../src/contracts.js').ContentKind} K
 * @param {import('../src/contracts.js').TabTarget} args
 * @param {K} kind
 * @returns {Promise<import('../src/contracts.js').ContentResult<K>>}
 */
async function getContent(args, kind) {
  const tabId = await resolveTabId(args);
  const code =
    kind === "text"
      ? "document.body ? document.body.innerText : ''"
      : "document.documentElement ? document.documentElement.outerHTML : ''";

  // executeScript is declared as an unchecked array by Firefox typings.
  /** @type {unknown[]} */
  let results;
  try {
    results = await browser.tabs.executeScript(tabId, { code });
  } catch (e) {
    throw new Error(
      "cannot read tab " +
        tabId +
        ": " +
        backgroundErrorMessage(e) +
        " (privileged page like about:/addons, or content not yet loaded?)"
    );
  }

  const content = results[0] ?? "";
  if (typeof content !== "string") throw new Error(`invalid ${kind} content from tab ${tabId}`);
  const tab = await browser.tabs.get(tabId);
  return {
    tabId,
    url: tab.url,
    title: tab.title,
    kind,
    content,
  };
}

connect();
