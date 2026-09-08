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

## Install or update

FireClerk requires Node.js 18 or newer and npm. Install the latest released CLI
into `~/.local`, then configure Firefox native messaging, with one command:

```sh
curl -fsSL https://github.com/dotandimet/fireclerk/releases/latest/download/install-fireclerk.sh | sh
```

Rerun the same command whenever you want to update, then restart Firefox so it
launches the updated native host. The installer downloads the latest released
Node package—not a repository checkout—installs `fireclerk` and
`fireclerk-host` under `~/.local/bin`, and runs `fireclerk --setup`.

`~/.local/bin` must be on `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Add that line to your shell profile if necessary. Herdr panes inherit Herdr's
`PATH`: if `~/.local/bin` was already present when Herdr started, installed and
updated commands are available in every pane immediately. Otherwise, add it to
your profile and restart Herdr once.

`fireclerk --setup` deliberately refuses to configure a development checkout.
It writes a launcher beside the installed CLI and a per-user Firefox native
messaging manifest whose paths point only into the installed release package.
Run it again to repair that configuration:

```sh
fireclerk --setup
```

### Install the Firefox extension

Install the latest Mozilla-signed extension once from:

<https://github.com/dotandimet/fireclerk/releases/latest/download/fireclerk.xpi>

The stable extension ID and `updates.json` allow Firefox to update later signed
versions automatically. The Node installer does not modify Firefox extensions.

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
fireclerk query 7 'article' --html
fireclerk query 7 'a' --attr href --all --json
fireclerk fetch --tab 7 '/api/transcript' --out transcript.json
fireclerk capture https://example.com/report --container-of 7 --wait complete --format html --out report.html
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
- **DOM queries**: `query` supports only CSS selection and HTML, text, or
  attribute extraction in the top-level document. It does not evaluate caller
  JavaScript or traverse frames and shadow roots.
- **Authenticated fetches**: `fetch` performs credentialed GET requests in the
  selected tab's container context. Targets must be same-origin HTTP(S),
  redirects are not followed, sensitive headers are removed, and responses are
  limited to 10 MiB. Binary bodies use base64 on the bridge and are decoded by
  `--out` without modification.
- **Atomic capture**: `capture` opens one inactive temporary tab in the source
  tab's exact container and window, waits up to 10 seconds by default, captures
  HTML, and closes only that temporary tab in a guaranteed cleanup path.
  `--out` writes a temporary file beside the destination and atomically replaces
  any existing destination only after the complete capture has been written.
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

## Release

See [`RELEASING.md`](RELEASING.md) for the repeatable GitHub Actions pipeline
that versions, tests, builds, signs, tags, pushes, and publishes both artifacts.
