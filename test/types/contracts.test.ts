// Compile-only tests. @ts-expect-error must keep producing a compiler error;
// weakening a contract to `any` makes these tests fail. Nothing runs in Firefox.
import { request } from "../../src/client.js";
import type {
  CommandRequest,
  CommandResult,
  CommandHandlers,
  ContentMessage,
  ContentReply,
  ContentHandlers,
  Reply,
} from "../../src/contracts.js";

declare function expectType<T>(value: T): void;

expectType<Promise<CommandResult<"ping">>>(request("ping", {}));
expectType<Promise<CommandResult<"listTabs">>>(request("listTabs", {}));
expectType<Promise<CommandResult<"containers">>>(request("containers", {}));
expectType<Promise<CommandResult<"html">>>(request("html", {}));
expectType<Promise<CommandResult<"text">>>(request("text", { tabId: 7 }));
expectType<Promise<CommandResult<"openTab">>>(request("openTab", { url: "https://example.com", active: false }));
expectType<Promise<CommandResult<"openPrivateWindow">>>(request("openPrivateWindow", { focused: false }));
expectType<Promise<CommandResult<"closeTabs">>>(request("closeTabs", { tabIds: [7] }));
expectType<Promise<CommandResult<"waitTab">>>(request("waitTab", { tabId: 7, timeoutMs: 100, status: "complete" }));
expectType<Promise<CommandResult<"waitTab">>>(request("waitTab", { tabId: 7, timeoutMs: 100, selector: "a" }));
expectType<Promise<CommandResult<"queryTab">>>(request("queryTab", { tabId: 7, selector: "a", mode: "attr", attribute: "href" }));
expectType<Promise<CommandResult<"fetchTab">>>(request("fetchTab", { tabId: 7, url: "/api" }));
expectType<Promise<CommandResult<"capturePage">>>(request("capturePage", {
  sourceTabId: 7, url: "https://example.com", wait: "complete", format: "html", timeoutMs: 100,
}));

// @ts-expect-error Unknown commands cannot enter the bridge.
request("fetch", { tabId: 7, url: "/api" });
// @ts-expect-error A command requiring arguments cannot omit them.
request("closeTabs");
// @ts-expect-error Even an empty argument object cannot bypass required fields.
request("fetchTab", {});
// @ts-expect-error Typo in a property name.
request("openTab", { cookieStore: "firefox-default" });
// @ts-expect-error Tab ids have already been parsed at this boundary.
request("html", { tabId: "7" });
// @ts-expect-error Arguments for a different command are not interchangeable.
request("openPrivateWindow", { tabIds: [7] });
// @ts-expect-error No-argument commands reject stray properties.
request("ping", { tabId: 7 });
// @ts-expect-error Exactly one wait condition is required.
request("waitTab", { tabId: 7, timeoutMs: 100 });
// @ts-expect-error Mutually exclusive wait conditions.
request("waitTab", { tabId: 7, timeoutMs: 100, status: "complete", selector: "a" });
// @ts-expect-error Only the supported status is allowed.
request("waitTab", { tabId: 7, timeoutMs: 100, status: "loading" });
// @ts-expect-error Attribute extraction requires an attribute name.
request("queryTab", { tabId: 7, selector: "a", mode: "attr" });
// @ts-expect-error HTML extraction must not carry attribute arguments.
request("queryTab", { tabId: 7, selector: "a", mode: "html", attribute: "href" });
// @ts-expect-error Capture supports HTML only.
request("capturePage", { sourceTabId: 7, url: "https://example.com", wait: "complete", format: "text", timeoutMs: 100 });

// @ts-expect-error The result is inferred from the command, not chosen by the caller.
expectType<Promise<CommandResult<"fetchTab">>>(request("listTabs", {}));
// @ts-expect-error A handler cannot return another command's response shape.
const badHandler: CommandHandlers["ping"] = async () => ({ closed: [7] });
declare const handlers: CommandHandlers;
// @ts-expect-error Correctly typed handlers still cannot be wired to the wrong slot.
const miswired: CommandHandlers = { ...handlers, html: handlers.text };
// @ts-expect-error Every command must have a handler.
const incomplete: CommandHandlers = { ping: handlers.ping };
// @ts-expect-error Incorrect result field type.
const badResult: CommandResult<"closeTabs"> = { closed: ["7"] };
// @ts-expect-error Keep command and args correlated when forwarding a packet.
const badPacket: CommandRequest = { cmd: "fetchTab", args: { tabIds: [7] } };

const selectorMessage: ContentMessage = { type: "fireclerk:hasSelector", selector: "article" };
const queryMessage: ContentMessage = { type: "fireclerk:query", selector: "a", mode: "attr", attribute: "href" };
const fetchMessage: ContentMessage = { type: "fireclerk:fetch", url: "/api" };
// @ts-expect-error Content-script queries share the same attribute requirement.
const badQueryMessage: ContentMessage = { type: "fireclerk:query", selector: "a", mode: "attr" };
// @ts-expect-error Content-script messages also reject wrong field types.
const badFetchMessage: ContentMessage = { type: "fireclerk:fetch", url: 123 };
// @ts-expect-error Content-script replies have operation-specific contracts.
const badSelectorReply: ContentReply<"fireclerk:hasSelector"> = { matches: [] };
// @ts-expect-error Content handlers must return their own message's result.
const badContentHandler: ContentHandlers["fireclerk:hasSelector"] = () => ({ matches: [] });

declare const reply: Reply<CommandResult<"closeTabs">>;
if (reply.ok) {
  expectType<number[]>(reply.data.closed);
  // @ts-expect-error A successful reply is not an error envelope.
  reply.error;
} else {
  expectType<string>(reply.error);
  // @ts-expect-error Failed replies do not have result data.
  reply.data;
}
