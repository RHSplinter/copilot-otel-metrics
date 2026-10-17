# Copilot OTel data schema (file exporter)

What `data/copilot-otel.jsonl` contains when GitHub Copilot Chat exports OpenTelemetry to a file
(`github.copilot.chat.otel.exporterType: "file"`). Reference: the
[Copilot Chat agent monitoring docs](https://github.com/microsoft/vscode-copilot-chat/blob/main/docs/monitoring/agent_monitoring.md).

## How this was verified

The real `data/copilot-otel.jsonl` was not available when this was written. The format below was checked against the
Copilot Chat source ([`fileExporters.ts`](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/otel/node/fileExporters.ts),
`otelServiceImpl.ts`, `genAiEvents.ts`, `genAiMetrics.ts`) and by running that exporter code with the same SDK versions
(`@opentelemetry/sdk-logs` 0.212, `sdk-metrics`/`sdk-trace-node`/`resources` 2.x). The resulting output is committed as
[`dashboard/test/fixtures/sdk-file-exporter.jsonl`](../dashboard/test/fixtures/sdk-file-exporter.jsonl) and covered by `npm test`
(regenerate with [`dashboard/scripts/generate-sdk-fixture.js`](../dashboard/scripts/generate-sdk-fixture.js)). Run `npm run inspect` on your
own export to confirm it matches.

## Line types

Each line is the `JSON.stringify` of a raw OpenTelemetry JS SDK object (it is **not** OTLP/JSON):

| Shape | Recognised by | Meaning |
|---|---|---|
| `{}` | empty object | A **span**. `JSON.stringify` throws on the SDK span (circular reference) and the exporter falls back to `{}` ([microsoft/vscode#319993](https://github.com/microsoft/vscode/issues/319993)). Trace trees, span durations and captured prompt/response content are lost. |
| LogRecord | `hrTime`, `_body`, `attributes['event.name']` | An **event**. Name in `attributes['event.name']`, timestamp in `hrTime` `[sec, ns]`, trace link in `spanContext`. |
| ResourceMetrics | `scopeMetrics[]` | One **metric export** (every 10 s and on shutdown). Contains *cumulative* data points: every export repeats running totals. |

Every record carries a `resource` (`_rawAttributes: [[key, value], …]`):
`service.name` (`copilot-chat`), `service.version` (extension version), `session.id` (one per VS Code window), plus
anything from `OTEL_RESOURCE_ATTRIBUTES`.

Copilot CLI / VS Code agent host records (`service.name` `github-copilot`) have no resource `session.id`. Their spans
carry `gen_ai.conversation.id` (the CLI session id, also the `~/.copilot/session-state/<id>` folder name); child spans
without it inherit it through their `traceId`. The dashboard lists each conversation as its own session, titled from
`name` / `repository` / `branch` in that folder's `workspace.yaml` (`GET /api/sessions`, server mode only).
Metrics are aggregated across sessions and stay under `(no session.id)`.

Sessions are ordered by their latest recorded activity, newest first; sessions without timestamps appear last.

The session dropdown adds `[HydraFusion]` / `[HydraFusion Max]` tags (and pill badges for the selected session) when
the session's spans or logs have `gen_ai.request.model` or `gen_ai.response.model` equal to `hydrafusion` /
`hydrafusion-max`. Both tags appear if both models were used.

The parser also accepts plain span snapshots (`traceId`, `spanId`, `name`, `startTime`, `endTime`, `attributes`, …)
and OTLP/JSON (`resourceSpans` / `resourceLogs` / `resourceMetrics`) in case the exporter is fixed or another
collector is used.

## Events (log records)

| Event | Key attributes |
|---|---|
| `gen_ai.client.inference.operation.details` | `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `error.type` |
| `copilot_chat.session.start` | `gen_ai.request.model`, `gen_ai.agent.name` |
| `copilot_chat.agent.turn` | `turn.index`, input/output tokens, `tool_call_count` |
| `copilot_chat.tool.call` | `gen_ai.tool.name`, `duration_ms`, `success`, `error.type` |
| `copilot_chat.edit.feedback` / `copilot_chat.edit.hunk.action` / `copilot_chat.inline.done` | accept / reject outcomes, `language_id` |
| `copilot_chat.edit.survival` | `edit_source`, `survival_rate_four_gram`, `survival_rate_no_revert`, `time_delay_ms` |
| `copilot_chat.user.feedback` | `rating` (positive / negative) |
| `copilot_chat.cloud.session.invoke` | cloud agent invocations |

## Metrics

Copilot creates every instrument without a unit or description, so `descriptor.unit` is always `""`. Units below come
from the source code. `recordMetric` → histogram, `incrementCounter` → counter (sum).

| Metric | Type / unit | Attributes |
|---|---|---|
| `gen_ai.client.operation.duration` | histogram, s | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `error.type` |
| `gen_ai.client.token.usage` | histogram, tokens | `gen_ai.token.type` (input/output), model, provider |
| `copilot_chat.time_to_first_token` | histogram, s | `gen_ai.request.model` |
| `copilot_chat.tool.call.count` / `.duration` | counter / histogram ms | `gen_ai.tool.name`, `success` |
| `copilot_chat.agent.invocation.duration` | histogram, s | `gen_ai.agent.name` |
| `copilot_chat.agent.turn.count` | histogram | `gen_ai.agent.name` |
| `copilot_chat.session.count` | counter | |
| `copilot_chat.edit.acceptance.count`, `copilot_chat.chat_edit.outcome.count` | counter | `copilot_chat.edit.source`, `copilot_chat.edit.outcome`, `copilot_chat.language_id` |
| `copilot_chat.edit.survival.four_gram` / `.no_revert` | histogram (0–1) | `copilot_chat.edit.source`, `copilot_chat.time_delay_ms` |
| `copilot_chat.lines_of_code.count` | counter | `type` (added/removed), `copilot_chat.language_id` |
| `copilot_chat.user.action.count`, `copilot_chat.user.feedback.count` | counter | `action` / `rating` |
| `copilot_chat.agent.edit_response.count`, `copilot_chat.agent.summarization.count` | counter | `outcome` |
| `copilot_chat.pull_request.count`, `copilot_chat.cloud.session.count`, `copilot_chat.cloud.pr_ready.count` | counter | `partner_agent` (cloud session) |

Metrics use **cumulative** temporality (SDK enum `aggregationTemporality: 1`). To get totals the parser keeps the
latest point per *(resource, metric, attributes, startTime)* and sums across resources (windows/restarts).

## Copilot CLI and VS Code agent host

The Copilot CLI (`service.name` `github-copilot`, also used by the VS Code agent host with
`service.namespace=vscode.agent-host`) writes to the same file with a different, fully serialized format:

| Shape | Meaning |
|---|---|
| `{"type":"span", traceId, spanId, parentSpanId, name, startTime, endTime, attributes, status, events, resource: {attributes}}` | Full spans (no `{}` problem). |
| `{"type":"metric", name, unit, dataPoints: [{attributes, startTime, endTime, value}], resource: {attributes}}` | One metric per line, cumulative (constant `startTime`, growing value). No `session.id` on the resource. |

Agents, skills, MCP servers and related data only exist in these spans:

| Span | Key attributes |
|---|---|
| `invoke_agent` / `invoke_agent <name>` | `gen_ai.agent.name` (absent for the main CLI agent), `github.copilot.agent.type`, `gen_ai.conversation.id`, token usage, `github.copilot.turn_count`, `github.copilot.cost`; a parent `invoke_agent` span marks a **subagent** (e.g. `explore`). Capability snapshot: `github.copilot.context.skills`, `.custom_agent_names`, `.mcp_server_names` (JSON string arrays). |
| `execute_tool skill <name>` | `gen_ai.skill.name` — a skill invocation. |
| `execute_tool <hash>/<hash>` | MCP tool call. `gen_ai.tool.name` is `sha256(server)/sha256(tool)`, `github.copilot.tool.parameters.mcp_server_name_hash` is the server hash. |
| `execute_tool <hash>`, `external_tool <hash>` | Host-provided (external) tool, name hashed. |
| `permission` | `github.copilot.permission.kind` (read/shell/write/url/custom-tool), `github.copilot.permission.result` (`approved`, `denied-…`). |
| `session.timing.<phase>` | Startup phases, e.g. `mcp_startup_wait`, `skills_loading`, `custom_agent_loading`. |
| metric `github.copilot.mcp.server.connection.count` | `outcome` (success/failure). |

VS Code (`copilot-chat`) chat spans also carry `gen_ai.agent.name` (e.g. `panel/editAgent`, `XtabProvider`), but in
the file export these spans are `{}`; VS Code MCP tools appear in tool events as `mcp_<server>_<tool>`.

**Resolving hashed names.** MCP server, tool and external tool names are SHA-256 hashes. The parser hashes candidate
names and matches them: well-known names (GitHub MCP server and its tools, bundled plugins), plain tool names and
tool definitions found in the file, and — when served by `dashboard/scripts/serve.js` — MCP server *names* (keys only) from local
configs: `~/.copilot/mcp-config.json`, Copilot CLI plugin `mcp.json` files, VS Code user/profile `mcp.json`, agent
plugins, and the `mcpServerDefinitionProviders` labels of installed VS Code extensions (localized via `package.nls.json`).
Unresolved names are shown as a short hash.

When a file contains both VS Code events and spans for the same service, only events are counted for LLM calls and
tools (to avoid double counting); services that emit only spans (the CLI) are counted from spans.

## What is (and isn't) available

- ✅ Usage per model, tokens, LLM latency and time-to-first-token, tool usage/failures/durations, agent turns,
  edit acceptance, lines of code by language, edit survival, user feedback, versions and windows.
- ✅ From Copilot CLI / agent host spans: agents and subagents, custom agents, skills (loaded vs. invoked), MCP servers
  and tool calls, MCP connection outcomes, permission requests and capability startup timings.
- ❌ Span hierarchy (trace trees), per-request durations from spans and prompt/response content (`captureContent`)
  for VS Code — these only exist on spans, which the VS Code file exporter writes as `{}`.
