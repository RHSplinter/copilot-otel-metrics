/* Dashboard controller: loads JSONL (server, file picker or drag & drop), runs the shared parser and renders all sections. */
(function () {
  'use strict';

  const { hbar, countBars, donut, columns, lines, table, statList, fmt, esc } = window.Charts;
  const $ = id => document.getElementById(id);

  const state = { records: [], parsed: null, sourceLabel: '', fromServer: false, fileHandle: null, loadId: 0, knownNames: [], sessionInfo: {}, sessions: [] };

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  // Shows the loading indicator; returns a token so a slower, superseded load cannot overwrite a newer one.
  function startLoading(name, detail) {
    const id = ++state.loadId;
    $('loadError').hidden = true;
    $('empty').hidden = true;
    $('loadingTitle').textContent = name ? `Loading ${name}…` : 'Loading data…';
    $('loadingDetail').textContent = detail || '';
    $('loading').hidden = false;
    $('source').textContent = name ? `Loading ${name}…` : 'Loading…';
    $('reload').disabled = true;
    return id;
  }

  function stopLoading(id) {
    if (id !== state.loadId) return false;
    $('loading').hidden = true;
    $('reload').disabled = false;
    return true;
  }

  // Lets the browser paint the indicator before the synchronous parse of a large file.
  const nextPaint = () => new Promise(resolve => setTimeout(resolve, 0));

  async function loadFromServer() {
    let id = startLoading();
    try {
      const meta = await fetch('/api/source', { cache: 'no-store' });
      if (!meta.ok) throw new Error(await meta.text());
      const info = await meta.json();
      if (id !== state.loadId) return;
      id = startLoading(info.name || info.path, `${info.path} · ${fmtBytes(info.size)}`);
      const data = await fetch('/api/data', { cache: 'no-store' });
      if (!data.ok) throw new Error(await data.text());
      const text = await data.text();
      state.knownNames = await fetchKnownNames();
      state.sessionInfo = await fetchSessionInfo();
      await nextPaint();
      if (id !== state.loadId) return;
      state.fromServer = true;
      state.fileHandle = null;
      ingest(text, `${info.path} · ${fmtBytes(info.size)} · modified ${new Date(info.modified).toLocaleString()}`);
      stopLoading(id);
    } catch (error) {
      if (stopLoading(id)) showLoadError(error);
    }
  }

  // MCP server names from local configs (server mode only) to resolve hashed names; optional.
  async function fetchKnownNames() {
    try {
      const res = await fetch('/api/names', { cache: 'no-store' });
      return res.ok ? (await res.json()).mcpServers || [] : [];
    } catch (_) {
      return [];
    }
  }

  // Copilot CLI session titles/repos from the local session store (server mode only); optional.
  async function fetchSessionInfo() {
    try {
      const res = await fetch('/api/sessions', { cache: 'no-store' });
      return res.ok ? (await res.json()).sessions || {} : {};
    } catch (_) {
      return {};
    }
  }

  async function loadFile(file, handle = null) {
    const id = startLoading(file.name, `${fmtBytes(file.size)} (local file)`);
    try {
      const text = await file.text();
      await nextPaint();
      if (id !== state.loadId) return;
      state.fromServer = false;
      state.fileHandle = handle;
      ingest(text, `${file.name} · ${fmtBytes(file.size)} (local file)`);
      stopLoading(id);
    } catch (error) {
      if (stopLoading(id)) showLoadError(error);
    }
  }

  async function openFile() {
    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false });
      await loadFile(await handle.getFile(), handle);
    } catch (error) {
      if (error.name !== 'AbortError') showLoadError(error);
    }
  }

  async function reload() {
    if (state.fromServer) return loadFromServer();
    if (state.fileHandle) {
      try {
        await loadFile(await state.fileHandle.getFile(), state.fileHandle);
      } catch (error) {
        showLoadError(error);
      }
    } else if (!state.parsed && location.protocol.startsWith('http')) {
      return loadFromServer();
    } else {
      $('loadError').textContent = 'This browser requires you to select the loaded file again to read its current contents.';
      $('loadError').hidden = false;
      $('fileInput').click();
    }
  }

  function showLoadError(error) {
    if (state.parsed) $('source').textContent = state.sourceLabel;
    else { showEmpty(); $('source').textContent = 'No data loaded'; }
    $('loadError').textContent = `Unable to load data: ${error.message}`;
    $('loadError').hidden = false;
  }

  function ingest(text, label) {
    $('loadError').hidden = true;
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
    $('loading').hidden = true;
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
    const sessions = window.CopilotOtel.listSessions(state.records, { sessionInfo: state.sessionInfo });
    state.sessions = sessions;
    sel.innerHTML = '<option value="">All sessions (' + sessions.length + ')</option>' + sessions.map(s => {
      const where = s.repo && s.label !== s.repo ? s.repo + (s.branch ? ' @ ' + s.branch : '') : '';
      const tip = [s.label.length > 80 ? s.label : '', s.id, where, s.serviceName && s.serviceName + (s.serviceVersion ? ' ' + s.serviceVersion : ''), s.repos.length > 1 ? 'Repos: ' + s.repos.join(', ') : ''].filter(Boolean).join('\n');
      const tags = s.tags.map(tag => `[${tag}] `).join('');
      const label = s.label.length > 80 ? s.label.slice(0, 79) + '…' : s.label;
      return `<option value="${esc(s.id)}" title="${esc(tip)}">${esc(tags)}${esc(label)}${s.first ? ' · ' + esc(dateTime(s.first)) : ''}</option>`;
    }).join('');
    if (sessions.some(s => s.id === current)) sel.value = current;
    renderSessionTags();
  }

  function renderSessionTags() {
    const s = (state.sessions || []).find(x => x.id === $('sessionFilter').value);
    $('sessionTags').innerHTML = s ? s.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('') : '';
  }

  function render() {
    const a = window.CopilotOtel.analyze(state.records, { sessionId: $('sessionFilter').value || undefined, knownNames: state.knownNames });
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
    renderCapabilities(a);
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
      kpi('Chat sessions', fmt(s.chatSessions), `${s.sessions} window/CLI session(s)`),
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
    hbar($('tokensByModel'), models.map(m => ({
      label: m.model,
      values: [m.inputTokens, m.outputTokens],
      text: `<span class="sub-val">${esc(fmt(m.inputTokens))} in</span><span class="sub-val">${esc(fmt(m.outputTokens))} out${m.inputTokens ? ` · ${esc(pct(m.outputTokens / m.inputTokens))}` : ''}</span>`,
    })), [{ label: 'Input tokens', color: 'var(--c1)' }, { label: 'Output tokens', color: 'var(--c3)' }], { independent: true });
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

  const FULL_SPANS_HINT = 'only in full-span exports (Copilot CLI / VS Code agent host)';
  const badge = (text, cls) => ` <span class="tag ${cls || ''}">${esc(text)}</span>`;

  function renderCapabilities(a) {
    const c = a.capabilities;
    $('capContext').textContent = c.contextConversations ? `${fmt(c.contextConversations)} conversation(s) with a capability snapshot` : '';

    table($('capAgents'), [
      { key: 'name', label: 'Agent', render: r => esc(r.name) + (r.subagent ? badge('subagent') : '') + (r.custom ? badge('custom', 'custom') : '') },
      { key: 'count', label: 'Invocations', num: true },
      { key: 'avgMs', label: 'Avg duration', num: true, render: r => ms(r.avgMs) },
      { key: 'turns', label: 'Turns', num: true, render: r => fmt(r.turns || undefined) },
      { key: 'inputTokens', label: 'Tokens in / out', num: true, render: r => `${esc(fmt(r.inputTokens))} / ${esc(fmt(r.outputTokens))}` },
      { key: 'cost', label: 'Cost', num: true, render: r => fmt(r.cost || undefined) },
      { key: 'failures', label: 'Failed', num: true },
    ], c.agents, { empty: `No invoke_agent spans (${FULL_SPANS_HINT})` });
    countBars($('llmByAgent'), c.llmCallsByAgent, { color: 'var(--c4)', label: 'LLM calls', empty: 'No chat spans with gen_ai.agent.name' });

    const used = c.skills.filter(s => s.count);
    const unused = c.skills.filter(s => !s.count);
    table($('capSkills'), [
      { key: 'name', label: 'Skill', render: r => `<code>${esc(r.name)}</code>` },
      { key: 'count', label: 'Invocations', num: true },
      { key: 'avgMs', label: 'Avg', num: true, render: r => ms(r.avgMs) },
      { key: 'failures', label: 'Failed', num: true },
      { key: 'availableIn', label: 'Loaded in', num: true, render: r => (r.availableIn ? `${fmt(r.availableIn)} conv.` : '–') },
    ], used, { empty: c.skills.length ? 'No skill invocations' : `No skill data (${FULL_SPANS_HINT})` });
    $('capSkillsUnused').innerHTML = unused.length
      ? `<div class="muted sub-head">Loaded but never invoked (${unused.length})</div><div class="attrs">${unused.map(s => `<span class="attr" title="${esc(`loaded in ${s.availableIn} conversation(s)`)}">${esc(s.name)}</span>`).join('')}</div>`
      : '';

    const serverName = s => (s.resolved ? esc(s.name) : `<code title="${esc('sha256 ' + s.id + ' — add the server to a local MCP config to resolve it')}">${esc(s.name)}</code>`);
    table($('capMcp'), [
      { key: 'name', label: 'MCP server', render: serverName },
      { key: 'calls', label: 'Tool calls', num: true },
      { key: 'failures', label: 'Failed', num: true },
      { key: 'avgMs', label: 'Avg', num: true, render: r => ms(r.avgMs) },
      { key: 'tools', label: 'Tools used', num: true, render: r => fmt(r.tools.length) },
      { key: 'availableIn', label: 'Loaded in', num: true, render: r => (r.availableIn ? `${fmt(r.availableIn)} conv.` : '–') },
    ], c.mcp.servers, { empty: `No MCP servers or MCP tool calls (${FULL_SPANS_HINT})` });
    const conn = c.mcp.connections;
    const connTotal = Object.values(conn).reduce((s, v) => s + v, 0);
    $('mcpConnections').innerHTML = connTotal
      ? `<div class="muted sub-head">Server connections: ${Object.entries(conn).map(([k, v]) => `${esc(k)} ${esc(fmt(v))}`).join(' · ')}${conn.failure ? ` <span class="pill-bad">${esc(pct(conn.failure / connTotal))} failed</span>` : ''}</div>`
      : '';
    const mcpTools = c.mcp.servers.flatMap(s => s.tools.map(t => ({ label: `${s.name}/${t.name}`, values: [t.calls - t.failures, t.failures] })))
      .sort((x, y) => (y.values[0] + y.values[1]) - (x.values[0] + x.values[1])).slice(0, 15);
    hbar($('mcpTools'), mcpTools, [{ label: 'Succeeded', color: 'var(--c3)' }, { label: 'Failed', color: 'var(--c6)' }], { empty: 'No MCP tool calls' });

    table($('capCustomAgents'), [
      { key: 'name', label: 'Custom agent' },
      { key: 'invocations', label: 'Invocations', num: true },
      { key: 'availableIn', label: 'Loaded in', num: true, render: r => `${fmt(r.availableIn)} conv.` },
    ], c.customAgents, { empty: `No custom agents (${FULL_SPANS_HINT})` });

    hbar($('permissions'), c.permissions.map(p => ({ label: p.kind, values: [p.approved, p.denied, p.other] })),
      [{ label: 'Approved', color: 'var(--c3)' }, { label: 'Denied', color: 'var(--c6)' }, { label: 'Other', color: 'var(--c5)' }],
      { empty: `No permission requests (${FULL_SPANS_HINT})` });

    table($('capTimings'), [
      { key: 'name', label: 'Phase', render: r => `<code>${esc(r.name)}</code>` },
      { key: 'count', label: 'Sessions', num: true },
      { key: 'avgMs', label: 'Avg', num: true, render: r => ms(r.avgMs) },
      { key: 'maxMs', label: 'Max', num: true, render: r => ms(r.maxMs) },
    ], c.startupTimings, { empty: `No session.timing.* spans (${FULL_SPANS_HINT})` });
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
    const sessionOf = sessionId && window.CopilotOtel.sessionResolver(state.records);
    const matches = [];
    for (const r of state.records) {
      if (kind && r.kind !== kind) continue;
      if (sessionId && r.resource && sessionOf(r) !== sessionId) continue;
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

  $('sessionFilter').addEventListener('change', () => { renderSessionTags(); render(); });
  $('kindFilter').addEventListener('change', renderExplorer);
  let debounce;
  $('textFilter').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(renderExplorer, 200); });
  $('openFile').addEventListener('click', e => {
    if (window.showOpenFilePicker) { e.preventDefault(); openFile(); }
  });
  $('fileInput').addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });
  $('reload').addEventListener('click', reload);
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', async e => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    if (file) {
      try {
        const handle = item && item.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
        await loadFile(handle ? await handle.getFile() : file, handle);
      } catch (error) {
        showLoadError(error);
      }
    }
  });

  if (location.protocol.startsWith('http')) loadFromServer(); else showEmpty();
})();
