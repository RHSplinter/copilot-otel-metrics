# copilot-otel-metrics

Explore and visualize the OpenTelemetry data that GitHub Copilot Chat emits in VS Code. This is step one toward a
VS Code extension: a dependency-free parser plus a local dashboard.

## 1. Export Copilot OTel data to a file

In VS Code `settings.json`:

```jsonc
"github.copilot.chat.otel.enabled": true,
"github.copilot.chat.otel.exporterType": "file",
"github.copilot.chat.otel.outfile": "<repo>/data/copilot-otel.jsonl"
```

(or set `COPILOT_OTEL_FILE_EXPORTER_PATH`). See [docs/otel-data-schema.md](docs/otel-data-schema.md) for what the
file contains.

> ⚠️ With `captureContent` enabled the file can contain prompts and code. Don't commit it.

## 2. Run the dashboard

Requires Node.js 18+. No `npm install` needed.

```sh
npm start                       # http://127.0.0.1:4747
node scripts/serve.js --port 5000 path/to/file.jsonl
npm run inspect                 # text summary in the terminal (add --json for raw output)
```

The data file is resolved in this order: CLI argument → `COPILOT_OTEL_FILE` → `data/copilot-otel.jsonl` →
`data/sample-copilot-otel.jsonl`. You can also drag & drop any `.jsonl` onto the page or use **Open JSONL…**.

The dashboard shows KPIs, activity over time, tokens/latency per model, finish reasons and errors, tool usage,
agent turns, edits by language and acceptance, edit survival, feedback, a data inventory (every event, metric,
attribute and resource attribute found) and a raw record explorer. Filter by VS Code window (`session.id`).

## Sample data

`data/sample-copilot-otel.jsonl` is synthetic data (the real export was not available yet). Its shapes match real
file-exporter output, which was captured by running Copilot's exporter code with the same OpenTelemetry SDK versions
(`test/fixtures/sdk-file-exporter.jsonl`, see [docs](docs/otel-data-schema.md#how-this-was-verified)). Regenerate the
sample with `npm run generate-sample` (`--seed`, `--out`, `--fixed-spans`).

## Layout

| Path | Purpose |
|---|---|
| `src/parser/otelParser.js` | UMD parser + analyzer (Node and browser / future webview) |
| `dashboard/` | Static dashboard (no inline scripts, CSP-friendly, uses VS Code theme variables when available) |
| `scripts/` | Local server, inspector CLI and sample generator |
| `test/` | `npm test` (node:test) |

## Roadmap

1. ✅ Identify the data and build a local dashboard.
2. Wrap the dashboard in a VS Code webview (reuse `otelParser.js`, `charts.js`), watch the export file live.
3. Status bar summary, per-workspace history, and span support once the exporter serializes spans.
