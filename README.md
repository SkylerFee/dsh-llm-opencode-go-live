# @skylerfee/dsh-llm-opencode-go-live

English | [中文](README.zh.md)

An OpenCode Go live model catalog plugin for DeepSeek Harness. It reads the `opencode-go` catalog from Models.dev, registers the separate `opencode-go-live` route, contributes its own Models settings card, and uses pi-ai for model requests. The built-in `opencode-go` route remains available.

## Quick Start

Node.js 22.19 or newer (the floor pi-ai declares) and pnpm are required. From the DSH repository root, install the bundle from a released tag:

```sh
pnpm dsh plugin --profile web add github:SkylerFee/dsh-llm-opencode-go-live#v0.1.0-alpha.2
```

A local checkout or a `pnpm pack` tarball works too — see the [usage guide](docs/usage.md#prerequisites-and-installation) for both commands.

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

The plugin requires the DSH `llm` and `credentials` services; the Web settings page also uses `settings`. A failed refresh retains the last successful catalog. With no catalog, the provider remains visible but has no live models. Calls without a credential return `MISSING_CREDENTIAL`. A visible model does not establish that the upstream API will authorize its requests.

Image inputs (a `read_image` tool result or a pasted screenshot) are resolved through the host's durable attachment service, exactly as on the built-in routes; when no attachment service is mounted, a request carrying an image fails with `UNSUPPORTED_CONTENT` instead of silently dropping it. File attachments never reach any provider as bytes: request assembly projects every file block to deterministic handle text on all routes. Declared input modalities follow the remote catalog's `modalities.input` (text and image), and a model that declares no image input receives text-only image placeholders.

## Verification

**Verified on macOS only.** The plugin's installation, the catalog refresh against the live Models.dev source, the Models settings card, and model calls were all exercised on a single macOS machine; Linux and Windows have not been run.

CI executes the build and the offline test suite on `ubuntu-latest`. That is a build signal, not a runtime verification: the tests use fixed catalog doubles, and no automated run reaches the real OpenCode Go API.

## License

MIT © 2026 SkylerFee — see [LICENSE](LICENSE).
