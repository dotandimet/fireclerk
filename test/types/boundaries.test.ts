// Compile-only regressions: unchecked external values must be narrowed.
import { errorCode, errorMessage } from "../../src/errors.js";
import { createFrameReader } from "../../src/protocol.js";

declare function expectType<T>(value: T): void;
declare const externalError: unknown;

expectType<string>(errorMessage(externalError));
expectType<string | undefined>(errorCode(externalError));
// @ts-expect-error Error messages cannot leak an unchecked value.
expectType<number>(errorMessage(externalError));
// @ts-expect-error Error codes cannot leak an unchecked value.
expectType<number>(errorCode(externalError));

createFrameReader((message) => {
  // @ts-expect-error Decoding JSON is not validation of a reply.
  message.ok;
  // @ts-expect-error Consumers must narrow or assert their wire contract.
  expectType<{ id: number }>(message);
});
// @ts-expect-error Frame readers cannot promise a prevalidated message shape.
createFrameReader((message: { ok: boolean }) => { void message; });

try {
  throw externalError;
} catch (error) {
  // @ts-expect-error Strict catch variables must not permit unchecked access.
  error.message;
  expectType<string>(errorMessage(error));
}
