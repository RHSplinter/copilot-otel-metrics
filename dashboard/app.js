/* Dashboard controller: loads JSONL (server, file picker or drag & drop), runs the shared parser and renders all sections. */
(function () {
  'use strict';

  const { hbar, countBars, donut, columns, lines, table, statList, fmt, esc } = window.Charts;
  const $ = id => document.getElementById(id);

  const state = { records: [], parsed: null, sourceLabel: '', fromServer: false };

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  async function loadFromServer() {
    try {
      const [meta, data] = await Promise.all([fetch('/api/source'), fetch('/api/data')]);
      if (!meta.ok || !data.ok) throw new Error('No server data');
      const info = await meta.json();
      state.fromServer = true;
      ingest(await data.text(), `${info.name} · ${fmtBytes(info.size)} · modified ${new Date(info.modified).toLocaleString()}`);
    } catch (_) {
      showEmpty();
    }
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => ingest(String(reader.result), `${file.name} · ${fmtBytes(file.size)} (local file)`);
    reader.readAsText(file);
  }

  function ingest(text, label) {
    state.parsed = window.CopilotOtel.parseJsonl(text);
    state.records = state.parsed.records;
    state.sourceLabel = label;
    populateSessions();
    render();
  }

  function fmtBytes(n) {
    if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n > 1e3) return (n / 1e3).toFixed(1) + ' KB';
    return n + ' B';
  }

  function showEmpty() {
    $('empty').hidden = false;
    $('content').hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const dateTime = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const pct = v => (v === undefined ? '–' : (v * 100).toFixed(1) + '%');
  const secs = v => (v === undefined ? '–' : v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s');
  const ms = v => (v === undefined ? '–' : v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms');

  function populateSessions() {
    const sel = $('sessionFilter');
    const current = sel.value;
    const sessions = window.CopilotOtel.listSessions(state.records);
    sel.innerHTML = '<option value="">All sessions (' + sessions.length + ')</option>' + sessions.map(s => {
      const tip = [s.id, s.serviceName && s.serviceName + (s.serviceVersion ? ' ' + s.serviceVersion : ''), s.repos.length > 1 ? 'Repos: ' + s.repos.join(', ') : ''].filter(Boolean).join('\n');
      return `<option value="${esc(s.id)}" title="${esc(tip)}">${esc(s.label)}${s.first ? ' · ' + esc(dateTime(s.first)) : ''}</option>`;
    }).join('');
    if (sessions.some(s => s.id === current)) sel.value = current;
  }

  function render() {
    const a = window.CopilotOtel.analyze(state.records, { sessionId: $('sessionFilter').value || undefined });
    a.summary.lines = state.parsed.lines;
    a.summary.parseErrors = state.parsed.errors.length;
    window.__analysis = a; // handy for debugging in devtools

    $('empty').hidden = true;
    $('content').hidden = false;
    const s = a.summary;
    $('source').textContent = state.sourceLabel + (s.timeRange ? ` · ${dateTime(s.timeRange.start)} → ${dateTime(s.timeRange.end)}` : '');

    renderNotices(a);
    renderKpis(a);
    renderTimeline(a);
    renderLlm(a);
    renderTools(a);
    renderAgent(a);
    renderEdits(a);
    renderInventory(a);
    renderExplorer();
  }

  function renderNotices(a) {
    const s = a.summary;
    const notes = [];
    if (s.lostSpans && !s.spans) {
      notes.push(`<div class="notice"><b>${fmt(s.lostSpans)} span records are empty <code>{}</code>.</b> The Copilot Chat file exporter cannot serialize SDK spans (circular reference — <a href="https://github.com/microsoft/vscode/issues/319993" target="_blank" rel="noopener">microsoft/vscode#319993</a>), so per-span trace trees, durations and captured content are unavailable. This dashboard uses log events and metrics instead. Enable <code>github.copilot.chat.otel.dbSpanExporter.enabled</code> or an OTLP exporter for full traces.</div>`);
    }
    if (s.parseErrors) notes.push(`<div class="notice">${s.parseErrors} line(s) could not be parsed as JSON.</div>`);
    if (s.unknown) notes.push(`<div class="notice info">${s.unknown} record(s) have an unrecognized shape; see the record explorer.</div>`);
    if (!s.contentCaptured) notes.push('<div class="notice info">Prompt/response content is not present (<code>captureContent</code> off or lost with spans). Only metadata is shown.</div>');
    $('notices').innerHTML = notes.join('');
  }

  function kpi(label, value, sub) {
    return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
  }

  function renderKpis(a) {
    const s = a.summary;
    const editsAcc = a.edits.bySource.reduce((t, x) => t + x.accepted, 0);
    const editsRej = a.edits.bySource.reduce((t, x) => t + x.rejected, 0);
    $('kpis').innerHTML = [
      kpi('Chat sessions', fmt(s.chatSessions), `${s.sessions} VS Code window(s)`),
      kpi('Agent invocations', fmt(a.agent.invocations), a.agent.avgTurnsPerInvocation ? `${a.agent.avgTurnsPerInvocation.toFixed(1)} turns avg` : ''),
      kpi('LLM calls', fmt(s.llmCalls), `${Object.keys(a.llm.byModel).length} model(s)`),
      kpi('Input tokens', fmt(s.inputTokens), s.llmCalls ? `${fmt(s.inputTokens / s.llmCalls, 0)} per call` : ''),
      kpi('Output tokens', fmt(s.outputTokens), s.llmCalls ? `${fmt(s.outputTokens / s.llmCalls, 0)} per call` : ''),
      kpi('Tool calls', fmt(s.toolCalls), s.toolCalls ? `${pct((s.toolCalls - s.toolFailures) / s.toolCalls)} success` : ''),
      kpi('Lines added / removed', `+${fmt(s.linesAdded)} / −${fmt(s.linesRemoved)}`, 'accepted agent edits'),
      kpi('Edit acceptance', editsAcc + editsRej ? pct(editsAcc / (editsAcc + editsRej)) : '–', `${fmt(editsAcc)} accepted · ${fmt(editsRej)} rejected`),
    ].join('');
  }

  function renderTimeline(a) {
    const bucketMs = a.timeline.bucketMs;
    const label = bucketMs >= 86400e3 ? `${bucketMs / 86400e3} day` : bucketMs >= 3600e3 ? `${bucketMs / 3600e3} hour` : `${bucketMs / 60e3} min`;
    $('bucketLabel').textContent = bucketMs ? `per ${label}` : '';
    columns($('timeline'), a.timeline.buckets, [
      { key: 'llmCalls', label: 'LLM calls', color: 'var(--c1)' },
      { key: 'toolCalls', label: 'Tool calls', color: 'var(--c2)' },
    ], {
      line: { key: 'inputTokens', label: 'Input tokens (right axis)', color: 'var(--c5)' },
      formatX: t => dateTime(t),
      formatTick: t => (bucketMs >= 86400e3 ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : dateTime(t)),
      empty: 'No timestamped events',
    });
  }

  function renderLlm(a) {
    $('llmSource').textContent = 'from ' + a.sources.llm;
    const models = a.llm.byModel;
    hbar($('tokensByModel'), models.map(m => ({ label: m.model, values: [m.inputTokens, m.outputTokens], text: `${fmt(m.inputTokens)} / ${fmt(m.outputTokens)}` })),
      [{ label: 'Input tokens', color: 'var(--c1)' }, { label: 'Output tokens', color: 'var(--c3)' }]);
    donut($('callsByModel'), models.map(m => ({ label: m.model, value: m.calls })));
    countBars($('finishReasons'), a.llm.finishReasons, { color: 'var(--c3)', empty: 'No finish reasons recorded' });
    countBars($('errors'), a.errors, { color: 'var(--c6)', empty: 'No errors 🎉' });
    table($('latency'), [
      { key: 'model', label: 'Model' },
      { key: 'calls', label: 'Calls', num: true },
      { key: 'avgDurationS', label: 'Avg duration', num: true, render: r => secs(r.avgDurationS) },
      { key: 'maxDurationS', label: 'Max', num: true, render: r => secs(r.maxDurationS) },
      { key: 'avgTtftS', label: 'Avg time to first token', num: true, render: r => secs(r.avgTtftS) },
    ], a.llm.latency, { empty: 'No latency metrics (gen_ai.client.operation.duration)' });
  }

  function renderTools(a) {
    $('toolSource').textContent = 'from ' + a.sources.tools;
    const list = a.tools.list;
    hbar($('toolCalls'), list.map(t => ({ label: t.name, values: [t.calls - t.failures, t.failures] })),
      [{ label: 'Succeeded', color: 'var(--c3)' }, { label: 'Failed', color: 'var(--c6)' }], { empty: 'No tool calls' });
    table($('toolTable'), [
      { key: 'name', label: 'Tool', render: r => `<code>${esc(r.name)}</code>` },
      { key: 'calls', label: 'Calls', num: true },
      { key: 'successRate', label: 'Success', num: true, render: r => `<span class="${r.successRate < 0.9 ? 'pill-bad' : 'pill-ok'}">${pct(r.successRate)}</span>` },
      { key: 'avgMs', label: 'Avg', num: true, render: r => ms(r.avgMs) },
      { key: 'maxMs', label: 'Max', num: true, render: r => ms(r.maxMs) },
      { key: 'totalMs', label: 'Total time', num: true, render: r => ms(r.totalMs) },
    ], list, { empty: 'No tool calls' });
  }

  function renderAgent(a) {
    const g = a.agent;
    statList($('agentStats'), [
      ['Invocations', fmt(g.invocations)],
      ['Avg duration', secs(g.avgInvocationS)],
      ['Longest', secs(g.maxInvocationS)],
      ['Avg LLM turns / invocation', g.avgTurnsPerInvocation === undefined ? '–' : g.avgTurnsPerInvocation.toFixed(2)],
      ['Agent turns (events)', fmt(g.turnEvents)],
      ['Avg input tokens / turn', fmt(g.avgInputTokensPerTurn, 0)],
      ['Avg output tokens / turn', fmt(g.avgOutputTokensPerTurn, 0)],
      ...Object.entries(g.byAgent).map(([k, v]) => [`Invocations · ${k}`, fmt(v)]),
    ]);
    const perTurn = Object.entries(g.toolCallsPerTurn).sort((x, y) => Number(x[0]) - Number(y[0])).map(([k, v]) => ({ label: `${k} tool call${k === '1' ? '' : 's'}`, values: [v] }));
    hbar($('toolsPerTurn'), perTurn, [{ label: 'turns', color: 'var(--c2)' }], { empty: 'No copilot_chat.agent.turn events' });
    donut($('chatSessions'), Object.entries(a.chatSessions.byModel).map(([label, value]) => ({ label, value })), { empty: 'No copilot_chat.session.start events' });
  }

  function renderEdits(a) {
    const e = a.edits;
    hbar($('editsByLanguage'), e.byLanguage.map(l => ({ label: l.language, values: [l.added, l.removed], text: `+${fmt(l.added)} / −${fmt(l.removed)}` })),
      [{ label: 'Lines added', color: 'var(--c3)' }, { label: 'Lines removed', color: 'var(--c6)' }], { empty: 'No copilot_chat.lines_of_code.count metric' });

    const rows = e.bySource.map(s => ({ label: s.source, values: [s.accepted, s.rejected], text: `${pct(s.accepted / ((s.accepted + s.rejected) || 1))} accepted` }));
    const extra = [];
    if (Object.keys(e.inline).length) extra.push(['Inline chat (events)', `${fmt(e.inline.accepted || 0)} accepted · ${fmt(e.inline.rejected || 0)} rejected`]);
    if (Object.keys(e.feedback).length) extra.push(['File-level agent edits (events)', `${fmt(e.feedback.accepted || 0)} accepted · ${fmt(e.feedback.rejected || 0)} rejected`]);
    if (Object.keys(e.hunks).length) extra.push(['Hunks (events)', `${fmt(e.hunks.accepted || 0)} accepted · ${fmt(e.hunks.rejected || 0)} rejected`]);
    const el = $('editOutcomes');
    el.innerHTML = '<div id="editOutcomeBars"></div><div id="editOutcomeStats" style="margin-top:14px"></div>';
    hbar($('editOutcomeBars'), rows, [{ label: 'Accepted', color: 'var(--c3)' }, { label: 'Rejected', color: 'var(--c6)' }], { empty: 'No copilot_chat.edit.acceptance.count metric' });
    if (extra.length) statList($('editOutcomeStats'), extra);

    const label = d => (d >= 60000 ? d / 60000 + ' min' : d / 1000 + ' s');
    lines($('survival'), e.survival.map(s => ({ label: label(s.delayMs), values: [s.avgFourGram, s.avgNoRevert] })),
      [{ label: '4-gram survival', color: 'var(--c1)' }, { label: 'No-revert survival', color: 'var(--c3)' }],
      { percent: true, min: Math.min(0.5, ...e.survival.map(s => Math.min(s.avgFourGram, s.avgNoRevert))), max: 1, empty: 'No copilot_chat.edit.survival events' });

    const fb = Object.entries(e.userFeedback).map(([label, value]) => ({ label: label === 'positive' ? '👍 positive' : label === 'negative' ? '👎 negative' : label, value, color: label === 'positive' ? 'var(--c3)' : label === 'negative' ? 'var(--c6)' : undefined }));
    const actionColors = ['var(--c1)', 'var(--c2)', 'var(--c4)', 'var(--c5)', 'var(--c7)', 'var(--c8)'];
    const ua = Object.entries(e.userActions).map(([label, value], i) => ({ label: `action: ${label}`, value, color: actionColors[i % actionColors.length] }));
    donut($('feedback'), fb.concat(ua), { empty: 'No feedback or user actions recorded' });
  }

  function attrChips(attrs) {
    return '<div class="attrs">' + attrs.map(x => `<span class="attr" title="${esc(x.type + ' · e.g. ' + x.samples.join(' | '))}">${esc(x.key)}</span>`).join('') + '</div>';
  }

  function renderInventory(a) {
    const s = a.summary;
    donut($('recordTypes'), [
      { label: 'Log records (events)', value: s.logs, color: 'var(--c1)' },
      { label: 'Metric export batches', value: s.metricExports, color: 'var(--c2)' },
      { label: 'Spans', value: s.spans, color: 'var(--c3)' },
      { label: 'Empty {} (lost spans)', value: s.lostSpans, color: 'var(--c5)' },
      { label: 'Unrecognized', value: s.unknown, color: 'var(--c6)' },
    ], { center: fmt(s.lines) + ' lines' });
    table($('resourceAttrs'), [
      { key: 'key', label: 'Resource attribute', render: r => `<code>${esc(r.key)}</code>` },
      { key: 'values', label: 'Values', render: r => r.values.map(v => `<code>${esc(v)}</code>`).join('<br>') },
    ], Object.entries(a.resourceAttributes).map(([key, values]) => ({ key, values })));
    table($('eventCatalog'), [
      { key: 'name', label: 'Event name', render: r => `<code>${esc(r.name)}</code>` },
      { key: 'count', label: 'Count', num: true },
      { key: 'attributes', label: 'Attributes (hover for samples)', render: r => attrChips(r.attributes.filter(x => x.key !== 'event.name')) },
    ], a.catalogs.events, { empty: 'No log records' });
    table($('metricCatalog'), [
      { key: 'name', label: 'Metric', render: r => `<code>${esc(r.name)}</code>${r.description ? `<div class="muted">${esc(r.description)}</div>` : ''}` },
      { key: 'type', label: 'Type' },
      { key: 'unit', label: 'Unit', render: r => `<code>${esc(r.unit)}</code>` },
      { key: 'series', label: 'Series', num: true },
      { key: 'total', label: 'Total (latest cumulative)', num: true, render: r => (r.total && typeof r.total === 'object' ? `n=${fmt(r.total.count)} · sum=${fmt(r.total.sum)}${r.total.count ? ` · avg=${fmt(r.total.sum / r.total.count)}` : ''}` : fmt(r.total)) },
      { key: 'attributes', label: 'Attributes', render: r => attrChips(r.attributes) },
    ], a.catalogs.metrics, { empty: 'No metrics' });
    table($('spanCatalog'), [
      { key: 'name', label: 'Span (operation)', render: r => `<code>${esc(r.name)}</code>` },
      { key: 'count', label: 'Count', num: true },
      { key: 'avgMs', label: 'Avg duration', num: true, render: r => ms(r.avgMs) },
      { key: 'attributes', label: 'Attributes', render: r => attrChips(r.attributes) },
    ], a.catalogs.spans, { empty: s.lostSpans ? `No usable spans — ${s.lostSpans} span records were written as {}` : 'No spans' });
    table($('sessions'), [
      { key: 'id', label: 'session.id', render: r => `<code>${esc(r.id)}</code>` },
      { key: 'serviceVersion', label: 'Copilot Chat version' },
      { key: 'first', label: 'First record', render: r => (r.first ? esc(dateTime(r.first)) : '–') },
      { key: 'last', label: 'Last record', render: r => (r.last ? esc(dateTime(r.last)) : '–') },
      { key: 'records', label: 'Records', num: true },
    ], a.sessions);
  }

  function renderExplorer() {
    const kind = $('kindFilter').value;
    const q = $('textFilter').value.trim().toLowerCase();
    const sessionId = $('sessionFilter').value;
    const matches = [];
    for (const r of state.records) {
      if (kind && r.kind !== kind) continue;
      if (sessionId && r.resource && (r.resource['session.id'] || '(no session.id)') !== sessionId) continue;
      if (q && !JSON.stringify(r).toLowerCase().includes(q)) continue;
      matches.push(r);
      if (matches.length >= 200) break;
    }
    $('explorerCount').textContent = matches.length >= 200 ? 'showing first 200 matches' : `${matches.length} match(es)`;
    $('explorer').innerHTML = matches.map(r => {
      const t = r.time || r.end || r.start;
      const name = r.kind === 'lostSpan' ? '{}' : r.name || '';
      return `<details class="rec"><summary><span class="k">${esc(r.kind)}</span><span class="t">${t ? esc(new Date(t).toISOString().replace('T', ' ').slice(0, 19)) : 'line ' + r.line}</span><span>${esc(name)}</span></summary><pre>${esc(JSON.stringify(r, null, 2))}</pre></details>`;
    }).join('') || window.Charts.none('No matching records');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  $('sessionFilter').addEventListener('change', render);
  $('kindFilter').addEventListener('change', renderExplorer);
  let debounce;
  $('textFilter').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(renderExplorer, 200); });
  $('fileInput').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  $('reload').addEventListener('click', () => (state.fromServer ? loadFromServer() : $('fileInput').click()));
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  if (location.protocol.startsWith('http')) loadFromServer(); else showEmpty();
})();
