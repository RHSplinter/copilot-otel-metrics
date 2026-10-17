#!/usr/bin/env node
/*
 * Generates a realistic sample of GitHub Copilot Chat OTel `file` exporter output.
 *
 * The shapes mirror what `FileLogExporter` / `FileMetricExporter` / `FileSpanExporter` in
 * microsoft/vscode-copilot-chat write (JSON.stringify of OpenTelemetry SDK objects):
 * Field names match real exporter output (see test/fixtures/sdk-file-exporter.jsonl):
 *  - LogRecordImpl  -> { hrTime, hrTimeObserved, spanContext, resource: { _rawAttributes }, instrumentationScope, attributes, _body, ... }
 *  - ResourceMetrics -> { resource, scopeMetrics: [{ scope, metrics: [{ descriptor, dataPointType, dataPoints }] }] }
 *  - Spans          -> `{}` (circular SDK span cannot be stringified, see microsoft/vscode#319993)
 *                      or, with --fixed-spans, the plain snapshot proposed in the upstream fix.
 * Plus one simulated Copilot CLI session (service.name github-copilot), which always writes full spans
 * (invoke_agent with skill/MCP/custom-agent context, skill + hashed MCP tool calls, permissions, startup timings)
 * and `{"type":"metric", ...}` metric lines.
 *
 * Usage: node scripts/generate-sample-data.js [--out data/sample-copilot-otel.jsonl] [--fixed-spans] [--seed 42]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const argValue = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const OUT = path.resolve(argValue('--out', path.join(__dirname, '..', 'data', 'sample-copilot-otel.jsonl')));
const FIXED_SPANS = args.includes('--fixed-spans');
let seed = Number(argValue('--seed', 42));

// --- deterministic PRNG -------------------------------------------------------
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = arr => arr[Math.floor(rand() * arr.length)];
const weighted = pairs => { const total = pairs.reduce((s, p) => s + p[1], 0); let r = rand() * total; for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs[0][0]; };
const hex = n => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
const hr = ms => [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)];

// --- domain data --------------------------------------------------------------
const MODELS = [
  { req: 'claude-sonnet-4.5', res: 'claude-sonnet-4.5', w: 5, ttft: [600, 1800], tps: 70 },
  { req: 'gpt-5.2-codex', res: 'gpt-5.2-codex-2026-01-14', w: 3, ttft: [400, 1500], tps: 90 },
  { req: 'gpt-4.1', res: 'gpt-4.1-2025-04-14', w: 2, ttft: [250, 700], tps: 110 },
  { req: 'gpt-5-mini', res: 'gpt-5-mini-2025-08-07', w: 1, ttft: [200, 500], tps: 140 },
];
const TOOLS = [
  ['read_file', 30, [5, 80], 0.01, 'FileNotFoundError'],
  ['grep_search', 14, [40, 400], 0.02, 'TimeoutError'],
  ['replace_string_in_file', 16, [20, 150], 0.08, 'NoMatchError'],
  ['run_in_terminal', 10, [800, 25000], 0.12, 'CommandFailedError'],
  ['file_search', 8, [30, 200], 0.0, null],
  ['semantic_search', 5, [300, 2000], 0.03, 'TimeoutError'],
  ['create_file', 6, [10, 60], 0.02, 'FileExistsError'],
  ['get_errors', 6, [100, 900], 0.0, null],
  ['manage_todo_list', 4, [2, 15], 0.0, null],
  ['runSubagent', 2, [8000, 60000], 0.1, 'Error'],
  ['mcp_github_search_issues', 2, [400, 3000], 0.05, 'McpError'],
];
const LANGS = [['typescript', 6], ['python', 3], ['csharp', 2], ['markdown', 2], ['json', 1], ['bicep', 1]];
const EDIT_SOURCES = ['apply_patch', 'replace_string', 'code_mapper', 'inline_chat'];
const VERSIONS = ['0.63.2', '0.64.0', '0.65.0'];

// --- metric state (cumulative, per resource) ----------------------------------
const BOUNDARIES = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];
const METRIC_DEFS = {
  'gen_ai.client.operation.duration': { type: 0, unit: 's', description: 'GenAI operation duration.', valueType: 1 },
  'gen_ai.client.token.usage': { type: 0, unit: '{token}', description: 'Number of input and output tokens used.', valueType: 0 },
  'copilot_chat.tool.call.count': { type: 3, unit: '{call}', description: 'Number of tool calls.', valueType: 0 },
  'copilot_chat.tool.call.duration': { type: 0, unit: 'ms', description: 'Tool call duration.', valueType: 1 },
  'copilot_chat.agent.invocation.duration': { type: 0, unit: 's', description: 'Agent mode end-to-end duration.', valueType: 1 },
  'copilot_chat.agent.turn.count': { type: 0, unit: '{turn}', description: 'LLM round-trips per agent invocation.', valueType: 0 },
  'copilot_chat.session.count': { type: 3, unit: '{session}', description: 'Chat sessions started.', valueType: 0 },
  'copilot_chat.time_to_first_token': { type: 0, unit: 's', description: 'Time to first SSE token.', valueType: 1 },
  'copilot_chat.edit.acceptance.count': { type: 3, unit: '{edit}', description: 'Edit accept/reject decisions.', valueType: 0 },
  'copilot_chat.lines_of_code.count': { type: 3, unit: '{line}', description: 'Lines of code added/removed by accepted agent edits.', valueType: 0 },
  'copilot_chat.user.action.count': { type: 3, unit: '{action}', description: 'User engagement actions.', valueType: 0 },
  'copilot_chat.user.feedback.count': { type: 3, unit: '{vote}', description: 'Thumbs up/down on chat responses.', valueType: 0 },
  'copilot_chat.agent.edit_response.count': { type: 3, unit: '{response}', description: 'Agent edit responses by outcome.', valueType: 0 },
  'copilot_chat.agent.summarization.count': { type: 3, unit: '{event}', description: 'Context summarization outcomes.', valueType: 0 },
};

function createWindow(startMs, version, repo) {
  const sessionId = uuid() + String(startMs);
  const raw = [
    ['service.name', 'copilot-chat'],
    ['service.version', version],
    ['session.id', sessionId],
  ];
  return {
    version,
    startMs,
    resource: { _rawAttributes: raw, _asyncAttributesPending: false },
    plainAttributes: Object.fromEntries(raw),
    scope: { name: 'copilot-chat', version },
    // Workspace metadata Copilot adds to edit events (workspaceOTelMetadata.ts)
    ws: repo ? { 'copilot_chat.repo.head_branch_name': repo.branch, 'copilot_chat.repo.head_commit_hash': hex(40), 'copilot_chat.repo.remote_url': repo.url } : {},
    series: new Map(), // metric|attrsJSON -> { name, attributes, value }
  };
}

function record(win, name, attributes, value) {
  const def = METRIC_DEFS[name];
  const key = name + '|' + JSON.stringify(attributes);
  let s = win.series.get(key);
  if (!s) {
    s = { name, attributes, value: def.type === 0 ? { min: Infinity, max: -Infinity, sum: 0, count: 0, buckets: { boundaries: BOUNDARIES, counts: new Array(BOUNDARIES.length + 1).fill(0) } } : 0 };
    win.series.set(key, s);
  }
  if (def.type === 0) {
    const v = s.value;
    v.min = Math.min(v.min, value); v.max = Math.max(v.max, value); v.sum += value; v.count++;
    let i = BOUNDARIES.findIndex(b => value <= b); if (i < 0) i = BOUNDARIES.length;
    v.buckets.counts[i]++;
  } else {
    s.value += value;
  }
}

// --- output -------------------------------------------------------------------
const lines = [];
let pendingSpans = [];

function emitLog(win, timeMs, body, attributes, traceId, spanId) {
  lines.push({
    hrTime: hr(timeMs),
    hrTimeObserved: hr(timeMs),
    spanContext: traceId ? { traceId, spanId, traceFlags: 1 } : undefined,
    resource: win.resource,
    instrumentationScope: win.scope,
    attributes,
    _body: body,
    totalAttributesCount: Object.keys(attributes).length,
    _isReadonly: true,
    _logRecordLimits: { attributeCountLimit: 128, attributeValueLengthLimit: null },
  });
}

function addSpan(win, s) {
  pendingSpans.push(FIXED_SPANS ? {
    resource: { attributes: win.plainAttributes, asyncAttributesPending: false },
    instrumentationScope: win.scope,
    traceId: s.traceId, spanId: s.spanId, traceFlags: 1, isRemote: false,
    parentSpanContext: s.parentSpanId ? { traceId: s.traceId, spanId: s.parentSpanId, traceFlags: 1, isRemote: false } : undefined,
    name: s.name, kind: s.kind,
    startTime: hr(s.start), endTime: hr(s.end), duration: hr(s.end - s.start), ended: true,
    attributes: s.attributes,
    status: { code: s.attributes['error.type'] ? 2 : 0 },
    events: [], links: [], droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
  } : {});
}

function flushSpans() {
  for (const s of pendingSpans) lines.push(s);
  pendingSpans = [];
}

function exportMetrics(win, timeMs) {
  const byName = new Map();
  for (const s of win.series.values()) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  const metrics = [];
  for (const [name, series] of byName) {
    const def = METRIC_DEFS[name];
    metrics.push({
      // Copilot creates instruments without unit/description; the SDK serializes them as ''.
      descriptor: { name, type: def.type === 0 ? 'HISTOGRAM' : 'COUNTER', description: '', unit: '', valueType: 1, advice: {} },
      aggregationTemporality: 1,
      dataPointType: def.type,
      ...(def.type === 3 ? { isMonotonic: true } : {}),
      dataPoints: series.map(s => ({
        attributes: s.attributes,
        startTime: hr(win.startMs),
        endTime: hr(timeMs),
        value: def.type === 0 ? { ...s.value, buckets: { boundaries: s.value.buckets.boundaries, counts: [...s.value.buckets.counts] } } : s.value,
      })),
    });
  }
  if (metrics.length) lines.push({ resource: win.resource, scopeMetrics: [{ scope: win.scope, metrics }] });
}

// --- simulation ---------------------------------------------------------------
function simulateInvocation(win, t, model, agentName) {
  const traceId = hex(32);
  const rootSpanId = hex(16);
  const invStart = t;
  const turns = weighted([[1, 2], [2, 3], [3, 4], [4, 4], [5, 3], [6, 2], [8, 1], [12, 1]]);
  let totalIn = 0, totalOut = 0;
  let ctxTokens = randInt(9000, 16000);

  for (let turn = 0; turn < turns; turn++) {
    const isLast = turn === turns - 1;
    const chatSpanId = hex(16);
    const ttft = randInt(model.ttft[0], model.ttft[1]);
    const out = isLast ? randInt(250, 1800) : randInt(40, 420);
    const dur = ttft + Math.round((out / model.tps) * 1000);
    const failed = rand() < 0.015;
    const inTok = ctxTokens;
    t += dur;

    const attrs = {
      'event.name': 'gen_ai.client.inference.operation.details',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': model.req,
    };
    if (!failed) {
      Object.assign(attrs, {
        'gen_ai.response.model': model.res,
        'gen_ai.response.id': `chatcmpl-${hex(24)}`,
        'gen_ai.response.finish_reasons': [isLast ? weighted([['stop', 20], ['length', 1]]) : 'tool_calls'],
        'gen_ai.usage.input_tokens': inTok,
        'gen_ai.usage.output_tokens': out,
      });
    }
    attrs['gen_ai.request.max_tokens'] = 16384;
    if (failed) attrs['error.type'] = pick(['TimeoutError', 'RateLimitError', 'ServerError']);
    emitLog(win, t, `GenAI inference: ${model.req}`, attrs, traceId, chatSpanId);

    const mAttrs = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github', 'gen_ai.request.model': model.req, ...(failed ? { 'error.type': attrs['error.type'] } : { 'gen_ai.response.model': model.res }), 'server.address': 'api.githubcopilot.com' };
    record(win, 'gen_ai.client.operation.duration', mAttrs, dur / 1000);
    record(win, 'copilot_chat.time_to_first_token', { 'gen_ai.request.model': model.req }, ttft / 1000);
    addSpan(win, { traceId, spanId: chatSpanId, parentSpanId: rootSpanId, name: `chat ${model.req}`, kind: 2, start: t - dur, end: t, attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github', 'gen_ai.request.model': model.req, 'gen_ai.response.model': model.res, 'gen_ai.usage.input_tokens': inTok, 'gen_ai.usage.output_tokens': out, 'copilot_chat.time_to_first_token': ttft } });
    if (failed) continue;

    totalIn += inTok; totalOut += out;
    const tokAttrs = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github', 'gen_ai.request.model': model.req, 'gen_ai.response.model': model.res };
    record(win, 'gen_ai.client.token.usage', { ...tokAttrs, 'gen_ai.token.type': 'input' }, inTok);
    record(win, 'gen_ai.client.token.usage', { ...tokAttrs, 'gen_ai.token.type': 'output' }, out);

    const toolCount = isLast ? 0 : weighted([[1, 6], [2, 3], [3, 2], [4, 1]]);
    emitLog(win, t, `copilot_chat.agent.turn: ${turn}`, { 'event.name': 'copilot_chat.agent.turn', 'turn.index': turn, 'gen_ai.usage.input_tokens': inTok, 'gen_ai.usage.output_tokens': out, tool_call_count: toolCount }, traceId, rootSpanId);

    for (let k = 0; k < toolCount; k++) {
      const [name, , range, failRate, errType] = weighted(TOOLS.map(tl => [tl, tl[1]]));
      const d = randInt(range[0], range[1]);
      const ok = rand() >= failRate;
      t += d;
      const tAttrs = { 'event.name': 'copilot_chat.tool.call', 'gen_ai.tool.name': name, duration_ms: d, success: ok };
      if (!ok) tAttrs['error.type'] = errType;
      emitLog(win, t, `copilot_chat.tool.call: ${name}`, tAttrs, traceId, rootSpanId);
      record(win, 'copilot_chat.tool.call.count', { 'gen_ai.tool.name': name, success: ok }, 1);
      record(win, 'copilot_chat.tool.call.duration', { 'gen_ai.tool.name': name }, d);
      addSpan(win, { traceId, spanId: hex(16), parentSpanId: rootSpanId, name: `execute_tool ${name}`, kind: 0, start: t - d, end: t, attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name, 'gen_ai.tool.type': name.startsWith('mcp_') ? 'extension' : 'function', 'gen_ai.tool.call.id': `call_${hex(20)}`, ...(ok ? {} : { 'error.type': errType }) } });

      if (ok && (name === 'replace_string_in_file' || name === 'create_file')) simulateEdit(win, t, name === 'create_file' ? 'apply_patch' : 'replace_string');
      ctxTokens += randInt(300, 4500);
    }
    ctxTokens += out + randInt(50, 400);
    if (ctxTokens > 110000 && rand() < 0.7) {
      const ok = rand() > 0.1;
      record(win, 'copilot_chat.agent.summarization.count', { outcome: ok ? 'applied' : 'failed' }, 1);
      if (ok) ctxTokens = randInt(20000, 30000);
    }
    t += randInt(20, 200);
  }

  const invDur = (t - invStart) / 1000;
  record(win, 'copilot_chat.agent.invocation.duration', { 'gen_ai.agent.name': agentName }, invDur);
  record(win, 'copilot_chat.agent.turn.count', { 'gen_ai.agent.name': agentName }, turns);
  record(win, 'copilot_chat.agent.edit_response.count', { outcome: rand() < 0.94 ? 'success' : 'error' }, 1);
  addSpan(win, { traceId, spanId: rootSpanId, name: `invoke_agent ${agentName}`, kind: 0, start: invStart, end: t, attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': 'github', 'gen_ai.agent.name': agentName, 'gen_ai.conversation.id': uuid(), 'gen_ai.request.model': model.req, 'gen_ai.response.model': model.res, 'gen_ai.usage.input_tokens': totalIn, 'gen_ai.usage.output_tokens': totalOut, 'copilot_chat.turn_count': turns } });

  // user reactions after the response
  if (rand() < 0.18) {
    const rating = rand() < 0.78 ? 'positive' : 'negative';
    emitLog(win, t + randInt(2000, 20000), `copilot_chat.user.feedback: ${rating}`, { 'event.name': 'copilot_chat.user.feedback', rating, participant: agentName, conversation_id: uuid(), request_id: uuid() });
    record(win, 'copilot_chat.user.feedback.count', { rating }, 1);
  }
  if (rand() < 0.3) record(win, 'copilot_chat.user.action.count', { action: weighted([['copy', 4], ['insert', 2], ['apply', 2], ['followup', 3]]) }, 1);
  return t;
}

function simulateEdit(win, t, source) {
  const lang = weighted(LANGS);
  const requestId = uuid();
  const hunks = randInt(1, 3);
  let added = 0, removed = 0;
  for (let h = 0; h < hunks; h++) {
    const la = randInt(1, 40), lr = randInt(0, 25);
    const outcome = rand() < 0.83 ? 'accepted' : 'rejected';
    emitLog(win, t + 1500 + h * 400, `copilot_chat.edit.hunk.action: ${outcome}`, { 'event.name': 'copilot_chat.edit.hunk.action', outcome, language_id: lang, request_id: requestId, line_count: la + lr, lines_added: la, lines_removed: lr, ...win.ws });
    record(win, 'copilot_chat.edit.acceptance.count', { 'copilot_chat.edit.source': 'chat_editing_hunk', 'copilot_chat.edit.outcome': outcome, 'copilot_chat.language_id': lang }, 1);
    if (outcome === 'accepted') { added += la; removed += lr; }
  }
  const fileOutcome = added ? 'accepted' : 'rejected';
  emitLog(win, t + 4000, `copilot_chat.edit.feedback: ${fileOutcome}`, { 'event.name': 'copilot_chat.edit.feedback', outcome: fileOutcome, language_id: lang, participant: 'copilot', request_id: requestId, edit_surface: 'agent', has_remaining_edits: false, is_notebook: false, ...win.ws });
  record(win, 'copilot_chat.edit.acceptance.count', { 'copilot_chat.edit.source': source, 'copilot_chat.edit.outcome': fileOutcome, 'copilot_chat.language_id': lang }, 1);
  if (!added) return;
  record(win, 'copilot_chat.lines_of_code.count', { type: 'added', 'copilot_chat.language_id': lang }, added);
  record(win, 'copilot_chat.lines_of_code.count', { type: 'removed', 'copilot_chat.language_id': lang }, removed);
  let fourGram = 1, noRevert = 1;
  for (const delay of [5000, 30000, 120000, 300000, 600000, 900000]) {
    fourGram = Math.max(0, fourGram - rand() * 0.08);
    noRevert = Math.max(0, noRevert - rand() * 0.05);
    if (rand() < 0.5) emitLog(win, t + delay, 'copilot_chat.edit.survival', { 'event.name': 'copilot_chat.edit.survival', edit_source: source, survival_rate_four_gram: +fourGram.toFixed(3), survival_rate_no_revert: +noRevert.toFixed(3), time_delay_ms: delay, did_branch_change: false, request_id: requestId, ...win.ws });
  }
}

function simulateInlineChat(win, t) {
  const lang = weighted(LANGS);
  const accepted = rand() < 0.7;
  const editCount = randInt(1, 4);
  emitLog(win, t, `copilot_chat.inline.done: ${accepted ? 'accepted' : 'rejected'}`, { 'event.name': 'copilot_chat.inline.done', accepted, language_id: lang, edit_count: editCount, edit_line_count: editCount * randInt(2, 15), reply_type: 'inlineChatEdit', is_notebook: false, ...win.ws });
  record(win, 'copilot_chat.edit.acceptance.count', { 'copilot_chat.edit.source': 'inline_chat', 'copilot_chat.edit.outcome': accepted ? 'accepted' : 'rejected', 'copilot_chat.language_id': lang }, 1);
}

// 4 VS Code windows across 3 days (one restart on a newer version)
const base = Date.UTC(2026, 9, 12, 7, 30);
const windows = [
  { start: base, version: VERSIONS[0], chats: 4, repo: { url: 'https://github.com/contoso/web-shop.git', branch: 'main' } },
  { start: base + 26 * 3600e3, version: VERSIONS[1], chats: 5, repo: { url: 'https://github.com/contoso/web-shop.git', branch: 'feature/checkout' } },
  { start: base + 27.5 * 3600e3, version: VERSIONS[1], chats: 2, repo: { url: 'https://github.com/contoso/infra.git', branch: 'main' } },
  { start: base + 49 * 3600e3, version: VERSIONS[2], chats: 5 },
];

for (const w of windows) {
  const win = createWindow(w.start, w.version, w.repo);
  let t = w.start + randInt(60e3, 600e3);
  for (let c = 0; c < w.chats; c++) {
    const model = weighted(MODELS.map(m => [m, m.w]));
    const agentName = weighted([['copilot', 9], ['workspace', 1]]);
    const chatSessionId = uuid();
    emitLog(win, t, 'copilot_chat.session.start', { 'event.name': 'copilot_chat.session.start', 'session.id': chatSessionId, 'gen_ai.request.model': model.req, 'gen_ai.agent.name': agentName });
    record(win, 'copilot_chat.session.count', {}, 1);
    const invocations = randInt(1, 5);
    for (let i = 0; i < invocations; i++) {
      t = simulateInvocation(win, t + randInt(15e3, 240e3), model, agentName);
      if (rand() < 0.5) flushSpans();
      if (rand() < 0.6) exportMetrics(win, t + randInt(1000, 60e3));
      if (rand() < 0.25) simulateInlineChat(win, t + randInt(60e3, 300e3));
    }
    t += randInt(10 * 60e3, 90 * 60e3);
  }
  flushSpans();
  exportMetrics(win, t + 60e3);
}

// --- Copilot CLI (always writes full spans + its own metric line format) -------------------------------------
const sha = s => require('node:crypto').createHash('sha256').update(s).digest('hex');
const CLI_RES = { attributes: { 'service.name': 'github-copilot', 'service.version': '1.0.95-0' }, schemaUrl: 'https://opentelemetry.io/schemas/1.44.0' };
const CLI_SCOPE = { name: 'github.copilot', version: '1.0.95-0' };
const CLI_SKILLS = ['code-review', 'release-notes', 'terraform-azure', 'write-tests', 'docs-style'];
const CLI_AGENTS = ['docs-writer', 'security-reviewer'];
// 'contoso-internal-docs' is intentionally not a well-known name, so it stays hashed unless a local MCP config defines it
const CLI_MCP = { 'github-mcp-server': ['get_file_contents', 'search_code', 'list_pull_requests'], 'contoso-internal-docs': ['search_docs'] };
const CLI_TOOLS = [['view', 10], ['powershell', 6], ['edit', 5], ['grep', 4], ['glob', 2]];
const cliCounters = new Map();

function cliSpan(traceId, spanId, parentSpanId, name, start, end, attributes, failed) {
  lines.push({ type: 'span', traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, kind: 0, startTime: hr(start), endTime: hr(end), attributes, status: { code: failed ? 2 : 0 }, events: [], resource: CLI_RES, instrumentationScope: CLI_SCOPE });
}

function cliCount(name, attributes, value) {
  const key = name + '|' + JSON.stringify(attributes);
  cliCounters.set(key, { name, attributes, value: (cliCounters.get(key) || { value: 0 }).value + value });
}

function exportCliMetrics(startMs, timeMs) {
  for (const c of cliCounters.values()) {
    lines.push({ type: 'metric', name: c.name, description: 'Number of completed MCP server connection attempts by transport and outcome.', unit: '{attempt}', dataPoints: [{ attributes: c.attributes, startTime: hr(startMs), endTime: hr(timeMs), value: c.value }], resource: CLI_RES, instrumentationScope: CLI_SCOPE });
  }
}

function simulateCliSession(startMs, conversations) {
  let t = startMs;
  const mcpHashes = Object.keys(CLI_MCP).map(sha);
  for (let i = 0; i < 3; i++) {
    const traceId = hex(32), rootId = hex(16);
    for (const [phase, dur] of [['mcp_startup_wait', randInt(400, 1600)], ['skills_loading', randInt(10, 60)], ['custom_agent_loading', randInt(5, 30)], ['external_tool_registration', randInt(1, 8)]]) {
      cliSpan(traceId, hex(16), rootId, `session.timing.${phase}`, t, t + dur, { 'github.copilot.session.timing.phase': phase, 'github.copilot.session.timing.duration_ms': dur });
    }
    for (let s = 0; s < mcpHashes.length; s++) cliCount('github.copilot.mcp.server.connection.count', { outcome: rand() < 0.85 ? 'success' : 'failure' }, 1);
    t += randInt(2000, 5000);
  }
  for (let c = 0; c < conversations; c++) {
    const conv = uuid();
    const traceId = hex(32), invId = hex(16);
    const start = t;
    const model = pick(MODELS);
    const turns = randInt(2, 6);
    let inTok = 0, outTok = 0;
    for (let turn = 0; turn < turns; turn++) {
      const d = randInt(2000, 9000), ti = randInt(20000, 60000), to = randInt(100, 900);
      cliSpan(traceId, hex(16), invId, `chat ${model.req}`, t, t + d, { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github', 'gen_ai.conversation.id': conv, 'gen_ai.request.model': model.req, 'gen_ai.response.model': model.res, 'gen_ai.usage.input_tokens': ti, 'gen_ai.usage.output_tokens': to });
      t += d; inTok += ti; outTok += to;
      for (let k = randInt(1, 3); k > 0; k--) {
        const r = rand();
        const d2 = randInt(20, 3000);
        const base = { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.conversation.id': conv, 'gen_ai.tool.call.id': `call_${hex(20)}`, 'gen_ai.tool.type': 'function', 'gen_ai.provider.name': 'github' };
        if (r < 0.15) {
          const skill = weighted([[CLI_SKILLS[0], 4], [CLI_SKILLS[1], 2], [CLI_SKILLS[3], 1]]);
          cliSpan(traceId, hex(16), invId, `execute_tool skill ${skill}`, t, t + d2, { ...base, 'gen_ai.tool.name': 'skill', 'gen_ai.skill.name': skill });
        } else if (r < 0.4) {
          const server = weighted([['github-mcp-server', 4], ['contoso-internal-docs', 1]]);
          const tool = `${sha(server)}/${sha(pick(CLI_MCP[server]))}`;
          const failed = rand() < 0.08;
          cliSpan(traceId, hex(16), invId, `execute_tool ${tool}`, t, t + d2, { ...base, 'gen_ai.tool.name': tool, 'github.copilot.tool.parameters.mcp_server_name_hash': sha(server), ...(failed ? { 'error.type': 'McpError' } : {}) }, failed);
        } else {
          const tool = weighted(CLI_TOOLS);
          if (tool === 'powershell' || tool === 'edit') {
            const result = weighted([['approved', 12], ['denied-interactively-by-user', 1]]);
            cliSpan(traceId, hex(16), invId, 'permission', t, t + randInt(50, 8000), { 'gen_ai.conversation.id': conv, 'github.copilot.permission.kind': tool === 'edit' ? 'write' : 'shell', 'github.copilot.permission.result': result });
            if (result !== 'approved') continue;
          }
          cliSpan(traceId, hex(16), invId, `execute_tool ${tool}`, t, t + d2, { ...base, 'gen_ai.tool.name': tool });
        }
        t += d2;
      }
    }
    if (rand() < 0.4) {
      const subId = hex(16), d = randInt(15000, 60000);
      cliSpan(traceId, subId, invId, 'invoke_agent explore', t, t + d, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': 'github', 'gen_ai.agent.name': 'explore', 'gen_ai.conversation.id': conv, 'github.copilot.agent.type': 'builtin', 'gen_ai.usage.input_tokens': randInt(30000, 90000), 'gen_ai.usage.output_tokens': randInt(500, 2500), 'github.copilot.turn_count': randInt(2, 6) });
      t += d;
    }
    const custom = rand() < 0.25;
    cliSpan(traceId, invId, undefined, 'invoke_agent', start, t, {
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': 'github', 'gen_ai.conversation.id': conv,
      ...(custom ? { 'gen_ai.agent.name': CLI_AGENTS[0] } : {}),
      'github.copilot.context.skills': JSON.stringify(CLI_SKILLS),
      'github.copilot.context.mcp_server_names': JSON.stringify(mcpHashes),
      'github.copilot.context.custom_agent_names': JSON.stringify(CLI_AGENTS),
      'github.copilot.agent.type': custom ? 'custom' : 'builtin',
      'gen_ai.usage.input_tokens': inTok, 'gen_ai.usage.output_tokens': outTok,
      'github.copilot.cost': randInt(1, 4), 'github.copilot.turn_count': turns,
    });
    t += randInt(60e3, 600e3);
  }
  exportCliMetrics(startMs, t);
}
simulateCliSession(base + 50 * 3600e3, 6);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
console.log(`Wrote ${lines.length} lines to ${path.relative(process.cwd(), OUT)}${FIXED_SPANS ? ' (with span snapshots)' : ''}`);
