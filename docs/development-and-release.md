# Development and release workflow

English | [中文](development-and-release.zh.md)

This repository delivers the plugin through GitHub `v*` tags and Releases; after npm is initialized, `.github/workflows/publish.yml` publishes the corresponding npm version when a GitHub Release is published. Both features and bug fixes start from the latest `main` on short-lived branches and merge through pull requests. There is no long-lived release branch for older versions today.

## Develop and merge

1. Create a `feat/short-name` branch from the latest `main` for a feature or documentation improvement, or a `fix/short-name` branch for a bug fix; do not push directly to `main`. For a bug fix, establish the root cause and add a regression test that reproduces the original failure. Add tests for non-trivial new behavior. When configuration, routes, caching, or model fields change, update the affected English and Chinese documentation together.
2. Run `pnpm run check` in this repository. For installation or packaging changes, also run `pnpm pack --dry-run` and inspect the package for `node_modules/`, tests, or sensitive data. For user-visible model or settings behavior, exercise the affected path in a DSH Web profile and identify any real-API or runtime checks that were not run in the PR.
3. Open a PR against `main` that states the behavior change, verification results, and known limitations. The current [repository rules](https://github.com/SkylerFee/dsh-llm-opencode-go-live/rules) require a PR and a passing GitHub Actions `check` job, with zero required approvals. CI builds and runs offline tests on Node.js 22; it does not contact Models.dev or the real OpenCode Go API.
4. Merge after `check` passes. The current rule does not require the PR branch to stay up to date with `main`; if `main` advances while the PR waits, update the branch and confirm the check passes again. After merging, wait for the `main` push CI to pass before preparing a release from its final commit.

## Initialize npm once

The package name is `@skylerfee/dsh-llm-opencode-go-live`. The publisher needs an npm account with account-level two-factor authentication and publishing access to the `@skylerfee` user or organization scope. A GitHub username does not establish ownership of an npm scope.

A Trusted Publisher can only be configured for an existing registry package. If the package does not exist, log in and publish it once from a release-tag checkout that passed `main` CI. These commands apply to the current alpha version; do not publish from a development checkout with uncommitted changes:

```sh
npm login --registry=https://registry.npmjs.org
pnpm install --frozen-lockfile
pnpm run check
pnpm pack --dry-run
npm publish --access public --tag alpha
```

Then open the npm package's **Settings → Trusted Publisher**, select **GitHub Actions**, enter these values, and allow direct `npm publish`:

| Field | Value |
| --- | --- |
| Organization or user | `SkylerFee` |
| Repository | `dsh-llm-opencode-go-live` |
| Workflow filename | `publish.yml`, filename only |
| Environment name | Leave empty |
| Allowed actions | Enable `npm publish` |

The workflow uses a GitHub-hosted runner and OIDC, with no `NPM_TOKEN` secret. After the first local publish, use automation for the next unpublished version; a published package name and version cannot be published again. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Prepare and publish a version

1. Select the merged changes for this release and increment the prerelease version in `package.json`. The next version can be `0.1.0-alpha.6`. Update the version badge in both READMEs, the tarball examples in both usage guides, and the release notes. A single change may carry the version update in its PR; use a separate release PR when grouping several changes.
2. The release PR must also pass `check`. Before tagging, run `pnpm pack --dry-run` and install from the local checkout or tarball into a DSH Web profile to verify plugin loading, catalog refresh, the settings page, and model calls as applicable. Offline CI does not replace these runtime checks; list any checks that could not be run in the release notes.
3. After the release PR merges and the `main` CI passes, update local `main` to that commit, then create and push a new tag that matches `package.json`:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v0.1.0-alpha.6 -m "v0.1.0-alpha.6"
   git push origin v0.1.0-alpha.6
   ```

4. Select the existing tag in [GitHub Releases](https://github.com/SkylerFee/dsh-llm-opencode-go-live/releases) and create a Pre-release, or a regular Release for a stable version. Write the release notes in both English and Chinese; each language must cover the same additions, fixes, verification scope, and checks not run. Publishing the Release triggers the `发布 npm 包` workflow: it checks that the tag commit belongs to `main`, that the tag equals `v` followed by the package version, and that the Release prerelease status agrees with the version, then installs frozen dependencies, builds and tests, inspects the package, and publishes using OIDC. A prerelease uses its first prerelease identifier as the npm tag (`0.1.0-alpha.6` uses `alpha`); a stable version uses `latest`. A GitHub Release source archive is not the npm package.
5. Confirm that `发布 npm 包` succeeded in [Actions](https://github.com/SkylerFee/dsh-llm-opencode-go-live/actions) and query the new version with `npm view @skylerfee/dsh-llm-opencode-go-live@0.1.0-alpha.6 version --registry=https://registry.npmjs.org`. Install the published package into a DSH Web profile using the [usage guide](usage.md#install-from-npm). Restart the profile, confirm that `lib/index.js` exists and the provider and models appear, and make a real model call where the change warrants it. Record what was verified for that version. The version first published locally does not need another workflow run; automation starts with later versions.

## Fix a released version

An urgent bug fix still starts from the latest `main` on a `fix/` branch and goes through the same PR, CI, and release steps with a new tag. Existing `v*` tags cannot be updated or deleted under the current rule. To roll back, reinstall the previous working tag, then deliver the fix in a new version. Add a maintenance branch only when older versions need parallel support.
