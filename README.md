# Workspace Statistics

Comprehensive statistics and analytics for your [Thymer](https://thymer.com) workspace. An **App Plugin** built with the [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk).

**Source:** [github.com/RobbK17/thymer-statistics](https://github.com/RobbK17/thymer-statistics)

## Features

- **Overview** — Collections count, total records, line items, tasks (with completion %), users, and global plugins
- **Collections** — List of all collections with record counts, line items, tasks, properties, and views (click to open)
- **Content types** — Breakdown of line item types (tasks, text, headings, lists, quotes, etc.)
- **Task statuses** — Counts by status (done, started, waiting, important, etc.)
- **Property types** — How many text, number, choice, datetime, user, and other property types are in use
- **View types** — Table, board, gallery, calendar, and custom view counts
- **Largest records** — Top 10 records by line item count (click to open)
- **Empty records** — Records with no line items (click to open)
- **Users** — Active workspace users with admin/owner badges

Sections can be turned on or off in the plugin configuration.

## How to use

1. Open the **Statistics** item in the Thymer sidebar, or  
2. Use the command palette (Cmd/Ctrl+P) and run **Show Workspace Statistics**.

The stats open in a new panel. Use **Refresh** to re-analyze the workspace.

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

In the plugin’s **Configuration** (or in `plugin.json`), you can show or hide sections via `custom.sections`:

| Section            | Key                  | Default |
|--------------------|----------------------|--------|
| Overview cards     | `showOverview`       | `true` |
| Collections list   | `showCollections`    | `true` |
| Content types      | `showContentTypes`   | `true` |
| Task statuses      | `showTaskStatuses`   | `true` |
| Property types     | `showPropertyTypes`  | `true` |
| View types         | `showViewTypes`      | `true` |
| Largest records    | `showLargestRecords` | `true` |
| Empty records      | `showEmptyRecords`   | `true` |
| Users              | `showUsers`          | `true` |

Example (hide empty records and users):

```json
"custom": {
  "sections": {
    "showEmptyRecords": false,
    "showUsers": false
  }
}
```

## Plugin type

This is an **App Plugin** (global). It adds:

- A **sidebar item** (“Statistics”, chart-bar icon)
- A **command palette** command (“Show Workspace Statistics”)
- A **custom panel type** that renders the statistics view

## Requirements

- Thymer workspace with plugin support
- No extra dependencies when pasting code; SDK dev setup only if you use the SDK workflow

## Links

- [thymer-statistics](https://github.com/RobbK17/thymer-statistics) — this project
- [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk) — docs, API, and SDK for Thymer plugins
- [Thymer Plugins](https://thymer.com/plugins/) — overview and demos

## License

Use and modify as you like; consider the Thymer Plugin SDK’s license for SDK-specific parts.
