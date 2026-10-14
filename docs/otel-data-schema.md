# Copilot OTel data schema (file exporter)

What `data/copilot-otel.jsonl` contains when GitHub Copilot Chat exports OpenTelemetry to a file
(`github.copilot.chat.otel.exporterType: "file"`). Reference: the
[Copilot Chat agent monitoring docs](https://github.com/microsoft/vscode-copilot-chat/blob/main/docs/monitoring/agent_monitoring.md).

## Line types

Each line is the `JSON.stringify` of a raw OpenTelemetry JS SDK object (it is **not** OTLP/JSON):

| Shape | Recognised by | Meaning |
|---|---|---|
| `{}` | empty object | A **span** that could not be serialized (circular `_spanProcessor` reference, [microsoft/vscode#319993](https://github.com/microsoft/vscode/issues/319993)). Trace trees, span durations and captured prompt/response content are lost. |
| LogRecord | `_hrTime`, `_body`, `attributes['event.name']` | An **event**. Name in `attributes['event.name']`, timestamp in `_hrTime` `[sec, ns]`. |
| ResourceMetrics | `scopeMetrics[]` | One **metric export** (periodic). Contains *cumulative* data points: every export repeats running totals. |

Every record carries a `resource` (`_rawAttributes: [[key, value], …]`):
`service.name` (`copilot-chat`), `service.version` (extension version), `session.id` (one per VS Code window),
`telemetry.sdk.*`.

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

| Metric | Type / unit | Attributes |
|---|---|---|
| `gen_ai.client.operation.duration` | histogram, s | `gen_ai.request.model`, `gen_ai.operation.name` |
| `gen_ai.client.token.usage` | histogram, tokens | `gen_ai.token.type` (input/output), model |
| `copilot_chat.time_to_first_token` | histogram | model |
| `copilot_chat.tool.call.count` / `.duration` | sum / histogram ms | `gen_ai.tool.name`, `success` |
| `copilot_chat.agent.invocation.duration` | histogram, s | `gen_ai.agent.name` |
| `copilot_chat.agent.turn.count`, `copilot_chat.session.count` | sum / histogram | |
| `copilot_chat.edit.acceptance.count` | sum | `copilot_chat.edit.source`, `copilot_chat.edit.outcome` |
| `copilot_chat.lines_of_code.count` | sum | `type` (added/removed), `copilot_chat.language_id` |
| `copilot_chat.user.action.count`, `copilot_chat.user.feedback.count` | sum | action / rating |

Metrics use **cumulative** temporality (SDK enum `aggregationTemporality: 1`). To get totals the parser keeps the
latest point per *(resource, metric, attributes, startTime)* and sums across resources (windows/restarts).

## What is (and isn't) available

- ✅ Usage per model, tokens, LLM latency and time-to-first-token, tool usage/failures/durations, agent turns,
  edit acceptance, lines of code by language, edit survival, user feedback, versions and windows.
- ❌ Span hierarchy (trace trees), per-request durations from spans and prompt/response content (`captureContent`)
  — these only exist on spans, which the file exporter writes as `{}`.
