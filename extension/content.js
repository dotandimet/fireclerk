// Narrow page-context operations used by the background bridge. Inputs arrive
// as structured message data; no caller-controlled JavaScript is evaluated.

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "fireclerk:hasSelector") return undefined;

  try {
    return Promise.resolve({ matched: document.querySelector(message.selector) !== null });
  } catch (error) {
    throw new Error(`invalid selector: ${error.message || error}`);
  }
});
