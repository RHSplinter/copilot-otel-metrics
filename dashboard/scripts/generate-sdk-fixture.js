// Regenerates sdk-file-exporter.jsonl: Copilot Chat's file exporters (logic copied from
// microsoft/vscode-copilot-chat src/platform/otel/node/fileExporters.ts) wired up like
// otelServiceImpl.ts, so the output has the real serialized OpenTelemetry SDK shapes.
//
// Run from a scratch folder (keeps this repo dependency-free):
//   npm i @opentelemetry/api@^1.9.0 @opentelemetry/api-logs@^0.212.0 @opentelemetry/sdk-logs@^0.212.0 \
//         @opentelemetry/sdk-metrics@^2.5.1 @opentelemetry/sdk-trace-node@^2.5.1 @opentelemetry/resources@^2.5.1
//   node <repo>/scripts/generate-sdk-fixture.js <repo>/test/fixtures/sdk-file-exporter.jsonl
const fs = require('node:fs');
const path = require('node:path');
const req = require('node:module').createRequire(path.join(process.cwd(), 'noop.js'));
const api = req('@opentelemetry/api');
const apiLogs = req('@opentelemetry/api-logs');
const traceSDK = req('@opentelemetry/sdk-trace-node');
const logsSDK = req('@opentelemetry/sdk-logs');
const metricsSDK = req('@opentelemetry/sdk-metrics');
const resources = req('@opentelemetry/resources');

const out = path.resolve(process.argv[2] || 'sdk-file-exporter.jsonl');
try { fs.unlinkSync(out); } catch { }

function safeStringify(d) { try { return JSON.stringify(d); } catch { return '{}'; } }
class Base { constructor(p) { this.ws = fs.createWriteStream(p, { flags: 'a' }); } shutdown() { return new Promise(r => this.ws.end(r)); } forceFlush() { return Promise.resolve(); } }
class FileSpanExporter extends Base { export(spans, cb) { this.ws.write(spans.map(s => safeStringify(s) + '\n').join(''), e => cb({ code: e ? 1 : 0 })); } }
class FileLogExporter extends Base { export(logs, cb) { this.ws.write(logs.map(l => safeStringify(l) + '\n').join(''), e => cb({ code: e ? 1 : 0 })); } }
class FileMetricExporter extends Base {
  export(m, cb) { this.ws.write(safeStringify(m) + '\n', e => cb({ code: e ? 1 : 0 })); }
  selectAggregationTemporality() { return metricsSDK.AggregationTemporality.CUMULATIVE; }
}

(async () => {
  const resource = resources.resourceFromAttributes({ 'service.name': 'copilot-chat', 'service.version': '0.40.0', 'session.id': 'win-abc' });
  const bsp = new traceSDK.BatchSpanProcessor(new FileSpanExporter(out));
  const tp = new traceSDK.NodeTracerProvider({ resource, spanProcessors: [bsp] });
  tp.register();
  const blrp = new logsSDK.BatchLogRecordProcessor(new FileLogExporter(out), { scheduledDelayMillis: 1000, maxExportBatchSize: 512 });
  const lp = new logsSDK.LoggerProvider({ resource, processors: [blrp] });
  apiLogs.logs.setGlobalLoggerProvider(lp);
  const reader = new metricsSDK.PeriodicExportingMetricReader({ exporter: new FileMetricExporter(out), exportIntervalMillis: 60000 });
  const mp = new metricsSDK.MeterProvider({ resource, readers: [reader] });
  api.metrics.setGlobalMeterProvider(mp);

  const tracer = api.trace.getTracer('copilot-chat', '0.40.0');
  const logger = apiLogs.logs.getLogger('copilot-chat', '0.40.0');
  const meter = api.metrics.getMeter('copilot-chat', '0.40.0');

  const opDur = meter.createHistogram('gen_ai.client.operation.duration');
  const tokens = meter.createHistogram('gen_ai.client.token.usage');
  const ttft = meter.createHistogram('copilot_chat.time_to_first_token');
  const toolCount = meter.createCounter('copilot_chat.tool.call.count');
  const toolDur = meter.createHistogram('copilot_chat.tool.call.duration');
  const loc = meter.createCounter('copilot_chat.lines_of_code.count');
  const sess = meter.createCounter('copilot_chat.session.count');

  await tracer.startActiveSpan('chat gpt-4o', { kind: api.SpanKind.CLIENT, attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-4o' } }, async span => {
    const ctx = api.context.active();
    logger.emit({ body: 'copilot_chat.session.start', attributes: { 'event.name': 'copilot_chat.session.start', 'session.id': 's1', 'gen_ai.request.model': 'gpt-4o', 'gen_ai.agent.name': 'GitHub Copilot Chat' }, context: ctx });
    logger.emit({ body: 'GenAI inference: gpt-4o', attributes: { 'event.name': 'gen_ai.client.inference.operation.details', 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-4o', 'gen_ai.response.model': 'gpt-4o-2024-11-20', 'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 340, 'gen_ai.response.finish_reasons': ['stop'] }, context: ctx });
    logger.emit({ body: 'copilot_chat.tool.call: read_file', attributes: { 'event.name': 'copilot_chat.tool.call', 'gen_ai.tool.name': 'read_file', 'duration_ms': 42, 'success': true }, context: ctx });
    logger.emit({ body: 'copilot_chat.agent.turn: 0', attributes: { 'event.name': 'copilot_chat.agent.turn', 'turn.index': 0, 'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 340, 'tool_call_count': 1 }, context: ctx });
    const a = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github', 'gen_ai.request.model': 'gpt-4o' };
    opDur.record(2.4, a); opDur.record(1.1, a);
    tokens.record(1200, { ...a, 'gen_ai.token.type': 'input' }); tokens.record(340, { ...a, 'gen_ai.token.type': 'output' });
    ttft.record(0.62, { 'gen_ai.request.model': 'gpt-4o' });
    toolCount.add(1, { 'gen_ai.tool.name': 'read_file', success: true });
    toolDur.record(42, { 'gen_ai.tool.name': 'read_file' });
    loc.add(12, { type: 'added', 'copilot_chat.language_id': 'typescript' });
    sess.add(1);
    span.setAttribute('gen_ai.usage.input_tokens', 1200);
    span.end();
  });

  await reader.forceFlush();
  // second cumulative export
  opDur.record(3.0, { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github', 'gen_ai.request.model': 'gpt-4o' });
  loc.add(3, { type: 'added', 'copilot_chat.language_id': 'typescript' });
  await reader.forceFlush();
  await bsp.forceFlush();
  await blrp.forceFlush();
  await new Promise(r => setTimeout(r, 300));
  await Promise.all([tp.shutdown(), lp.shutdown(), mp.shutdown()]);
  await new Promise(r => setTimeout(r, 300));
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  console.log('lines:', lines.length);
  for (const l of lines) console.log(l.length > 700 ? l.slice(0, 700) + '…' : l);
})();
