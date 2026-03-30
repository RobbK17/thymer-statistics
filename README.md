# Stats Dashboard

Comprehensive statistics and analytics for your [Thymer](https://thymer.com) workspace. An **App Plugin** built with the [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk).

**Source:** [github.com/RobbK17/thymer-statistics](https://github.com/RobbK17/thymer-statistics) · **Version:** 1.0.3

## Features

**Summary cards** — Tap any card to expand a detail panel below the row. Only one detail is open at a time; tap the active card again to collapse.

| Card | Detail |
|------|--------|
| Collections | All collections with record, line item, task, property, and view counts (click a row to open) |
| Records | Largest records by line item count, plus empty records when present (click to open) |
| Line Items | Breakdown by content type (tasks, text, headings, lists, quotes, …) |
| Tasks | Counts by task status, with overall “% done” on the card |
| New This Week | Records created in the last seven days (card); per-collection new/edits and last activity table (detail). Uses per-record dates — slightly heavier than a simple count |
| Users | Active users with admin and owner badges |
| Global Plugins | Installed global plugins |
| Properties | Counts by property type (text, number, choice, datetime, …) |
| Views | Counts by view type (table, board, gallery, calendar, …) |

**Bottom area** — **Recent Activity** (latest touched records, clickable) and **Record Distribution** (bar chart by collection) are shown below the cards; each block can be expanded from its header.

Use **Refresh** in the panel header to re-analyze the workspace. The panel title shows the current user’s name (e.g. “Alex’s Stats”).

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
| `emptyRecordsExcludeJournal` | `true` | When `true`, records in journal collections are not listed under **Empty Records** in the Records detail. |

Example:

```json
"custom": {
  "emptyRecordsExcludeJournal": true
}
```

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
