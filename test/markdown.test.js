import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { htmlToMarkdown } from "../src/markdown.js";

const html = fs.readFileSync(new URL("./fixtures/markdown.html", import.meta.url), "utf8");

test("Markdown preserves readable structure and resolves relative links", async () => {
  const content = await htmlToMarkdown(html, "https://example.com/articles/page");
  assert.match(content, /\*\*important details\*\*/);
  assert.match(content, /\[relative link\]\(https:\/\/example\.com\/guide\)/);
  assert.match(content, /## Details/);
  assert.match(content, /[-*] +First useful item/);
  assert.match(content, /```js\nconst answer = 42;/);
  assert.match(content, /café, שלום, and 日本語/);
  assert.doesNotMatch(content, /Navigation junk|Footer junk|<article>|fireclerkMarkdownScriptRan/);
  assert.equal(globalThis.fireclerkMarkdownScriptRan, undefined);
});

test("Markdown handles empty, whitespace-only, and incomplete HTML", async () => {
  for (const input of ["", "  \n", "<html><head><title>Empty</title></head><body></body></html>"]) {
    assert.equal(await htmlToMarkdown(input, undefined), "");
  }
  const content = await htmlToMarkdown("<html><body><p>broken <strong>but readable", undefined);
  assert.match(content, /broken \*\*but readable\*\*/);
});

test("Markdown uses only supplied HTML, even for sites with async extractors", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  for (const url of [
    "https://example.com/article",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://x.com/example/status/123",
    "https://www.reddit.com/r/example/comments/123/title/",
  ]) {
    await htmlToMarkdown(html, url);
    await htmlToMarkdown("<html><body></body></html>", url);
  }
  assert.equal(fetch.mock.callCount(), 0);
});
