// JavaScript and API rejections can contain arbitrary values, including errors
// from another realm. Narrow them here; callers only receive a message string.
/** @param {unknown} error @returns {string} */
export function errorMessage(error) {
  if (typeof error === "object" && error !== null &&
      "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return String(error);
}

/** @param {unknown} error @returns {string | undefined} */
export function errorCode(error) {
  return typeof error === "object" && error !== null &&
    "code" in error && typeof error.code === "string" ? error.code : undefined;
}
