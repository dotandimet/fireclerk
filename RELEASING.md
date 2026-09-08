# Releasing FireClerk

Releases are produced by the manual **Release** GitHub Actions workflow. The
workflow keeps the Node package and Firefox extension on the same version,
signs the extension through addons.mozilla.org, tags the release commit, and
publishes both artifacts to GitHub Releases.

## One-time repository setup

Configure the AMO API credentials as GitHub Actions secrets. If `.secrets`
contains the local `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` values:

```sh
set -a
. ./.secrets
set +a
printf %s "$WEB_EXT_API_KEY" | gh secret set WEB_EXT_API_KEY
printf %s "$WEB_EXT_API_SECRET" | gh secret set WEB_EXT_API_SECRET
unset WEB_EXT_API_KEY WEB_EXT_API_SECRET
```

The workflow requires `contents: write` permission. In repositories that limit
the default token, allow GitHub Actions to create and push release commits and
tags.

## Run a release

Start from a green `main` branch, then choose a semantic-version increment:

```sh
gh workflow run Release --ref main --field bump=patch
# or: bump=minor / bump=major
```

Watch the run and surface any failing step:

```sh
run_id=$(gh run list --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$run_id" --exit-status
```

The workflow performs these steps in order:

1. bumps `package.json` and `extension/manifest.json`;
2. runs the complete test suite and extension lint;
3. builds `dist/fireclerk-VERSION.tgz`;
4. signs the extension through AMO;
5. adds the signed XPI URL to `updates.json`;
6. commits the version metadata and creates `vVERSION`;
7. pushes the release commit and tag;
8. creates a GitHub release containing versioned artifacts plus stable
   `fireclerk.tgz`, `fireclerk.xpi`, and `install-fireclerk.sh` aliases.

No npm-registry publication occurs. Users install or update the Node package
through the release-hosted installer documented in `README.md`.

## Failure handling

Failures before **Commit and tag release** do not change the repository and can
be rerun with the same bump. The workflow retains all release files as a run artifact.
If the final GitHub release step fails after the commit and tag were pushed,
download `fireclerk-release-VERSION` with `gh run download RUN_ID` and create the
release for that existing tag rather than bumping again.
