import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { errorCode, errorMessage } from "../src/errors.js";

test("error messages narrow arbitrary thrown values, including cross-realm errors", () => {
  for (const [value, expected] of [
    [new Error("local"), "local"],
    [vm.runInNewContext('new Error("foreign")'), "foreign"],
    [{ message: "browser failure" }, "browser failure"],
    ["rejected", "rejected"],
    [null, "null"],
    [undefined, "undefined"],
    [0, "0"],
    [false, "false"],
    [Symbol("failure"), "Symbol(failure)"],
    [{ message: 42 }, "[object Object]"],
  ]) {
    assert.equal(errorMessage(value), expected);
  }
});

test("error codes only expose string properties", () => {
  assert.equal(errorCode(Object.assign(new Error("pipe"), { code: "EPIPE" })), "EPIPE");
  assert.equal(errorCode({ code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }), "ERR_PARSE_ARGS_UNKNOWN_OPTION");
  for (const value of [null, undefined, "EPIPE", 0, {}, { code: 42 }]) {
    assert.equal(errorCode(value), undefined);
  }
});
