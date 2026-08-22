import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contentSource = fs.readFileSync(path.join(root, "extension", "content.js"), "utf8");

function loadContent(document) {
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

  vm.runInNewContext(contentSource, { browser, document });
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
