# fireclerk

A command-line tool to inspect and control your **running** Firefox session:
enumerate tabs (URL, title, container), read page HTML/text, and open or close
tabs — from the real profile you're using, with no restart.

## Why not geckodriver?

geckodriver/Marionette always launches a *fresh* Firefox with a throwaway
profile; it can't attach to your live session, and it doesn't expose container
(`cookieStoreId`) identity. FireClerk instead uses a tiny WebExtension loaded
into your running Firefox, talking to the CLI over Firefox's native-messaging
channel:

```
CLI  ──unix socket──►  native host  ──stdio / native messaging──►  extension  ──►  live tabs
     ◄─────────────    (spawned by Firefox)  ◄──────────────────
```

The extension keeps a persistent native-messaging port open, which keeps the
host process (and its unix socket) alive. The CLI dials that socket, sends one
command, and prints the reply. Requests are tagged with an id so the host can
route each reply back to the right caller.

## Install

```sh
npm run build
npm install -g ./dist/fireclerk-*.tgz
fireclerk --setup
```

`npm run build` creates an installable package tarball in `dist/`. The global
install puts `fireclerk` on your `PATH` through npm's normal `bin` linking.
`fireclerk --setup` writes the Firefox native-messaging pieces from the
installed package copy.

Setup writes a `fireclerk-host` launcher into the same npm bin directory as
`fireclerk`, then writes the native-messaging manifest to the per-user Firefox
location (`~/Library/Application Support/Mozilla/NativeMessagingHosts/` on
macOS). The manifest points at that installed launcher, and the launcher runs the
host from the installed package copy using an absolute Node path.

> **Why install from the tarball instead of linking this repo?** On macOS, TCC
> blocks Firefox from executing files under protected folders — `~/Documents`,
> `~/Desktop`, `~/Downloads`, iCloud Drive. If the host launcher points back
> into a repo checked out under one of those, Firefox can refuse to start it and
> the native port disconnects with **no error**. A normal global npm install
> should place the package and launcher under your npm prefix instead.

Then load the extension into your running Firefox:

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select the extension manifest from the globally installed package. The
   `fireclerk --setup` output prints the exact path.

The add-on stays loaded until you restart Firefox (release builds only allow
*signed* add-ons to install permanently). Re-load it after a restart. In its
**Inspect** console you should see `[fireclerk] connected to host, pid <N>`.

### Permanent install with a signed XPI

Firefox release builds require signed extensions for permanent installation.
For self-distribution, submit the extension package to Mozilla as an **unlisted**
add-on, then attach the signed `.xpi` Mozilla returns to a GitHub Release.

To package the extension for manual upload to the Add-ons Developer Hub:

```sh
npm run extension:zip
```

Upload `web-ext-artifacts/fireclerk-extension-<version>.zip` as an unlisted,
self-distributed add-on. The zip contains `manifest.json` at the archive root,
which is what AMO expects. The manifest includes a stable extension id
(`fireclerk@local`), Firefox's built-in data-collection declaration for browsing
activity and website content, and an `update_url` pointing at this repository's
`updates.json`; after publishing a signed XPI release, update that file with the
release download URL.

If you have AMO API credentials and want to try automated signing instead,
create a local `.secrets` file (ignored by git) with:

```sh
WEB_EXT_API_KEY=...
WEB_EXT_API_SECRET=...
```

Then run:

```sh
npm run extension:sign
```

To repair or refresh the Firefox native-messaging manifest without reinstalling,
run:

```sh
fireclerk --setup
```

## Usage

```sh
fireclerk tabs                 # table: id, window, container, title, url
fireclerk tabs --json          # machine-readable
fireclerk containers           # configured Multi-Account Containers
fireclerk html 7               # outerHTML of tab 7 to stdout
fireclerk html                 # outerHTML of the active tab
fireclerk html 7 --out page.html
fireclerk text 7               # visible innerText of tab 7
fireclerk open https://example.com
fireclerk open                 # open Firefox's default new tab page
fireclerk open https://example.com --background
fireclerk close 7              # close tab 7
fireclerk close 7 8 9          # close multiple tabs
fireclerk wait 7 --status complete
fireclerk wait 7 --selector 'article' --timeout 15000
fireclerk ping                 # check the bridge is alive
```

`tabs` marks the active tab with `*` and shows the container name (`default`,
`private`, or your container's label such as `Work`).

## Security & privacy

FireClerk intentionally grants a local CLI access to your live Firefox session.
With the extension loaded, local same-user processes that can reach the
FireClerk unix socket can list tab URLs/titles, read scriptable page HTML/text,
and open or close tabs. That may include authenticated pages and sensitive
browser state.

Use FireClerk only on machines and user accounts you trust. Do not expose the
socket over the network, do not share captured page HTML/text without reviewing
it, and review all source changes before installing a signed extension update.

## Notes & limits

- **Privileged pages** (`about:`, `addons.mozilla.org`, the add-ons manager,
  view-source) can't be scripted: `html`/`text` either error or return empty
  content (`executeScript` is silently denied there).
- **Containers**: container names come from the `contextualIdentities` API. If
  Multi-Account Containers is disabled, `tabs` still works and falls back to the
  raw `cookieStoreId`; `containers` reports that it's unavailable.
- **Waiting**: `wait` defaults to 10 seconds and accepts a timeout from 1 ms to
  5 minutes. Status waiting supports `complete`; selector waiting safely passes
  CSS selector text as data to the tab's content script.
- **Large pages**: HTML flows extension→host, which Firefox allows up to ~4 GB
  per message, so big pages come through whole.
- The CLI exits non-zero with a readable message if Firefox isn't running or the
  extension isn't loaded.

## Layout

| Path                     | Role                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `extension/`             | WebExtension (manifest + background bridge)                 |
| `src/host.js`            | Native-messaging host ↔ unix-socket bridge                  |
| `src/cli.js`             | The `fireclerk` command                                     |
| `src/protocol.js`        | Shared frame encoding, host name, socket path               |
| `install.js`             | Writes `fireclerk-host` launcher + manifest (`fireclerk --setup`) |
| `test/bridge-test.js`    | End-to-end test that simulates Firefox (`npm test`)         |

## Develop

```sh
npm test    # spawns the host, fakes the extension side, drives the real CLI
```
