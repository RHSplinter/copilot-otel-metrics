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

test('labels sessions with repo/branch from workspace metadata, falling back to session id', () => {
  const cli = { _rawAttributes: [['service.name', 'github-copilot'], ['service.version', '1.0.92']] };
  const noRepo = { _rawAttributes: [['service.name', 'copilot-chat'], ['session.id', '9c2d7767-aaaa-bbbb-cccc-1234567890ab1791790200000']] };
  const text = [
    sdkLog('copilot_chat.edit.feedback', { outcome: 'accepted', 'copilot_chat.repo.remote_url': 'https://github.com/octo/app.git', 'copilot_chat.repo.head_branch_name': 'dev' }),
    sdkLog('copilot_chat.tool.call', {}),
    Object.assign(sdkLog('copilot_chat.tool.call', {}), { resource: cli }),
    Object.assign(sdkLog('copilot_chat.tool.call', {}), { resource: noRepo }),
  ].map(o => JSON.stringify(o)).join('\n');
  const sessions = P.listSessions(P.parseJsonl(text).records);
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));
  assert.equal(byId['win-1'].label, 'octo/app @ dev');
  assert.equal(byId['(no session.id)'].label, 'github-copilot (no session.id)');
  assert.equal(byId['9c2d7767-aaaa-bbbb-cccc-1234567890ab1791790200000'].label, '9c2d7767…0000');
});

test('tags sessions with HydraFusion models without changing labels or mixing sessions', () => {
  const log = (id, attrs) => Object.assign(sdkLog('gen_ai.client.inference.operation.details', attrs), {
    resource: { attributes: { 'session.id': id } },
  });
  const records = P.parseJsonl([
    log('fusion', { 'gen_ai.request.model': 'hydrafusion' }),
    log('fusion', { 'gen_ai.request.model': 'hydrafusion' }),
    log('max', { 'gen_ai.response.model': 'hydrafusion-max' }),
    log('both', { 'gen_ai.request.model': 'hydrafusion-max' }),
    log('both', { 'gen_ai.request.model': 'hydrafusion' }),
    log('ordinary', { 'gen_ai.request.model': 'gpt-4o', prompt: 'hydrafusion-max' }),
    log('ordinary', {}),
    sdkSum('gen_ai.client.token.usage', 10, { 'gen_ai.request.model': 'hydrafusion' }, 1750000060),
  ].map(JSON.stringify).join('\n')).records;
  const sessions = Object.fromEntries(P.listSessions(records).map(s => [s.id, s]));
  assert.deepEqual(sessions.fusion.tags, ['HydraFusion']);
  assert.deepEqual(sessions.max.tags, ['HydraFusion Max']);
  assert.deepEqual(sessions.both.tags, ['HydraFusion', 'HydraFusion Max']);
  assert.deepEqual(sessions.ordinary.tags, []);
  assert.deepEqual(sessions['win-1'].tags, [], 'metrics are aggregated across sessions and must not tag one');
  assert.equal(sessions.fusion.label, 'fusion');
});

test('orders sessions by latest activity first, with undated sessions last', () => {
  const record = (id, time) => ({
    kind: 'log', resource: { 'session.id': id }, attributes: {}, time,
  });
  const records = [
    record('undated'),
    record('resumed', 100),
    record('newer-start', 200),
    record('resumed', 300),
  ];
  assert.deepEqual(P.listSessions(records).map(s => s.id), ['resumed', 'newer-start', 'undated']);
  assert.deepEqual(P.listSessions([...records].reverse()).map(s => s.id), ['resumed', 'newer-start', 'undated']);
});

test('splits Copilot CLI records per conversation, tags HydraFusion and uses CLI session titles', () => {
  const res = { attributes: { 'service.name': 'github-copilot', 'service.version': '1.0.95' } };
  const span = (traceId, name, attributes) => ({ type: 'span', traceId, spanId: name + traceId, name, startTime: [1791969299, 0], endTime: [1791969300, 0], attributes, resource: res });
  const records = P.parseJsonl([
    span('t1', 'invoke_agent', { 'gen_ai.conversation.id': 'conv-a', 'gen_ai.request.model': 'hydrafusion' }),
    span('t1', 'chat claude', { 'gen_ai.request.model': 'claude-opus-5.5' }),
    span('t2', 'chat hydrafusion-max', { 'gen_ai.conversation.id': 'conv-b', 'gen_ai.request.model': 'hydrafusion-max' }),
    span('t3', 'chat gpt', { 'gen_ai.conversation.id': 'conv-c', 'gen_ai.request.model': 'gpt-5.3-codex' }),
    { type: 'metric', name: 'gen_ai.client.operation.duration', dataPoints: [{ attributes: { 'gen_ai.request.model': 'hydrafusion' }, startTime: [1791969299, 0], endTime: [1791969300, 0], value: 1 }], resource: res },
  ].map(o => JSON.stringify(o)).join('\n')).records;
  const sessionInfo = { 'conv-a': { name: 'Copilot otel dashboard', repository: 'octo/app', branch: 'main' } };
  const byId = Object.fromEntries(P.listSessions(records, { sessionInfo }).map(s => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['(no session.id)', 'conv-a', 'conv-b', 'conv-c']);
  assert.deepEqual(byId['conv-a'].tags, ['HydraFusion']);
  assert.equal(byId['conv-a'].records, 2, 'child span inherits the conversation through its trace');
  assert.equal(byId['conv-a'].label, 'Copilot otel dashboard');
  assert.equal(byId['conv-a'].repo, 'octo/app');
  assert.deepEqual(byId['conv-b'].tags, ['HydraFusion Max']);
  assert.deepEqual(byId['conv-c'].tags, []);
  assert.deepEqual(byId['(no session.id)'].tags, []);
  assert.equal(P.analyze(records, { sessionId: 'conv-a' }).summary.spans, 2);
});

test('analyzes generated sample consistently (events vs metrics)', () => {
  const out = path.join(os.tmpdir(), `copilot-otel-test-${process.pid}.jsonl`);
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'generate-sample-data.js'), '--out', out, '--seed', '7']);
  try {
    const a = P.analyzeJsonl(fs.readFileSync(out, 'utf8'));
    assert.ok(a.summary.logs > 0 && a.summary.metricExports > 0 && a.summary.lostSpans > 0);
    assert.equal(a.summary.parseErrors, 0);
    assert.equal(a.sources.llm, 'events + spans');
    assert.equal(a.sources.tools, 'events + spans');
    assert.ok(a.capabilities.agents.length > 0 && a.capabilities.skills.length > 0);

    // VS Code (copilot-chat) events must agree with its own metrics; the sample's CLI session is excluded.
    const vscodeRecords = P.parseJsonl(fs.readFileSync(out, 'utf8')).records.filter(r => !r.resource || r.resource['service.name'] !== 'github-copilot');
    const v = P.analyze(vscodeRecords);
    assert.equal(v.sources.llm, 'events');
    assert.equal(v.sources.tools, 'events');

    const agg = P.aggregateMetrics(vscodeRecords.filter(r => r.kind === 'metric'));
    let toolCount = 0;
    let inputTokens = 0;
    for (const m of agg.values()) {
      if (m.name === 'copilot_chat.tool.call.count') toolCount += m.value;
      if (m.name === 'gen_ai.client.token.usage' && m.attributes['gen_ai.token.type'] === 'input') inputTokens += m.value.sum;
    }
    assert.equal(toolCount, v.summary.toolCalls);
    assert.equal(inputTokens, v.summary.inputTokens);

    const sessions = P.listSessions(P.parseJsonl(fs.readFileSync(out, 'utf8')).records);
    const filtered = P.analyzeJsonl(fs.readFileSync(out, 'utf8'), { sessionId: sessions[0].id });
    assert.equal(filtered.summary.sessions, 1);
    assert.ok(filtered.summary.llmCalls < a.summary.llmCalls);
  } finally {
    fs.rmSync(out, { force: true });
  }
});
