import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contentSource = fs.readFileSync(path.join(root, "extension", "content.js"), "utf8");

function loadContent(document, globals = {}) {
  let listener;
  const browser = {
    runtime: {
      onMessage: {
        addListener(callback) {
          listener = callback;
        },
      },
    },
  };

  vm.runInNewContext(contentSource, { browser, document, ...globals });
  return (message) => listener(message);
}

function node({ html, text, attributes = {} }) {
  return {
    outerHTML: html,
    textContent: text,
    getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
  };
}

test("query extracts HTML, text, and attributes without executing input", async () => {
  const hostileSelector = "article[data-value=\"'\\\\\n) => pageFunction()\"]";
  const hostileAttribute = "data-'\\\\\n-function";
  const calls = [];
  const nodes = [
    node({ html: "<article>first</article>", text: "first", attributes: { [hostileAttribute]: "" } }),
    node({ html: "<article>second</article>", text: "second" }),
  ];
  const send = loadContent({
    querySelector(selector) {
      calls.push({ method: "one", selector });
      return nodes[0];
    },
    querySelectorAll(selector) {
      calls.push({ method: "all", selector });
      return nodes;
    },
  });

  const html = await send({
    type: "fireclerk:query",
    selector: hostileSelector,
    mode: "html",
    all: false,
  });
  const text = await send({
    type: "fireclerk:query",
    selector: hostileSelector,
    mode: "text",
    all: true,
  });
  const attributes = await send({
    type: "fireclerk:query",
    selector: hostileSelector,
    mode: "attr",
    attribute: hostileAttribute,
    all: true,
  });

  assert.deepEqual([...html.matches], ["<article>first</article>"]);
  assert.deepEqual([...text.matches], ["first", "second"]);
  assert.deepEqual([...attributes.matches], ["", null]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.selector === hostileSelector));
});

test("query returns a distinct successful empty match list", async () => {
  const send = loadContent({
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  });

  const first = await send({ type: "fireclerk:query", selector: ".missing", mode: "text", all: false });
  const all = await send({ type: "fireclerk:query", selector: ".missing", mode: "text", all: true });

  assert.deepEqual([...first.matches], []);
  assert.deepEqual([...all.matches], []);
});

test("query reports invalid selectors without rewriting them", async () => {
  const send = loadContent({
    querySelector(selector) {
      throw new SyntaxError(`bad selector ${selector}`);
    },
    querySelectorAll() {
      throw new Error("not reached");
    },
  });

  await assert.rejects(
    async () => send({ type: "fireclerk:query", selector: "[", mode: "html", all: false }),
    /invalid selector.*bad selector \[/i
  );
});

function mockResponse({
  bytes = [],
  status = 200,
  statusText = "OK",
  url = "https://example.com/api",
  type = "basic",
  headers = {},
} = {}) {
  const normalizedHeaders = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]);
  let read = false;
  return {
    status,
    statusText,
    url,
    type,
    headers: {
      get(name) {
        const found = normalizedHeaders.find(([key]) => key === name.toLowerCase());
        return found ? found[1] : null;
      },
      *[Symbol.iterator]() {
        yield* normalizedHeaders;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: Uint8Array.from(bytes) };
          },
          async cancel() {},
        };
      },
    },
  };
}

const fetchGlobals = {
  URL,
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
};

test("fetch resolves same-origin URLs, includes credentials, and sanitizes headers", async () => {
  const requests = [];
  const send = loadContent(
    { location: { href: "https://example.com/page" } },
    {
      ...fetchGlobals,
      async fetch(url, options) {
        requests.push({ url, options });
        return mockResponse({
          bytes: [0, 255, 10, 65],
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Test": "visible",
            Cookie: "secret",
            Authorization: "secret",
            "Proxy-Authorization": "secret",
            "Set-Cookie": "secret",
            "Set-Cookie2": "secret",
          },
        });
      },
    }
  );

  const result = await send({ type: "fireclerk:fetch", url: "/api" });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.com/api");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.credentials, "include");
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(result.status, 200);
  assert.equal(result.bodyEncoding, "base64");
  assert.equal(result.byteLength, 4);
  assert.deepEqual(Buffer.from(result.body, "base64"), Buffer.from([0, 255, 10, 65]));
  assert.equal(result.headers["content-type"], "application/octet-stream");
  assert.equal(result.headers["x-test"], "visible");
  for (const sensitive of ["cookie", "authorization", "proxy-authorization", "set-cookie", "set-cookie2"]) {
    assert.equal(result.headers[sensitive], undefined);
  }
});

test("fetch rejects cross-origin targets before network activity", async () => {
  let requests = 0;
  const send = loadContent(
    { location: { href: "https://example.com/page" } },
    {
      ...fetchGlobals,
      async fetch() {
        requests++;
        return mockResponse();
      },
    }
  );

  await assert.rejects(
    async () => send({ type: "fireclerk:fetch", url: "https://other.example/api" }),
    /cross-origin/i
  );
  assert.equal(requests, 0);
});

test("fetch never follows redirects and rejects oversized responses", async () => {
  const redirect = loadContent(
    { location: { href: "https://example.com/page" } },
    {
      ...fetchGlobals,
      async fetch() {
        return mockResponse({ type: "opaqueredirect", status: 0, url: "" });
      },
    }
  );
  await assert.rejects(
    async () => redirect({ type: "fireclerk:fetch", url: "/redirect" }),
    /redirect.*not followed/i
  );

  const oversized = loadContent(
    { location: { href: "https://example.com/page" } },
    {
      ...fetchGlobals,
      async fetch() {
        return mockResponse({ headers: { "Content-Length": String(10 * 1024 * 1024 + 1) } });
      },
    }
  );
  await assert.rejects(
    async () => oversized({ type: "fireclerk:fetch", url: "/large" }),
    /size limit/i
  );
});
