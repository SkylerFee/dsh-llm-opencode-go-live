# Development and release workflow

English | [中文](development-and-release.zh.md)

This repository currently delivers the plugin through GitHub `v*` tags and pre-releases; it is not published to a registry. Both features and bug fixes start from the latest `main` on short-lived branches and merge through pull requests. There is no long-lived release branch for older versions today.

## Develop and merge

1. Create a `feat/short-name` or `fix/short-name` branch from the latest `main`; do not push directly to `main`. For a bug fix, establish the root cause and add a regression test that reproduces the original failure. Add tests for non-trivial new behavior. When configuration, routes, caching, or model fields change, update the affected English and Chinese documentation together.
2. Run `pnpm run check` in this repository. For installation or packaging changes, also run `pnpm pack --dry-run` and inspect the package for `node_modules/`, tests, or sensitive data. For user-visible model or settings behavior, exercise the affected path in a DSH Web profile and identify any real-API or runtime checks that were not run in the PR.
3. Open a PR against `main` that states the behavior change, verification results, and known limitations. The current [repository rules](https://github.com/SkylerFee/dsh-llm-opencode-go-live/rules) require a PR and a passing GitHub Actions `check` job, with zero required approvals. CI builds and runs offline tests on Node.js 22; it does not contact Models.dev or the real OpenCode Go API.
4. Merge after `check` passes. The current rule does not require the PR branch to stay up to date with `main`; if `main` advances while the PR waits, update the branch and confirm the check passes again. After merging, wait for the `main` push CI to pass before preparing a release from its final commit.

## Prepare and publish a version

1. Select the merged changes for this release and increment the prerelease version in `package.json`. The next version can be `0.1.0-alpha.4`. Update the version badge and install command in both READMEs, the tag and tarball examples in both usage guides, and the release notes. A single change may carry the version update in its PR; use a separate release PR when grouping several changes.
2. The release PR must also pass `check`. Before tagging, run `pnpm pack --dry-run` and install from the local checkout or tarball into a DSH Web profile to verify plugin loading, catalog refresh, the settings page, and model calls as applicable. Offline CI does not replace these runtime checks; list any checks that could not be run in the release notes.
3. After the release PR merges and the `main` CI passes, update local `main` to that commit, then create and push a new tag that matches `package.json`:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v0.1.0-alpha.4 -m "v0.1.0-alpha.4"
   git push origin v0.1.0-alpha.4
   ```

4. Select the existing tag in [GitHub Releases](https://github.com/SkylerFee/dsh-llm-opencode-go-live/releases), create a Pre-release, and describe additions, fixes, and verification. There is no automated release workflow or registry package today; a GitHub Release source archive is not a `pnpm pack` artifact.
5. Install the new tag into a DSH Web profile using the [usage guide](usage.md#install-from-github). Restart the profile, confirm that `lib/index.js` exists and the provider and models appear, and make a real model call where the change warrants it. Record what was verified for that tag.

## Fix a released version

An urgent bug fix still starts from the latest `main` on a `fix/` branch and goes through the same PR, CI, and release steps with a new tag. Existing `v*` tags cannot be updated or deleted under the current rule. To roll back, reinstall the previous working tag, then deliver the fix in a new version. Add a maintenance branch only when older versions need parallel support.
