# @skylerfee/dsh-llm-opencode-go-live

English | [中文](README.zh.md)

[![CI](https://github.com/SkylerFee/dsh-llm-opencode-go-live/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SkylerFee/dsh-llm-opencode-go-live/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: >=22.19](https://img.shields.io/badge/Node-%3E%3D22.19-brightgreen.svg)](https://nodejs.org) [![Release: v0.1.0-alpha.5](https://img.shields.io/badge/release-v0.1.0--alpha.5-orange.svg)](https://github.com/SkylerFee/dsh-llm-opencode-go-live/releases)

An OpenCode Go live model catalog plugin for DeepSeek Harness. It reads the `opencode-go` catalog from Models.dev, registers the separate `opencode-go-live` route, contributes its own Models settings card, and uses pi-ai for model requests. The built-in `opencode-go` route remains available.

## Quick Start

Node.js 22.19 or newer (the floor pi-ai declares), pnpm, and DeepSeek Harness 0.1.7-rc.1 or newer are required. The plugin's peers are `@deepseek-ai/cordis` `~4.0.4` together with `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-pi-ai` and `@deepseek-ai/dsh-settings` at `>=0.1.7-rc.1` — the image-input hooks it wires in ship in those versions. The host must also provide `@earendil-works/pi-ai` `^0.87.1`: DSH resolves this peer to the host's pi-ai at runtime, including linked source installs. The plugin keeps pi-ai `0.87.1` as a development dependency for its own build and tests. From the DSH repository root, clone the default `main` branch beside DSH, build it, and install that directory into the Web profile:

```sh
git clone https://github.com/SkylerFee/dsh-llm-opencode-go-live.git ../dsh-llm-opencode-go-live
pnpm --dir ../dsh-llm-opencode-go-live install
pnpm --dir ../dsh-llm-opencode-go-live run check
pnpm dsh plugin --profile web add ../dsh-llm-opencode-go-live
```

Keep the plugin checkout in place: the profile links to it. The [usage guide](docs/usage.md#install-from-source) also covers an already-cloned checkout and a standalone tarball; after the first npm publish, use its [npm installation instructions](docs/usage.md#install-from-npm).

Restart the Web profile. Open **Settings → Models**, click **Edit** in the plugin-owned **OpenCode Go (Live)** card, enter your API key, and apply it. Choose a model under `opencode-go-live` in the model picker. DSH stores the key through its credentials service under the default reference `OPENCODE_GO_LIVE_API_KEY`, which is deliberately distinct from the `OPENCODE_GO_API_KEY` that the Models page derives for the built-in `opencode-go` route, so the two routes never share one credential record. The bundle stores a catalog snapshot at `cache/opencode-go-live.json` under the Harness home — `~/.dsh/cache/opencode-go-live.json` by default, or under `$DSH_HOME` when that variable is set. Installation does not change the default model.

The plugin's card in **Settings → Models** — the key editor, and the dynamic model list after the catalog resolves:

![Editing the OpenCode Go (Live) card in Settings → Models](docs/img/edit.png)

![The OpenCode Go (Live) card with its dynamic model list expanded](docs/img/view.png)

In a session, the live models sit in their own group in the model picker, with the reasoning level beside them:

![Model picker showing the OpenCode Go (Live) group](docs/img/check.png)

![Model and reasoning level menu in a session](docs/img/check-think.png)

## Documentation

- [Usage guide](docs/usage.md): installation, key setup, configuration, and troubleshooting.
- [Architecture](docs/opencode-go-live-dynamic-catalog-design.md): component responsibilities, Mermaid data-flow and sequence diagrams, catalog refresh, and request behavior.
- [Development and release](docs/development-and-release.md): feature and bug-fix PRs, verification, version tags, and GitHub pre-releases.

The plugin requires the DSH `llm` and `credentials` services; the Web settings page also uses `settings`. A failed refresh retains the last successful catalog. With no catalog, the provider remains visible but has no live models. Calls without a credential return `MISSING_CREDENTIAL`. A visible model does not establish that the upstream API will authorize its requests.

Image inputs (a `read_image` tool result or a pasted screenshot) are resolved through the host's durable attachment service, exactly as on the built-in routes; when no attachment service is mounted, a request carrying an image fails with `UNSUPPORTED_CONTENT` instead of silently dropping it. File attachments never reach any provider as bytes: request assembly projects every file block to deterministic handle text on all routes. Declared input modalities follow the remote catalog's `modalities.input` (text and image), and a model that declares no image input receives text-only image placeholders.

## Verification

**Verified on macOS only.** The plugin's installation, the catalog refresh against the live Models.dev source, the Models settings card, and model calls were all exercised on a single macOS machine; Linux and Windows have not been run.

CI executes the build and the offline test suite on `ubuntu-latest`. That is a build signal, not a runtime verification: the tests use fixed catalog doubles, and no automated run reaches the real OpenCode Go API.

## License

MIT © 2026 SkylerFee — see [LICENSE](LICENSE).
