/**
 * Convert a live tab's HTML locally. Defuddle's string input uses its Node DOM
 * adapter; never re-fetch the URL or use third-party extractor fallbacks.
 * @param {string} html
 * @param {string | undefined} url
 * @returns {Promise<string>}
 */
export async function htmlToMarkdown(html, url) {
  if (!html.trim()) return "";
  // Keep the parser out of startup for help, setup, and non-Markdown commands.
  const { Defuddle } = await import("defuddle/node");
  const { content } = await Defuddle(html, url, {
    markdown: true,
    useAsync: false,
  });
  return content;
}
