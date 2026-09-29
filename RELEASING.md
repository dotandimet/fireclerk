# Release FireClerk locally

FireClerk releases are built and published from the maintainer's machine. The
release script keeps the Node package and Firefox extension on the same version,
signs the extension through addons.mozilla.org, and publishes the artifacts with
GitHub CLI.

## Prerequisites

Before releasing:

- check out `main`;
- install `node`, `npm`, `git`, `gh`, `tar`, and `unzip`;
- authenticate GitHub CLI with `gh auth login`;
- ensure local `main` exactly matches `origin/main`;
- keep tracked files clean.

Untracked local files do not block a release and are never committed by the
script.

Create `.secrets` in the repository root with the AMO signing credentials:

```sh
WEB_EXT_API_KEY=...
WEB_EXT_API_SECRET=...
```

`.secrets` is ignored by Git. The credentials remain local and are loaded only
by `npm run extension:sign`.

## Publish a release

Choose the semantic-version increment:

```sh
npm run release -- patch
# or: minor / major
```

The script performs these steps:

1. fetches `origin/main` and tags, then verifies the local checkout;
2. bumps `package.json` and `extension/manifest.json`;
3. runs the complete test suite and extension lint;
4. builds the Node package;
5. signs the Firefox extension through AMO;
6. updates `updates.json` with the versioned signed-XPI URL;
7. verifies the versions embedded in both artifacts;
8. commits the release metadata and creates an annotated `vVERSION` tag;
9. atomically pushes `main` and the tag;
10. creates the GitHub release with these assets:
    - `fireclerk-VERSION.tgz` and `fireclerk-VERSION.xpi`;
    - stable `fireclerk.tgz` and `fireclerk.xpi` aliases;
    - `install-fireclerk.sh`.

No npm-registry publication occurs. Users install and update through the
release-hosted installer documented in `README.md`.

## Recover from a failed release

Before the release commit is created, a failure restores `package.json`,
`extension/manifest.json`, and `updates.json`. Any signed extension is retained
under `dist/release-VERSION/`, so rerunning the same bump reuses it instead of
submitting the same version to AMO again.

After the release commit or tag is created, the script does not rewrite history
or bump again. Inspect the local commit, tag, remote state, and retained files in
`dist/release-VERSION/`, then finish the failed push or `gh release create`
operation manually.
