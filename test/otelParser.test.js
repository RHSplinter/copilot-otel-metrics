'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('../src/parser/otelParser.js');

const resource = { _rawAttributes: [['service.name', 'copilot-chat'], ['service.version', '0.30.0'], ['session.id', 'win-1']], _asyncAttributesPending: false };

function sdkLog(eventName, attributes, sec = 1750000000) {
  return { hrTime: [sec, 500000000], hrTimeObserved: [sec, 500000000], resource, instrumentationScope: { name: 'copilot-chat' }, attributes: Object.assign({ 'event.name': eventName }, attributes), _body: eventName };
}

function sdkSum(name, value, attributes, endSec, res = resource) {
  return {
    resource: res,
    scopeMetrics: [{ scope: { name: 'copilot-chat' }, metrics: [{
      descriptor: { name, unit: '1', description: '', valueType: 0 }, aggregationTemporality: 1, dataPointType: 3, isMonotonic: true,
      dataPoints: [{ attributes, startTime: [1750000000, 0], endTime: [endSec, 0], value }],
    }] }],
  };
}

test('normalizes SDK log records (raw resource attributes, hrTime)', () => {
  const [r] = P.normalizeObject(sdkLog('copilot_chat.tool.call', { 'gen_ai.tool.name': 'read_file', duration_ms: 12, success: true }), 1);
  assert.equal(r.kind, 'log');
  assert.equal(r.name, 'copilot_chat.tool.call');
  assert.equal(r.time, 1750000000500);
  assert.equal(r.resource['session.id'], 'win-1');
  assert.equal(r.attributes['gen_ai.tool.name'], 'read_file');
});

test('treats empty objects as lost spans and reports invalid JSON', () => {
  const { records, lines, errors } = P.parseJsonl('{}\n\nnot json\n' + JSON.stringify(sdkLog('x', {})) + '\n');
  assert.equal(lines, 3);
  assert.deepEqual(records.map(r => r.kind), ['lostSpan', 'log']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
});

test('deduplicates cumulative metrics across exports and sums across windows', () => {
  const other = { _rawAttributes: [['service.name', 'copilot-chat'], ['session.id', 'win-2']] };
  const attrs = { 'gen_ai.tool.name': 'read_file', success: true };
  const text = [
    sdkSum('copilot_chat.tool.call.count', 3, attrs, 1750000060),
    sdkSum('copilot_chat.tool.call.count', 5, attrs, 1750000120), // same series, later export
    sdkSum('copilot_chat.tool.call.count', 2, attrs, 1750000060, other),
  ].map(o => JSON.stringify(o)).join('\n');
  const agg = P.aggregateMetrics(P.parseJsonl(text).records);
  assert.equal(agg.size, 1);
  assert.equal([...agg.values()][0].value, 7);
});

test('parses plain span snapshots and OTLP/JSON', () => {
  const span = { traceId: 't', spanId: 's', name: 'chat gpt-4o', kind: 2, startTime: [1750000000, 0], endTime: [1750000002, 0], attributes: { 'gen_ai.operation.name': 'chat' }, status: { code: 0 } };
  const [s] = P.normalizeObject(span, 1);
  assert.equal(s.kind, 'span');
  assert.equal(s.durationMs, 2000);

  const otlp = {
    resourceSpans: [{ resource: { attributes: [{ key: 'session.id', value: { stringValue: 'w' } }] }, scopeSpans: [{ spans: [{ name: 'execute_tool x', startTimeUnixNano: '1750000000000000000', endTimeUnixNano: '1750000000250000000', attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'x' } }] }] }] }],
    resourceMetrics: [{ resource: {}, scopeMetrics: [{ metrics: [{ name: 'm', sum: { aggregationTemporality: 1, dataPoints: [{ asInt: '4' }] } }] }] }],
  };
  const recs = P.normalizeObject(otlp, 1);
  assert.equal(recs[0].kind, 'span');
  assert.equal(recs[0].durationMs, 250);
  assert.equal(recs[0].resource['session.id'], 'w');
  assert.equal(recs[1].kind, 'metric');
  assert.equal(recs[1].temporality, 'delta');
  assert.equal(recs[1].value, 4);
});

test('parses real SDK file-exporter output (fixture produced with Copilot exporter code + SDK 0.212/2.x)', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk-file-exporter.jsonl'), 'utf8');
  const a = P.analyzeJsonl(text);
  assert.equal(a.summary.parseErrors, 0);
  assert.equal(a.summary.unknown, 0);
  assert.equal(a.summary.lostSpans, 1); // the span really serializes as {}
  assert.equal(a.summary.logs, 4);
  assert.equal(a.summary.metricExports, 3);
  assert.equal(a.summary.llmCalls, 1);
  assert.equal(a.summary.inputTokens, 1200);
  assert.equal(a.summary.outputTokens, 340);
  assert.equal(a.summary.toolCalls, 1);
  assert.equal(a.summary.linesAdded, 15); // 12 + 3 across cumulative exports, not double counted
  assert.ok(a.summary.timeRange.start > 1.7e12);

  const agg = [...P.aggregateMetrics(P.parseJsonl(text).records).values()];
  const dur = agg.find(m => m.name === 'gen_ai.client.operation.duration');
  assert.equal(dur.value.count, 3);
  assert.equal(dur.value.sum, 6.5);
});

test('analyzes generated sample consistently (events vs metrics)', () => {
  const out = path.join(os.tmpdir(), `copilot-otel-test-${process.pid}.jsonl`);
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'generate-sample-data.js'), '--out', out, '--seed', '7']);
  try {
    const a = P.analyzeJsonl(fs.readFileSync(out, 'utf8'));
    assert.ok(a.summary.logs > 0 && a.summary.metricExports > 0 && a.summary.lostSpans > 0);
    assert.equal(a.summary.parseErrors, 0);
    assert.equal(a.sources.llm, 'events');
    assert.equal(a.sources.tools, 'events');

    const agg = P.aggregateMetrics(P.parseJsonl(fs.readFileSync(out, 'utf8')).records.filter(r => r.kind === 'metric'));
    let toolCount = 0;
    let inputTokens = 0;
    for (const m of agg.values()) {
      if (m.name === 'copilot_chat.tool.call.count') toolCount += m.value;
      if (m.name === 'gen_ai.client.token.usage' && m.attributes['gen_ai.token.type'] === 'input') inputTokens += m.value.sum;
    }
    assert.equal(toolCount, a.summary.toolCalls);
    assert.equal(inputTokens, a.summary.inputTokens);

    const sessions = P.listSessions(P.parseJsonl(fs.readFileSync(out, 'utf8')).records);
    const filtered = P.analyzeJsonl(fs.readFileSync(out, 'utf8'), { sessionId: sessions[0].id });
    assert.equal(filtered.summary.sessions, 1);
    assert.ok(filtered.summary.llmCalls < a.summary.llmCalls);
  } finally {
    fs.rmSync(out, { force: true });
  }
});
