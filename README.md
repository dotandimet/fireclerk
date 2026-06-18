# fireclerk

A command-line tool to inspect your **running** Firefox session: enumerate tabs
(URL, title, container) and read page HTML — from the real profile you're using,
with no restart.

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
npm run setup
```

This copies a self-contained host (`host.js` + `protocol.js` + a launcher) into
`~/.local/share/fireclerk/` and writes the native-messaging manifest to the
per-user Firefox location (`~/Library/Application Support/Mozilla/NativeMessagingHosts/`
on macOS). Because the host is a **copy**, re-run `npm run setup` after editing
`src/host.js` or `src/protocol.js`.

> **Why a copy outside the repo?** On macOS, TCC blocks Firefox from executing
> files under protected folders — `~/Documents`, `~/Desktop`, `~/Downloads`,
> iCloud Drive. If the launcher lived in a repo checked out under one of those,
> Firefox would refuse to start it and the native port would disconnect with
> **no error** (a long red herring to debug). `~/.local/share` is not protected,
> so the host runs reliably from there. Your Node must also live outside those
> folders (it normally does, e.g. under `~/.local` or `/usr/local`).

Then load the extension into your running Firefox:

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select `extension/manifest.json`

The add-on stays loaded until you restart Firefox (release builds only allow
*signed* add-ons to install permanently). Re-load it after a restart. In its
**Inspect** console you should see `[fireclerk] connected to host, pid <N>`.

`npm run setup` also symlinks the CLI to `~/.local/bin/fireclerk` (pointing at
`src/cli.js`, so edits stay live). If `~/.local/bin` isn't on your `PATH`, the
installer prints the line to add.

## Usage

```sh
fireclerk tabs                 # table: id, window, container, title, url
fireclerk tabs --json          # machine-readable
fireclerk containers           # configured Multi-Account Containers
fireclerk html 7               # outerHTML of tab 7 to stdout
fireclerk html                 # outerHTML of the active tab
fireclerk html 7 --out page.html
fireclerk text 7               # visible innerText of tab 7
fireclerk ping                 # check the bridge is alive
```

`tabs` marks the active tab with `*` and shows the container name (`default`,
`private`, or your container's label such as `Work`).

## Notes & limits

- **Privileged pages** (`about:`, `addons.mozilla.org`, the add-ons manager,
  view-source) can't be scripted: `html`/`text` either error or return empty
  content (`executeScript` is silently denied there).
- **Containers**: container names come from the `contextualIdentities` API. If
  Multi-Account Containers is disabled, `tabs` still works and falls back to the
  raw `cookieStoreId`; `containers` reports that it's unavailable.
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
| `install.js`             | Writes host manifest + launcher (`npm run setup`)           |
| `test/bridge-test.js`    | End-to-end test that simulates Firefox (`npm test`)         |

## Develop

```sh
npm test    # spawns the host, fakes the extension side, drives the real CLI
```
