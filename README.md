# @skylerfee/dsh-llm-opencode-go-live

English | [中文](README.zh.md)

An OpenCode Go live model catalog plugin for DeepSeek Harness. It reads the `opencode-go` catalog from Models.dev, registers the separate `opencode-go-live` route, contributes its own Models settings card, and uses pi-ai for model requests. The built-in `opencode-go` route remains available.

## Quick Start

Node.js 22.19 or newer (the floor pi-ai declares) and pnpm are required. Run `pnpm install && pnpm run check` in this plugin checkout, then install its bundle from the DSH repository root:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/dsh-llm-opencode-go-live
```

Restart the Web profile. Open **Settings → Models**, click **Edit** in the plugin-owned **OpenCode Go (Live)** card, enter your API key, and apply it. Choose a model under `opencode-go-live` in the model picker. DSH stores the key through its credentials service under the default reference `OPENCODE_GO_LIVE_API_KEY`, which is deliberately distinct from the `OPENCODE_GO_API_KEY` that the Models page derives for the built-in `opencode-go` route, so the two routes never share one credential record. The bundle stores a catalog snapshot at `cache/opencode-go-live.json` under the Harness home — `~/.dsh/cache/opencode-go-live.json` by default, or under `$DSH_HOME` when that variable is set. Installation does not change the default model.

## Documentation

- [Usage guide](docs/usage.md): installation, key setup, configuration, and troubleshooting.
- [Architecture](docs/opencode-go-live-dynamic-catalog-design.md): component responsibilities, Mermaid data-flow and sequence diagrams, catalog refresh, and request behavior.

The plugin requires the DSH `llm` and `credentials` services; the Web settings page also uses `settings`. A failed refresh retains the last successful catalog. With no catalog, the provider remains visible but has no live models. Calls without a credential return `MISSING_CREDENTIAL`. A visible model does not establish that the upstream API will authorize its requests.
