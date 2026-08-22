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

  return undefined;
});
