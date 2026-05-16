# Stats Dashboard

Comprehensive statistics and analytics for your [Thymer](https://thymer.com) workspace. An **App Plugin** built with the [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk).

**Source:** [github.com/RobbK17/thymer-statistics](https://github.com/RobbK17/thymer-statistics) · **Version:** 1.0.5

## What's new in 1.0.5

- **Include refs & transclusions** — Panel checkbox plus `expandLineItemReferences` in `plugin.json`; toggles `getLineItems(true)` vs `getLineItems(false)` (reference/transclusion expansion). Checkbox choice is stored per workspace in `localStorage` (`thymer-stats-prefs:v1:…`).
- **Cache consistency** — Persisted stats include the expand flag; changing the option invalidates the saved cache and triggers a full rebuild.

## What's new in 1.0.4

- **Stats Dashboard** — card-based summary with expandable detail panels (one open at a time).
- **Hybrid loading** — metadata scan first for fast first paint; line-item stats filled in via background batches on large workspaces.
- **Lazy detail panels** — detail HTML is built when you open a card, not on initial load.
- **localStorage cache** — stats persist per workspace in the browser; reopen restores cached data and only rescans new or missing records.
- **Live cache updates** — `record` and `lineitem` events update stats incrementally; changes are saved to storage (debounced).
- **Progress bar** — shows background scan progress when line items are still being counted.
- **Recent Activity** and **Record Distribution** — collapsible sections below the cards.
- **Performance tuning** — `scanMode`, batch size, UI throttle, and cache TTL via `plugin.json` `custom` settings.

## Features

**Summary cards** — Tap any card to expand a detail panel below the row. Only one detail is open at a time; tap the active card again to collapse.

| Card | Detail |
|------|--------|
| Collections | All collections with record, line item, task, property, and view counts (click a row to open) |
| Records | Largest records by line item count, plus empty records when present (click to open) |
| Line Items | Breakdown by content type (tasks, text, headings, lists, quotes, …) |
| Tasks | Counts by task status, with overall “% done” on the card |
| New This Week | Records created in the last seven days (card); per-collection new/edits and last activity table (detail) |
| Users | Active users with admin and owner badges |
| Global Plugins | Installed global plugins |
| Properties | Counts by property type (text, number, choice, datetime, …) |
| Views | Counts by view type (table, board, gallery, calendar, …) |

**Bottom area** — **Recent Activity** (latest touched records, clickable) and **Record Distribution** (bar chart by collection); each block expands from its header.

Use **Refresh** in the panel header to clear the cache and re-analyze the workspace. The panel title shows the current user’s name (e.g. “Alex’s Stats”).

### Performance (large workspaces)

1. **Metadata first** — record counts, dates, users, properties, and views appear quickly.
2. **Background scan** — line items and tasks are counted in batches; card totals update with a progress bar (workspaces over 3,000 records by default in `auto` mode).
3. **Lazy details** — detail panels load on demand.
4. **Persistent cache** — reopening restores from `localStorage`; only new or removed records are reconciled on open.
5. **Event deltas** — edits while the plugin is loaded update the cache and storage without a full rescan.

## How to use

1. Open **Stats Dashboard** in the Thymer sidebar, or  
2. Use the command palette (Cmd/Ctrl+P) and run **Show Stats Dashboard**.

The dashboard opens in a new panel.

## Installation

### Option A: Install from plugin code (no build)

1. In Thymer: **Cmd/Ctrl+P** → **Plugins** → **Create Plugin** (or open an existing Global Plugin).
2. In **Configuration**, paste the contents of `plugin.json`.
3. In **Custom Code**, paste the contents of `plugin.js` (do **not** include `export` or `import` — use the code as-is from this repo).
4. Save the plugin.

### Option B: Develop with the Thymer Plugin SDK (hot reload)

If you use the [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk) for development:

1. Clone the SDK repo and follow its [Quick Start](https://github.com/thymerapp/thymer-plugin-sdk#quick-start) (Chrome with remote debugging, enable Hot Reload in Thymer, `npm run dev`).
2. Copy this repo’s `plugin.js` and `plugin.json` into the SDK project (replacing the default plugin files).
3. If you use `export class Plugin` and imports in your local `plugin.js`, run `npm run build` and use the built `dist/plugin.js` when copying into Thymer’s **Custom Code** (or paste the built output without `export`/`import`).

## Configuration

In the plugin’s **Configuration** (or in `plugin.json` under `custom`):

| Key | Default | Meaning |
|-----|---------|--------|
| `emptyRecordsExcludeJournal` | `true` | When `true`, journal records are omitted from **Empty Records**. |
| `scanMode` | `"auto"` | `"auto"` — background scan when records ≥ threshold; `"fast"` — always background; `"full"` — scan all line items before finalizing totals (small workspaces). |
| `largeWorkspaceThreshold` | `3000` | Record count at which `auto` uses background scanning. |
| `enrichBatchSize` | `40` | Records processed per background batch. |
| `uiUpdateIntervalMs` | `250` | Minimum interval between card/progress UI updates during scan. |
| `expandLineItemReferences` | `false` | When `true`, counts use `getLineItems(true)` (includes reference/transclusion targets; slower, higher totals). |
| `persistCache` | `true` | Save stats to `localStorage` (per workspace) for fast reopen. |
| `cacheTtlMs` | `604800000` (7 days) | Discard stored cache when older than this (`0` = no expiry). |
| `cacheSaveDebounceMs` | `1000` | Debounce before writing cache to storage. |

Example:

```json
"custom": {
  "emptyRecordsExcludeJournal": true,
  "scanMode": "auto",
  "largeWorkspaceThreshold": 3000,
  "enrichBatchSize": 40,
  "uiUpdateIntervalMs": 250,
  "expandLineItemReferences": false,
  "persistCache": true,
  "cacheTtlMs": 604800000,
  "cacheSaveDebounceMs": 1000
}
```

**Include refs & transclusions** — Checkbox in the panel header (saved per workspace in `localStorage` as `thymer-stats-prefs:v1:…`) overrides `expandLineItemReferences` from config after you change it once. Remove that key in DevTools to follow `plugin.json` again.

### Cache behavior

| Action | Result |
|--------|--------|
| **Open dashboard** | Load from `localStorage` if valid; reconcile metadata; enrich only unscanned records |
| **Refresh** | Clear storage + full rebuild |
| **Thymer `reload` event** | Clear storage; rebuild if panel is open |
| **Record / line-item edits** | Debounced per-record rescan; cache saved to storage |

Storage key: `thymer-stats:v1:{workspaceGuid}`. If the browser quota is exceeded, the plugin clears the stored cache automatically.

## Plugin type

This is an **App Plugin** (global). It adds:

- A **sidebar item** (“Stats Dashboard”, chart-bar icon)
- A **command palette** command (“Show Stats Dashboard”)
- A **custom panel type** (`workspace-stats`) that renders the dashboard

## Requirements

- Thymer workspace with plugin support
- No extra dependencies when pasting code; SDK dev setup only if you use the SDK workflow

## Links

- [thymer-statistics](https://github.com/RobbK17/thymer-statistics) — this project
- [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk) — docs, API, and SDK for Thymer plugins
- [Thymer Plugins](https://thymer.com/plugins/) — overview and demos

## License

Use and modify as you like; consider the Thymer Plugin SDK’s license for SDK-specific parts.
