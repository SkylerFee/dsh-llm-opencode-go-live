# Using OpenCode Go Live

English | [中文](usage.zh.md)

This guide targets a DeepSeek Harness installation whose Web profile already starts. The plugin provides the separate `opencode-go-live` route: once installed you can configure an API key on the DSH Models provider page and select dynamic catalog models in the model picker.

## Prerequisites and installation

You need Node.js 22.19 or newer (the floor pi-ai declares), pnpm, and a DeepSeek Harness Web profile at 0.1.7-rc.1 or newer. The plugin declares `@deepseek-ai/cordis` `~4.0.4` and `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-pi-ai`, `@deepseek-ai/dsh-settings` `>=0.1.7-rc.1` as peers. The host must also provide `@earendil-works/pi-ai` `^0.87.1`; DSH resolves this peer to the host's pi-ai at runtime, including linked source installs. The plugin's pi-ai `0.87.1` development dependency supplies its standalone build and tests. The DSH Web profile must start correctly.

### Install from npm

Installing from npm is recommended. Use the installed `dsh` CLI to add the published package to the Web profile:

```sh
dsh plugin --profile web add @skylerfee/dsh-llm-opencode-go-live
```

Without a version or tag, this installs `latest`. Append `@alpha` to follow prereleases, or `@0.2.0` to pin this release. Then restart the Web profile.

When running DSH from source, use this command from the DSH repository root:

```sh
pnpm dsh plugin --profile web add @skylerfee/dsh-llm-opencode-go-live
```

Installation adds the package's `cordis.patch.yml` to the Web profile bundle layer, sets the default credential reference `OPENCODE_GO_LIVE_API_KEY`, and places the catalog snapshot at `cache/opencode-go-live.json` under the Harness home — `~/.dsh/cache/opencode-go-live.json` by default, or under `$DSH_HOME` when that variable is set. Installation does not change the default model. Restart the Web profile after installing or updating the bundle; when running DSH from source, the main repository must already have build artifacts.

### Install from source

For development or debugging, run these commands from the DSH repository root. They clone the default `main` branch beside DSH, build it, and install that directory. If you already have a checkout on `main`, skip the clone command and use the checkout's path in the remaining commands:

```sh
git clone https://github.com/SkylerFee/dsh-llm-opencode-go-live.git ../dsh-llm-opencode-go-live
pnpm --dir ../dsh-llm-opencode-go-live install
pnpm --dir ../dsh-llm-opencode-go-live run check
pnpm dsh plugin --profile web add ../dsh-llm-opencode-go-live
```

The profile records a `link:` dependency on the plugin directory, so leave that directory in place. Confirm the built entry point is available through the profile:

```sh
ls ~/.dsh/profiles/web/node_modules/@skylerfee/dsh-llm-opencode-go-live/lib/index.js
```

If `DSH_HOME` is set, check `profiles/web/node_modules/` under that directory instead.

For an installation independent of the checkout, run `pnpm pack` in the built plugin directory and install the resulting tarball with `pnpm dsh plugin --profile web add /absolute/path/to/skylerfee-dsh-llm-opencode-go-live-0.2.0.tgz` from the DSH repository root.

Where the `dsh` CLI is already installed, the last line can also be `dsh plugin --profile web add ../dsh-llm-opencode-go-live` from the DSH repository root.

The same install and enable flow driven from the Web client's plugin page:

![Installing and enabling the plugin from the Web client's plugin page](img/install-plugin.gif)

## Configure the key and use a model

1. Start the Web profile, open **Settings → Models**, and find the plugin-owned **OpenCode Go (Live)** card.
2. The card shows only the key status and the model list by default. Click **Edit**, enter the OpenCode Go key in the **API Key** field, and apply it — or click **Cancel** to discard the input. The key is written to the DSH credentials service and the page never echoes the stored value; the status line indicates that the reference is known to hold a credential.
3. Wait for the dynamic catalog to load, expand the card's model list, or find the models under `opencode-go-live` in the model picker. Select one to start a conversation; to use it as the default model, choose this route and model in the DSH default-model settings.

The catalog comes from Models.dev and fetching it needs no API key; the key is resolved only when a request actually reaches the OpenCode Go API. If a selected model still cannot be called, use [Troubleshooting](#troubleshooting) below to separate credential errors from upstream responses.

![Saving the API key in the OpenCode Go (Live) card and choosing a live model in the model picker](img/add-key.gif)

## Usage overlay

The card's **Show usage overlay** switch controls the bottom-right usage control. It writes the plugin's `showBalanceOverlay` config, whose **default is on**, so a fresh install shows the control and the choice survives a profile restart. When the host cannot report the field (for example before any config write), it counts as on as well.

The chip expanding into the full panel and collapsing back when the mouse leaves:

![The usage overlay chip expanding into the full panel](img/usage-view.gif)

**The default form is a chip** occupying a small bottom-right area, showing the 5-hour window's bar and usage percent plus a pin button:

| Action | Behavior |
| --- | --- |
| Move the mouse onto the chip | Expands the full panel (three billing windows plus the updated time). |
| Move the mouse away | Collapses back to the chip automatically; no button is involved. |
| Drag the chip or the panel (while unpinned) | Moves it; anywhere on the panel except its buttons works as a drag handle. A click at the end of a drag is not treated as an expand. |
| Click the chip body | Expands the panel on devices without hover. |
| Click the pin button | Locks or unlocks the current position. The icon is a vector pin: **filled = pinned, hollow = unpinned**, and **the default is unpinned**. While pinned, neither the chip nor the panel can be dragged. |

The full panel shows the OpenCode Go subscription usage across three billing windows:

| Window | Meaning |
| --- | --- |
| 5-hour | Rolling window carrying 20% of the monthly limit. |
| This week | Weekly window carrying 50% of the monthly limit. |
| This month | Monthly window carrying 100%; exhaustion reports `rate-limited`. |

Each row shows the percent, a bar, and a reset countdown; the bar turns amber near the limit and switches to the error color under `rate-limited`. The panel title bar carries:

| Button | Behavior |
| --- | --- |
| Pin | Locks or unlocks the position, sharing one state with the chip's button. |
| ⟳ Refresh | Queries immediately (throttled to once per 10 seconds). |
| × Close | Writes the plugin's `showBalanceOverlay` to `false`, which **turns the Models-card switch off in step**; reopen that switch to show the control again. |

The panel has no minimize button: moving the mouse away collapses it into the chip. Position and pinned state are browser-local interface preferences (`localStorage`) and are not written to plugin config; whether the control is shown at all is decided by plugin config.

The host balance route `GET /api/opencode-go-live/balance` supplies the data: the host queries `https://opencode.ai/zen/go/v1/usage` with the credential named by `apiKeyEnv` and hands only the normalized usage to the browser, so the API key never leaves the host process. That endpoint does not appear in OpenCode's public documentation and is an upstream implementation convention; if upstream changes it, the panel reports a failed query rather than affecting model calls.

The panel queries once on mount, then refreshes every 5 minutes, and the refresh button queries on demand (never more than once per 10 seconds). Updating the key triggers a fresh query.

## Configuration reference

The bundled `cordis.patch.yml` already sets `catalog.cachePath` to `dshHomePath('cache', 'opencode-go-live.json')`, so an installed bundle persists the catalog by default. When mounting the Cordis plugin by hand, these fields are available in the owning config; `apiKeyEnv` holds the credential reference name, not the key value:

```yaml
llm-opencode-go-live:
  apiKeyEnv: OPENCODE_GO_LIVE_API_KEY
  catalog:
    cachePath: /absolute/path/to/opencode-go-live.json
    refreshOnStart: true
    refreshIntervalMs: 21600000
    refreshTimeoutMs: 10000
  showBalanceOverlay: true
```

| Field | Default | Effect |
| --- | --- | --- |
| `apiKeyEnv` | `OPENCODE_GO_LIVE_API_KEY` | Reference resolved by the DSH credentials service on every model call; independent of the reference the built-in `opencode-go` route uses. |
| `catalog.cachePath` | `dshHomePath('cache', 'opencode-go-live.json')` | Absolute path; the bundle points it at `cache/opencode-go-live.json` under the Harness home (`~/.dsh/cache/opencode-go-live.json` by default, or under `$DSH_HOME`), which is how the catalog survives restarts. Only a hand-mounted plugin that leaves it unset keeps the catalog in memory. |
| `catalog.refreshOnStart` | `true` | Refresh the catalog from Models.dev at startup. |
| `catalog.refreshIntervalMs` | `21600000` | Interval for later refreshes in milliseconds; `0` disables scheduled refreshes. |
| `catalog.refreshTimeoutMs` | `10000` | Timeout for a single catalog request in milliseconds; `0` disables the timeout. |
| `showBalanceOverlay` | `true` | Whether the usage overlay is shown; the Models card switch reads and writes it, and the host runtime never consumes it. |

The catalog fields belong to plugin config; the plugin's Models card edits the API key and the usage-overlay switch. A refresh first tries to restore the snapshot; a failed refresh retains the most recent successful catalog. The API key is never written to the catalog snapshot.

## Troubleshooting

| Symptom | Check and fix |
| --- | --- |
| The OpenCode Go (Live) provider is missing | Check that the plugin is installed in the current `web` profile, restart that profile, and look for plugin load errors in the startup log. |
| The plugin installs but the provider never appears, and `lib/index.js` is missing from the installed package | Build the source checkout with `pnpm run check`, then install its directory again or pack and install its tarball. |
| The provider is visible but has no live models | Check whether the DSH process can reach Models.dev; the first load has no snapshot and keeps an empty catalog, and a failed startup refresh writes a warning. |
| `MISSING_CREDENTIAL` is returned | Save the API key in the plugin's Models card; confirm the running DSH uses the same profile and credential reference. Upgrading from a build whose default reference was `OPENCODE_GO_API_KEY` requires entering the key once more for this card. |
| A model is selectable but API calls fail | Catalog loading and model calls are independent. Check DSH call errors and service logs, and use the error code to separate authentication, permission, rate-limit, and network problems; never paste keys into logs or tickets. |
| Old models still show after a refresh | Check the refresh warning; the plugin retains the last successful catalog when the source fails, every entry is rejected, or the snapshot cannot be saved. |
| The switch is on but no overlay appears | The overlay lives on the browser frame's floating layer, so confirm the page is the Web client rather than a terminal session; if the panel's × was used, the Models-card switch was turned off in step — turn it back on. |
| Only a small chip appears in the corner | That is the default form: the chip shows the 5-hour bar and usage percent, expands into the full panel on hover, and collapses when the mouse leaves. |
| The overlay cannot be dragged | It is pinned; click the pin button (filled means pinned) to unlock it. Both the chip and the panel can then be dragged. |
| The position or pinned state is wrong | Both live in the browser's `localStorage` (keys `opencode-go-live.overlay.*`); clear them to restore the defaults (bottom-right, unpinned). |
| The overlay reports a missing API key | The card has no saved key yet, or this profile uses a different credential reference; enter and apply the key in the card. |
| The overlay reports no OpenCode Go subscription | Upstream answered 403, meaning the key's account has no Go subscription (the Zen prepaid balance is outside this panel's scope). |
| The overlay reports a failed query | The host cannot reach `https://opencode.ai/zen/go/v1/usage`, or upstream has moved that endpoint; model calls are unaffected — check against the endpoint note above. |

`opencode-go-live` never falls back to the built-in `opencode-go`. To fall back, explicitly select the built-in route in the model picker or the default-model settings.

## Development verification

Run `pnpm run check` in the plugin checkout for the TypeScript build and offline tests; run `pnpm pack --dry-run` before publishing to inspect the package contents. Tests use fixed catalog and usage doubles and never reach the real model API or usage endpoint. See the [architecture document](opencode-go-live-dynamic-catalog-design.md) for how the catalog and the call paths are implemented, and the [usage overlay design](opencode-go-live-balance-overlay-design.md) for the data source and route contract.
