#!/bin/sh
set -eu

repository="dotandimet/fireclerk"
prefix="${FIRECLERK_PREFIX:-${HOME:?HOME is not set}/.local}"
package_url="${FIRECLERK_PACKAGE_URL:-https://github.com/${repository}/releases/latest/download/fireclerk.tgz}"
bin_dir="$prefix/bin"
cli="$bin_dir/fireclerk"

if ! command -v node >/dev/null 2>&1; then
  echo "FireClerk requires Node.js 18 or newer, but node was not found." >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "FireClerk requires Node.js 18 or newer." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "FireClerk requires npm, but npm was not found." >&2
  exit 1
fi

mkdir -p "$prefix"
export FIRECLERK_PREFIX="$prefix"
npm install --global --prefix "$prefix" "$package_url"

if [ ! -x "$cli" ]; then
  echo "npm completed, but $cli was not created." >&2
  exit 1
fi

"$cli" --setup

printf '\nFireClerk is installed at %s\n' "$cli"
case ":${PATH:-}:" in
  *:"$bin_dir":*)
    printf 'The command is available on the current PATH.\n'
    ;;
  *)
    printf '%s\n' "Add this line to your shell profile, then restart your terminal or Herdr:"
    printf '  export PATH="%s:%sPATH"\n' "$bin_dir" '$'
    ;;
esac
printf '%s\n' "Update later by running this installer again."
printf '%s\n' "After an update, restart Firefox so it launches the updated native host."
