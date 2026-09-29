#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: npm run release -- patch|minor|major

Builds, signs, commits, tags, pushes, and publishes a FireClerk release.
Requires a clean, up-to-date main branch, gh authentication, and AMO API
credentials in .secrets.
EOF
}

case "${1:-}" in
  patch|minor|major)
    bump=$1
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

for command in git gh node npm tar unzip; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command not found: $command" >&2
    exit 1
  fi
done

if [ "$(git branch --show-current)" != "main" ]; then
  echo "releases must be run from the main branch" >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "tracked files must be clean before releasing" >&2
  exit 1
fi

git fetch origin main --tags
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "local main must exactly match origin/main before releasing" >&2
  exit 1
fi
gh auth status >/dev/null

if [ ! -f .secrets ]; then
  echo ".secrets is required for AMO signing" >&2
  exit 1
fi
(
  set -a
  # shellcheck disable=SC1091
  . ./.secrets
  set +a
  test -n "${WEB_EXT_API_KEY:-}" || { echo "WEB_EXT_API_KEY is missing from .secrets" >&2; exit 1; }
  test -n "${WEB_EXT_API_SECRET:-}" || { echo "WEB_EXT_API_SECRET is missing from .secrets" >&2; exit 1; }
)

package_version=$(node --print 'require("./package.json").version')
extension_version=$(node --print 'require("./extension/manifest.json").version')
if [ "$package_version" != "$extension_version" ]; then
  echo "package and extension versions differ: $package_version != $extension_version" >&2
  exit 1
fi

phase=preparing
version=
stage=
restore_on_failure() {
  status=$?
  if [ "$status" -ne 0 ]; then
    if [ "$phase" = preparing ]; then
      git restore package.json extension/manifest.json updates.json 2>/dev/null || true
      if [ -n "$stage" ]; then
        echo "release failed; reusable artifacts, if any, remain in $stage" >&2
      fi
    else
      echo "release failed after creating the release commit or tag; do not bump again" >&2
      echo "inspect git status, the local tag, and $stage before resuming manually" >&2
    fi
  fi
  exit "$status"
}
trap restore_on_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

npm version "$bump" --no-git-tag-version >/dev/null
version=$(node --print 'require("./package.json").version')
tag="v$version"
stage="dist/release-$version"
mkdir -p "$stage"

if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "tag already exists: $tag" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  echo "remote tag already exists: $tag" >&2
  exit 1
fi
if gh release view "$tag" >/dev/null 2>&1; then
  echo "GitHub release already exists: $tag" >&2
  exit 1
fi

node scripts/release-metadata.js "$version"
npm test
npm run extension:lint
npm run build

package="dist/fireclerk-$version.tgz"
versioned_package="$stage/fireclerk-$version.tgz"
stable_package="$stage/fireclerk.tgz"
cp "$package" "$versioned_package"
cp "$package" "$stable_package"

existing_xpi=$(find "$stage" -maxdepth 1 -type f -name "*-$version.xpi" -print | head -n 1)
if [ -n "$existing_xpi" ]; then
  echo "Reusing previously signed extension: $existing_xpi"
  xpi=$existing_xpi
else
  rm -rf web-ext-artifacts
  mkdir -p web-ext-artifacts
  npm run extension:sign
  xpi_count=$(find web-ext-artifacts -maxdepth 1 -type f -name "*-$version.xpi" | wc -l | tr -d ' ')
  if [ "$xpi_count" -ne 1 ]; then
    echo "expected one signed XPI for $version, found $xpi_count" >&2
    find web-ext-artifacts -maxdepth 1 -type f -print >&2
    exit 1
  fi
  signed_xpi=$(find web-ext-artifacts -maxdepth 1 -type f -name "*-$version.xpi" -print)
  xpi="$stage/$(basename "$signed_xpi")"
  cp "$signed_xpi" "$xpi"
fi
stable_xpi="$stage/fireclerk.xpi"
cp "$xpi" "$stable_xpi"

xpi_name=$(basename "$xpi")
node scripts/release-metadata.js "$version" "$xpi_name"

tar_version=$(tar -xOf "$versioned_package" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')
xpi_version=$(unzip -p "$xpi" manifest.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')
if [ "$tar_version" != "$version" ] || [ "$xpi_version" != "$version" ]; then
  echo "artifact version mismatch: package=$tar_version extension=$xpi_version expected=$version" >&2
  exit 1
fi

git add package.json extension/manifest.json updates.json
git commit -m "Release $tag"
phase=committed
git tag --annotate "$tag" --message "FireClerk $version"

git push --atomic origin main "$tag"
phase=pushed

gh release create "$tag" \
  "$versioned_package#Versioned Node package" \
  "$xpi#Versioned signed Firefox extension" \
  "$stable_package#Latest Node package" \
  "$stable_xpi#Latest signed Firefox extension" \
  "install-fireclerk.sh#CLI installer and updater" \
  --verify-tag \
  --title "FireClerk $version" \
  --generate-notes

phase=published
trap - EXIT INT TERM
printf 'Published FireClerk %s: https://github.com/dotandimet/fireclerk/releases/tag/%s\n' "$version" "$tag"
