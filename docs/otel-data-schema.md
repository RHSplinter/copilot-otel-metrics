# Copilot OTel data schema (file exporter)

What `data/copilot-otel.jsonl` contains when GitHub Copilot Chat exports OpenTelemetry to a file
(`github.copilot.chat.otel.exporterType: "file"`). Reference: the
[Copilot Chat agent monitoring docs](https://github.com/microsoft/vscode-copilot-chat/blob/main/docs/monitoring/agent_monitoring.md).

## How this was verified

The real `data/copilot-otel.jsonl` was not available when this was written. The format below was checked against the
Copilot Chat source ([`fileExporters.ts`](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/otel/node/fileExporters.ts),
`otelServiceImpl.ts`, `genAiEvents.ts`, `genAiMetrics.ts`) and by running that exporter code with the same SDK versions
(`@opentelemetry/sdk-logs` 0.212, `sdk-metrics`/`sdk-trace-node`/`resources` 2.x). The resulting output is committed as
[`test/fixtures/sdk-file-exporter.jsonl`](../test/fixtures/sdk-file-exporter.jsonl) and covered by `npm test`
(regenerate with [`scripts/generate-sdk-fixture.js`](../scripts/generate-sdk-fixture.js)). Run `npm run inspect` on your
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

## What is (and isn't) available

- ✅ Usage per model, tokens, LLM latency and time-to-first-token, tool usage/failures/durations, agent turns,
  edit acceptance, lines of code by language, edit survival, user feedback, versions and windows.
- ❌ Span hierarchy (trace trees), per-request durations from spans and prompt/response content (`captureContent`)
  — these only exist on spans, which the file exporter writes as `{}`.
