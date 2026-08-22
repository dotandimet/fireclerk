// Narrow page-context operations used by the background bridge. Inputs arrive
// as structured message data; no caller-controlled JavaScript is evaluated.

function selectNodes(selector, all) {
  try {
    if (all) return Array.from(document.querySelectorAll(selector));
    const match = document.querySelector(selector);
    return match ? [match] : [];
  } catch (error) {
    throw new Error(`invalid selector: ${error.message || error}`);
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

function sanitizedHeaders(headers) {
  const result = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!SENSITIVE_HEADERS.has(name)) result[name] = value;
  }
  return result;
}

async function readLimitedBody(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FETCH_BYTES) {
    throw new Error(`response exceeds the ${MAX_FETCH_BYTES}-byte size limit`);
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
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

function base64Encode(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function fetchSameOrigin(rawUrl) {
  let source;
  let target;
  try {
    source = new URL(document.location.href);
    target = new URL(rawUrl, source);
  } catch (error) {
    throw new Error(`invalid fetch URL: ${error.message || error}`);
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

browser.runtime.onMessage.addListener((message) => {
  if (!message) return undefined;

  if (message.type === "fireclerk:hasSelector") {
    return Promise.resolve({ matched: selectNodes(message.selector, false).length > 0 });
  }

  if (message.type === "fireclerk:query") {
    const nodes = selectNodes(message.selector, message.all === true);
    const matches = nodes.map((node) => {
      if (message.mode === "html") return node.outerHTML;
      if (message.mode === "text") return node.textContent;
      if (message.mode === "attr") return node.getAttribute(message.attribute);
      throw new Error(`invalid query mode: ${message.mode}`);
    });
    return Promise.resolve({ matches });
  }

  if (message.type === "fireclerk:fetch") return fetchSameOrigin(message.url);

  return undefined;
});
