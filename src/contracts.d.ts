// Shared wire contracts. These describe JSON messages, not runtime validators.
// Keep browser-specific and CLI-only types out of this module.

export type NoArgs = Record<string, never>;
export type ContentKind = "html" | "text";
export interface TabTarget { tabId?: number }

export interface TabInfo {
  id?: number;
  windowId?: number;
  index: number;
  active: boolean;
  incognito: boolean;
  pinned: boolean;
  title?: string;
  url?: string;
  cookieStoreId?: string;
  container: string;
  containerColor: string | null;
  containerIcon: string | null;
  status?: string;
  lastAccessed?: number;
}

export interface ContainerInfo {
  cookieStoreId: string;
  name: string;
  color: string;
  colorCode: string;
  icon: string;
  iconUrl: string;
}

export interface OpenTabArgs {
  url?: string;
  active?: boolean;
  windowId?: number;
  cookieStoreId?: string;
}

export interface OpenPrivateWindowArgs {
  url?: string;
  focused?: boolean;
}

export type WaitCondition =
  | { status: "complete"; selector?: never }
  | { selector: string; status?: never };
export type WaitArgs = WaitCondition & { tabId: number; timeoutMs: number };
export interface WaitResult {
  tabId: number;
  condition: WaitCondition;
  elapsedMs: number;
}

export type QuerySelection = { selector: string; all?: boolean } & (
  | { mode: "html" | "text"; attribute?: never }
  | { mode: "attr"; attribute: string }
);
export type QueryArgs = QuerySelection & { tabId: number };
export interface QueryResult {
  tabId: number;
  url?: string;
  selector: string;
  mode: "html" | "text" | "attr";
  matches: (string | null)[];
}

export interface FetchArgs { tabId: number; url: string }
export interface FetchResult {
  status: number;
  statusText: string;
  url: string;
  contentType: string;
  headers: Record<string, string>;
  bodyEncoding: "base64";
  byteLength: number;
  body: string;
}

export interface CaptureArgs {
  sourceTabId: number;
  url: string;
  wait: "complete";
  format: "html";
  timeoutMs: number;
}
export interface CaptureResult {
  sourceTabId: number;
  temporaryTabId: number;
  finalUrl?: string;
  containerId?: string;
  format: "html";
  byteLength: number;
  content: string;
  cleanup: { closed: true; tabId: number };
}
export interface ContentResult<K extends ContentKind = ContentKind> {
  tabId: number;
  url?: string;
  title?: string;
  kind: K;
  content: string;
}

// Adding an API command here requires a corresponding background handler.
export interface CommandApi {
  ping: {
    args: NoArgs;
    result: { pong: true; extensionVersion: string; privateAccess: boolean | null };
  };
  listTabs: { args: NoArgs; result: TabInfo[] };
  containers: { args: NoArgs; result: ContainerInfo[] };
  html: { args: TabTarget; result: ContentResult<"html"> };
  text: { args: TabTarget; result: ContentResult<"text"> };
  openTab: { args: OpenTabArgs; result: TabInfo };
  openPrivateWindow: {
    args: OpenPrivateWindowArgs;
    result: TabInfo & { windowFocused: boolean };
  };
  closeTabs: { args: { tabIds: number[] }; result: { closed: number[] } };
  waitTab: { args: WaitArgs; result: WaitResult };
  queryTab: { args: QueryArgs; result: QueryResult };
  fetchTab: { args: FetchArgs; result: FetchResult & { tabId: number } };
  capturePage: { args: CaptureArgs; result: CaptureResult };
}
export type Command = keyof CommandApi;
export type CommandArgs<K extends Command> = CommandApi[K]["args"];
export type CommandResult<K extends Command> = CommandApi[K]["result"];
export type CommandHandlers = {
  [K in Command]: (args: CommandArgs<K>) => Promise<CommandResult<K>>;
};
export type CommandRequest = {
  [K in Command]: { cmd: K; args: CommandArgs<K> }
}[Command];
export type NativeRequest = CommandRequest & { id: number };
export type Reply<T> =
  | { id: number; ok: true; data: T }
  | { id: number; ok: false; error: string };
export interface HostHello { event: "hello"; pid: number }

export interface ContentApi {
  "fireclerk:hasSelector": { args: { selector: string }; result: { matched: boolean } };
  "fireclerk:query": { args: QuerySelection; result: { matches: (string | null)[] } };
  "fireclerk:fetch": { args: { url: string }; result: FetchResult };
}
export type ContentMessage<K extends keyof ContentApi = keyof ContentApi> = {
  [P in K]: { type: P } & ContentApi[P]["args"]
}[K];
export type ContentReply<K extends keyof ContentApi> = ContentApi[K]["result"];
export type ContentHandlers = {
  [K in keyof ContentApi]: (args: ContentApi[K]["args"]) => ContentReply<K> | Promise<ContentReply<K>>;
};
