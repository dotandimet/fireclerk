// Narrow page-context operations used by the background bridge. Inputs arrive
// as structured message data; no caller-controlled JavaScript is evaluated.

// Standalone content script: normalize arbitrary DOM/fetch errors at the boundary.
/** @param {unknown} error @returns {string} */
function contentErrorMessage(error) {
  if (typeof error === "object" && error !== null &&
      "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return String(error);
}

/** @param {string} selector @param {boolean} all */
function selectNodes(selector, all) {
  try {
    if (all) return Array.from(document.querySelectorAll(selector));
    const match = document.querySelector(selector);
    return match ? [match] : [];
  } catch (error) {
    throw new Error(`invalid selector: ${contentErrorMessage(error)}`);
  }
}

const MAX_FETCH_BYTES = 10 * 1024 * 1024;
const SENSITIVE_HEADERS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
]);

/** @param {Headers} headers @returns {Record<string, string>} */
function sanitizedHeaders(headers) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!SENSITIVE_HEADERS.has(name)) result[name] = value;
  }
  return result;
}

/** @param {Response} response */
async function readLimitedBody(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FETCH_BYTES) {
    throw new Error(`response exceeds the ${MAX_FETCH_BYTES}-byte size limit`);
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_FETCH_BYTES) {
      await reader.cancel();
      throw new Error(`response exceeds the ${MAX_FETCH_BYTES}-byte size limit`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** @param {Uint8Array} bytes */
function base64Encode(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * @param {string} rawUrl
 * @returns {Promise<import('../src/contracts.js').ContentReply<'fireclerk:fetch'>>}
 */
async function fetchSameOrigin(rawUrl) {
  /** @type {URL} */
  let source;
  /** @type {URL} */
  let target;
  try {
    source = new URL(document.location.href);
    target = new URL(rawUrl, source);
  } catch (error) {
    throw new Error(`invalid fetch URL: ${contentErrorMessage(error)}`);
  }
  if (!["http:", "https:"].includes(source.protocol)) {
    throw new Error(`cannot fetch from source scheme ${source.protocol}`);
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error(`unsupported fetch URL scheme ${target.protocol}`);
  }
  if (target.origin !== source.origin) {
    throw new Error(`cross-origin fetch rejected: ${target.origin} does not match ${source.origin}`);
  }

  const response = await fetch(target.href, {
    method: "GET",
    credentials: "include",
    redirect: "manual",
  });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    const location = response.headers.get("location");
    if (location) {
      const redirectTarget = new URL(location, target);
      if (redirectTarget.origin !== source.origin) {
        throw new Error(`cross-origin redirect to ${redirectTarget.origin} was not followed`);
      }
    }
    throw new Error("redirect response was not followed");
  }

  const finalUrl = response.url || target.href;
  if (new URL(finalUrl).origin !== source.origin) {
    throw new Error("cross-origin redirect was not followed");
  }
  const headers = sanitizedHeaders(response.headers);
  const body = await readLimitedBody(response);
  return {
    status: response.status,
    statusText: response.statusText,
    url: finalUrl,
    contentType: headers["content-type"] || "",
    headers,
    bodyEncoding: "base64",
    byteLength: body.byteLength,
    body: base64Encode(body),
  };
}

/**
 * @param {import('../src/contracts.js').ContentApi['fireclerk:hasSelector']['args']} args
 * @returns {import('../src/contracts.js').ContentReply<'fireclerk:hasSelector'>}
 */
function hasSelector(args) {
  return { matched: selectNodes(args.selector, false).length > 0 };
}

/**
 * @param {import('../src/contracts.js').QuerySelection} args
 * @returns {import('../src/contracts.js').ContentReply<'fireclerk:query'>}
 */
function queryDocument(args) {
  const nodes = selectNodes(args.selector, args.all === true);
  const matches = nodes.map((node) => {
    if (args.mode === "html") return node.outerHTML;
    if (args.mode === "text") return node.textContent;
    if (args.mode === "attr") return node.getAttribute(args.attribute);
    throw new Error(`invalid query mode: ${args.mode}`);
  });
  return { matches };
}

/** @type {import('../src/contracts.js').ContentHandlers} */
const contentHandlers = {
  "fireclerk:hasSelector": hasSelector,
  "fireclerk:query": queryDocument,
  "fireclerk:fetch": (args) => fetchSameOrigin(args.url),
};

/**
 * @template {keyof import('../src/contracts.js').ContentApi} K
 * @param {{ type: K } & import('../src/contracts.js').ContentApi[K]['args']} message
 * @returns {Promise<import('../src/contracts.js').ContentReply<K>> | undefined}
 */
function handleContentMessage(message) {
  // Unrelated runtime messages are ignored, not claimed by this listener.
  if (!message || !Object.hasOwn(contentHandlers, message.type)) return undefined;
  return Promise.resolve(contentHandlers[message.type](message));
}

browser.runtime.onMessage.addListener(handleContentMessage);
