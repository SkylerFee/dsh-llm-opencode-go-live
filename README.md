# @skylerfee/dsh-llm-opencode-go-live

English | [中文](README.zh.md)

[![CI](https://github.com/SkylerFee/dsh-llm-opencode-go-live/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SkylerFee/dsh-llm-opencode-go-live/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: >=22.19](https://img.shields.io/badge/Node-%3E%3D22.19-brightgreen.svg)](https://nodejs.org) [![Release: v0.1.0-alpha.5](https://img.shields.io/badge/release-v0.1.0--alpha.5-orange.svg)](https://github.com/SkylerFee/dsh-llm-opencode-go-live/releases)

An OpenCode Go live model catalog plugin for DeepSeek Harness. It reads the `opencode-go` catalog from Models.dev, registers the separate `opencode-go-live` route, contributes its own Models settings card, and uses pi-ai for model requests. The built-in `opencode-go` route remains available. A switch in that card renders the OpenCode Go subscription usage in a frame-wide floating panel.

## Quick Start

Node.js 22.19 or newer (the floor pi-ai declares), pnpm, and DeepSeek Harness 0.1.7-rc.1 or newer are required. The plugin's peers are `@deepseek-ai/cordis` `~4.0.4` together with `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-pi-ai` and `@deepseek-ai/dsh-settings` at `>=0.1.7-rc.1` — the image-input hooks it wires in ship in those versions. The host must also provide `@earendil-works/pi-ai` `^0.87.1`: DSH resolves this peer to the host's pi-ai at runtime, including linked source installs. The plugin keeps pi-ai `0.87.1` as a development dependency for its own build and tests.

Install from npm (recommended) into the Web profile with the installed `dsh` CLI:

```sh
dsh plugin --profile web add @skylerfee/dsh-llm-opencode-go-live
```

This installs the npm `latest` tag. To follow prereleases, append `@alpha`; to pin this release, append `@0.1.0-alpha.5`. When running DSH from source, use `pnpm dsh plugin --profile web add @skylerfee/dsh-llm-opencode-go-live` from the DSH repository root. The [usage guide](docs/usage.md#install-from-npm) covers npm installation and the source-checkout and tarball alternatives for development.

Installing the package and enabling it from the Web client's plugin page:

![Installing and enabling the plugin from the Web client's plugin page](docs/img/install-plugin.gif)

Restart the Web profile. Open **Settings → Models**, click **Edit** in the plugin-owned **OpenCode Go (Live)** card, enter your API key, and apply it. Choose a model under `opencode-go-live` in the model picker. DSH stores the key through its credentials service under the default reference `OPENCODE_GO_LIVE_API_KEY`, which is deliberately distinct from the `OPENCODE_GO_API_KEY` that the Models page derives for the built-in `opencode-go` route, so the two routes never share one credential record. The bundle stores a catalog snapshot at `cache/opencode-go-live.json` under the Harness home — `~/.dsh/cache/opencode-go-live.json` by default, or under `$DSH_HOME` when that variable is set. Installation does not change the default model.

The card's **Show usage overlay** switch controls a bottom-right usage panel (default on when unconfigured). It shows the OpenCode Go subscription usage percent and reset time for the rolling 5-hour, weekly, and monthly windows; it appears as a bottom-right chip (5-hour bar and usage percent) that expands into the full panel on hover and collapses when the mouse leaves; the chip is draggable while unpinned, the pin button toggles pinning (filled = pinned, hollow = unpinned, off by default), and its × turns that switch off in step. The host queries `https://opencode.ai/zen/go/v1/usage` with the same credential. That endpoint does not appear in OpenCode's public documentation and is an upstream implementation convention. The key resolves only on the host and never reaches the browser. Field reference and troubleshooting live in the [usage guide](docs/usage.md#usage-overlay).

The overlay in the browser — the chip expands into the full panel on hover and collapses when the mouse leaves:

![The usage overlay chip expanding into the full panel](docs/img/usage-view.gif)

The plugin's card in **Settings → Models** — saving the API key in the editor, the dynamic model list after the catalog resolves, and the live models in their own group in the model picker, with the reasoning level beside them:

![Saving the API key in the OpenCode Go (Live) card and choosing a live model in the model picker](docs/img/add-key.gif)

## Documentation

- [Usage guide](docs/usage.md): installation, key setup, configuration, and troubleshooting.
- [Architecture](docs/opencode-go-live-dynamic-catalog-design.md): component responsibilities, Mermaid data-flow and sequence diagrams, catalog refresh, and request behavior.
- [Usage overlay design](docs/opencode-go-live-balance-overlay-design.md): data-source contract, the host balance route, the display switch, and the test plan.
- [Development and release](docs/development-and-release.md): feature and bug-fix PRs, verification, version tags, and GitHub pre-releases.

The plugin requires the DSH `llm` and `credentials` services; the Web settings page also uses `settings`, and the usage overlay additionally needs the browser carrier `connection` (without it the plugin runs normally and simply registers no balance route). A failed refresh retains the last successful catalog. With no catalog, the provider remains visible but has no live models. Calls without a credential return `MISSING_CREDENTIAL`. A visible model does not establish that the upstream API will authorize its requests.

Image inputs (a `read_image` tool result or a pasted screenshot) are resolved through the host's durable attachment service, exactly as on the built-in routes; when no attachment service is mounted, a request carrying an image fails with `UNSUPPORTED_CONTENT` instead of silently dropping it. File attachments never reach any provider as bytes: request assembly projects every file block to deterministic handle text on all routes. Declared input modalities follow the remote catalog's `modalities.input` (text and image), and a model that declares no image input receives text-only image placeholders.

## Verification

**Verified on macOS only.** The plugin's installation, the catalog refresh against the live Models.dev source, the Models settings card, and model calls were all exercised on a single macOS machine; Linux and Windows have not been run.

CI executes the build and the offline test suite on `ubuntu-latest`. That is a build signal, not a runtime verification: the tests use fixed catalog doubles, and no automated run reaches the real OpenCode Go API.

## License

MIT © 2026 SkylerFee — see [LICENSE](LICENSE).
