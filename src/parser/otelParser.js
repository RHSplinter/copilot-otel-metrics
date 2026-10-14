/*
 * Parser + analyzer for GitHub Copilot Chat OpenTelemetry JSONL output.
 *
 * Supports:
 *  - Copilot Chat `file` exporter output (github.copilot.chat.otel.exporterType = "file"):
 *      * serialized SDK LogRecords (events, `attributes["event.name"]`)
 *      * serialized SDK ResourceMetrics (cumulative metric snapshots)
 *      * serialized spans (plain snapshots) and `{}` lines (spans lost to
 *        https://github.com/microsoft/vscode/issues/319993)
 *  - OTLP/JSON lines (resourceSpans / resourceLogs / resourceMetrics), e.g. from an
 *    OpenTelemetry Collector file exporter.
 *
 * Zero dependencies; works in Node (require) and browsers / VS Code webviews (window.CopilotOtel).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CopilotOtel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /** Converts HrTime ([s, ns]), epoch s/ms/µs/ns numbers, numeric strings or ISO strings to epoch ms. */
  function toMs(t) {
    if (t === undefined || t === null) return undefined;
    if (Array.isArray(t) && t.length === 2) return t[0] * 1000 + t[1] / 1e6;
    if (typeof t === 'number') {
      if (t > 1e17) return t / 1e6; // ns
      if (t > 1e14) return t / 1e3; // µs
      if (t > 1e11) return t; // ms
      return t * 1000; // s
    }
    if (typeof t === 'string') {
      // Nanosecond strings exceed double precision; split into seconds + fraction first.
      if (/^\d{18,}$/.test(t)) return toMs([Number(t.slice(0, -9)), Number(t.slice(-9))]);
      if (/^\d+$/.test(t)) return toMs(Number(t));
      const d = Date.parse(t);
      return isNaN(d) ? undefined : d;
    }
    return undefined;
  }

  /** Converts a relative duration (HrTime [s, ns] or ms number) to ms. */
  function durationToMs(d) {
    if (Array.isArray(d) && d.length === 2) return d[0] * 1000 + d[1] / 1e6;
    if (typeof d === 'number') return d;
    return undefined;
  }

  /** Stable JSON stringify (sorted keys) used for series keys. */
  function stableKey(obj) {
    if (!isObject(obj)) return JSON.stringify(obj);
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stableKey(obj[k])).join(',') + '}';
  }

  /** Resolves resource attributes from SDK ResourceImpl JSON, plain resources or OTLP resources. */
  function resourceAttributes(res) {
    if (!isObject(res)) return {};
    if (Array.isArray(res.attributes)) return otlpAttributes(res.attributes);
    if (isObject(res.attributes)) return Object.assign({}, res.attributes);
    if (isObject(res._memoizedAttributes)) return Object.assign({}, res._memoizedAttributes);
    if (Array.isArray(res._rawAttributes)) {
      const out = {};
      for (const entry of res._rawAttributes) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [k, v] = entry;
        if (k && !(k in out) && v !== null && typeof v !== 'object') out[k] = v; // first wins, skip pending promises
      }
      return out;
    }
    return {};
  }

  function otlpValue(v) {
    if (!isObject(v)) return v;
    if ('stringValue' in v) return v.stringValue;
    if ('boolValue' in v) return v.boolValue;
    if ('intValue' in v) return Number(v.intValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(otlpValue);
    if ('kvlistValue' in v) return otlpAttributes((v.kvlistValue && v.kvlistValue.values) || []);
    if ('bytesValue' in v) return v.bytesValue;
    return undefined;
  }

  function otlpAttributes(list) {
    const out = {};
    if (!Array.isArray(list)) return isObject(list) ? list : out;
    for (const kv of list) if (kv && kv.key !== undefined) out[kv.key] = otlpValue(kv.value);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Normalization: raw JSON object -> normalized records
  // ---------------------------------------------------------------------------
  //
  // Normalized record shapes:
  //  { kind: 'lostSpan', line }
  //  { kind: 'log', line, time, name, body, attributes, resource, traceId, spanId, severity }
  //  { kind: 'span', line, name, spanKind, start, end, durationMs, attributes, resource, traceId,
  //    spanId, parentSpanId, status, events }
  //  { kind: 'metric', line, name, unit, description, type, temporality, isMonotonic,
  //    attributes, resource, start, end, value }
  //  { kind: 'unknown', line, raw }

  // @opentelemetry/sdk-metrics DataPointType enum
  const SDK_DATA_POINT_TYPE = { 0: 'histogram', 1: 'exponentialHistogram', 2: 'gauge', 3: 'sum' };

  function logName(attributes, body, eventName) {
    if (eventName) return eventName;
    if (attributes && typeof attributes['event.name'] === 'string') return attributes['event.name'];
    if (typeof body === 'string') return body.split(':')[0].trim() || body;
    return '(unnamed log)';
  }

  function normalizeSdkLog(o, line) {
    const attributes = isObject(o.attributes) ? o.attributes : {};
    const body = o._body !== undefined ? o._body : o.body;
    const ctx = o._spanContext || o.spanContext || {};
    return {
      kind: 'log',
      line,
      time: toMs(o._hrTime || o.hrTime || o._hrTimeObserved || o.hrTimeObserved || o.timestamp),
      name: logName(attributes, body, o._eventName || o.eventName),
      body,
      attributes,
      resource: resourceAttributes(o.resource),
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      severity: o._severityText || o.severityText || o._severityNumber || o.severityNumber,
    };
  }

  function normalizeSdkSpan(o, line) {
    const ctx = o._spanContext || o.spanContext || {};
    const parent = o.parentSpanContext || o._parentSpanContext || {};
    const start = toMs(o.startTime);
    let end = toMs(o.endTime);
    let durationMs = durationToMs(o.duration !== undefined ? o.duration : o._duration);
    if (durationMs === undefined && start !== undefined && end !== undefined) durationMs = end - start;
    if (end === undefined && start !== undefined && durationMs !== undefined) end = start + durationMs;
    return {
      kind: 'span',
      line,
      name: o.name,
      spanKind: o.kind,
      start,
      end,
      durationMs,
      attributes: isObject(o.attributes) ? o.attributes : {},
      resource: resourceAttributes(o.resource),
      traceId: o.traceId || ctx.traceId,
      spanId: o.spanId || ctx.spanId,
      parentSpanId: o.parentSpanId || parent.spanId,
      status: o.status,
      events: Array.isArray(o.events) ? o.events : [],
    };
  }

  function sdkMetricValue(dp, type) {
    const v = dp.value;
    if (typeof v === 'number') return v;
    if (isObject(v)) {
      return {
        count: Number(v.count) || 0,
        sum: v.sum !== undefined && v.sum !== null ? Number(v.sum) : undefined,
        min: typeof v.min === 'number' && isFinite(v.min) ? v.min : undefined,
        max: typeof v.max === 'number' && isFinite(v.max) ? v.max : undefined,
        buckets: v.buckets,
      };
    }
    return type === 'histogram' ? { count: 0 } : 0;
  }

  function normalizeSdkResourceMetrics(o, line) {
    const out = [];
    const resource = resourceAttributes(o.resource);
    for (const sm of o.scopeMetrics || []) {
      for (const m of sm.metrics || []) {
        const d = m.descriptor || {};
        let type = SDK_DATA_POINT_TYPE[m.dataPointType];
        if (!type && typeof d.type === 'string') {
          const dt = d.type.toLowerCase();
          type = dt.includes('histogram') ? 'histogram' : dt.includes('gauge') ? 'gauge' : 'sum';
        }
        // SDK AggregationTemporality enum: DELTA = 0, CUMULATIVE = 1 (Copilot uses CUMULATIVE)
        const temporality = m.aggregationTemporality === 0 ? 'delta' : 'cumulative';
        for (const dp of m.dataPoints || []) {
          const t = type || (isObject(dp.value) ? 'histogram' : 'sum');
          out.push({
            kind: 'metric',
            line,
            name: d.name || m.name,
            unit: d.unit || '',
            description: d.description || '',
            type: t,
            temporality,
            isMonotonic: m.isMonotonic,
            attributes: isObject(dp.attributes) ? dp.attributes : {},
            resource,
            start: toMs(dp.startTime),
            end: toMs(dp.endTime),
            value: sdkMetricValue(dp, t),
          });
        }
      }
    }
    return out;
  }

  // --- OTLP/JSON -------------------------------------------------------------

  function normalizeOtlp(o, line) {
    const out = [];
    for (const rs of o.resourceSpans || []) {
      const resource = resourceAttributes(rs.resource);
      for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
        for (const s of ss.spans || []) {
          const start = toMs(s.startTimeUnixNano);
          const end = toMs(s.endTimeUnixNano);
          out.push({
            kind: 'span', line, name: s.name, spanKind: s.kind, start, end,
            durationMs: start !== undefined && end !== undefined ? end - start : undefined,
            attributes: otlpAttributes(s.attributes), resource,
            traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || undefined,
            status: s.status,
            events: (s.events || []).map(e => ({ name: e.name, time: toMs(e.timeUnixNano), attributes: otlpAttributes(e.attributes) })),
          });
        }
      }
    }
    for (const rl of o.resourceLogs || []) {
      const resource = resourceAttributes(rl.resource);
      for (const sl of rl.scopeLogs || []) {
        for (const l of sl.logRecords || []) {
          const attributes = otlpAttributes(l.attributes);
          const body = otlpValue(l.body);
          out.push({
            kind: 'log', line, time: toMs(l.timeUnixNano || l.observedTimeUnixNano),
            name: logName(attributes, body, l.eventName), body, attributes, resource,
            traceId: l.traceId, spanId: l.spanId, severity: l.severityText || l.severityNumber,
          });
        }
      }
    }
    for (const rm of o.resourceMetrics || []) {
      const resource = resourceAttributes(rm.resource);
      for (const sm of rm.scopeMetrics || []) {
        for (const m of sm.metrics || []) {
          let type, data;
          if (m.histogram) { type = 'histogram'; data = m.histogram; }
          else if (m.exponentialHistogram) { type = 'exponentialHistogram'; data = m.exponentialHistogram; }
          else if (m.sum) { type = 'sum'; data = m.sum; }
          else if (m.gauge) { type = 'gauge'; data = m.gauge; }
          else continue;
          // OTLP enum: DELTA = 1, CUMULATIVE = 2
          const temporality = data.aggregationTemporality === 1 ? 'delta' : 'cumulative';
          for (const dp of data.dataPoints || []) {
            let value;
            if (type === 'histogram' || type === 'exponentialHistogram') {
              value = { count: Number(dp.count) || 0, sum: dp.sum !== undefined ? Number(dp.sum) : undefined, min: dp.min, max: dp.max };
            } else {
              value = dp.asDouble !== undefined ? Number(dp.asDouble) : Number(dp.asInt) || 0;
            }
            out.push({
              kind: 'metric', line, name: m.name, unit: m.unit || '', description: m.description || '',
              type, temporality, isMonotonic: data.isMonotonic, attributes: otlpAttributes(dp.attributes), resource,
              start: toMs(dp.startTimeUnixNano), end: toMs(dp.timeUnixNano), value,
            });
          }
        }
      }
    }
    return out;
  }

  /** Normalizes one parsed JSON object (one JSONL line) into zero or more records. */
  function normalizeObject(o, line) {
    if (!isObject(o)) return [{ kind: 'unknown', line, raw: o }];
    if (Object.keys(o).length === 0) return [{ kind: 'lostSpan', line }];
    if (o.resourceSpans || o.resourceLogs || o.resourceMetrics) return normalizeOtlp(o, line);
    if (Array.isArray(o.scopeMetrics)) return normalizeSdkResourceMetrics(o, line);
    const looksLikeSpan = typeof o.name === 'string' && o.startTime !== undefined &&
      (o.spanId || o._spanContext || o.spanContext || o.kind !== undefined);
    if (looksLikeSpan) return [normalizeSdkSpan(o, line)];
    if ('_hrTime' in o || 'hrTime' in o || '_body' in o || 'body' in o || (isObject(o.attributes) && 'event.name' in o.attributes)) {
      return [normalizeSdkLog(o, line)];
    }
    return [{ kind: 'unknown', line, raw: o }];
  }

  /**
   * Parses JSONL text into normalized records.
   * @returns {{ records: object[], lines: number, errors: {line:number, message:string}[] }}
   */
  function parseJsonl(text) {
    const records = [];
    const errors = [];
    let lines = 0;
    const rows = String(text).split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i].trim();
      if (!row) continue;
      lines++;
      let obj;
      try {
        obj = JSON.parse(row);
      } catch (e) {
        errors.push({ line: i + 1, message: e.message });
        continue;
      }
      for (const r of normalizeObject(obj, i + 1)) records.push(r);
    }
    return { records, lines, errors };
  }

  // ---------------------------------------------------------------------------
  // Metric aggregation
  // ---------------------------------------------------------------------------

  /**
   * Cumulative metrics are re-exported as running totals on every export interval, so we keep only the
   * latest point per series (resource + metric + attributes + startTime) and sum delta points. Series
   * that share metric name + attributes are then merged across resources (VS Code windows / restarts).
   * @returns {Map<string, {name, unit, description, type, attributes, value}>}
   */
  function aggregateMetrics(metricRecords) {
    const latest = new Map();
    const deltas = [];
    for (const m of metricRecords) {
      if (m.temporality === 'delta') { deltas.push(m); continue; }
      const key = m.name + '|' + stableKey(m.resource) + '|' + stableKey(m.attributes) + '|' + (m.start || 0);
      const prev = latest.get(key);
      if (!prev || (m.end || 0) >= (prev.end || 0)) latest.set(key, m);
    }
    const merged = new Map();
    for (const m of [...latest.values(), ...deltas]) {
      const key = m.name + '|' + stableKey(m.attributes);
      let agg = merged.get(key);
      if (!agg) {
        agg = { name: m.name, unit: m.unit, description: m.description, type: m.type, attributes: m.attributes, value: undefined };
        merged.set(key, agg);
      }
      agg.value = mergeValue(agg.value, m.value, m.type);
    }
    return merged;
  }

  function mergeValue(a, b, type) {
    if (a === undefined) return isObject(b) ? Object.assign({}, b) : b;
    if (type === 'gauge') return b;
    if (isObject(a) && isObject(b)) {
      return {
        count: (a.count || 0) + (b.count || 0),
        sum: (a.sum || 0) + (b.sum || 0),
        min: a.min === undefined ? b.min : b.min === undefined ? a.min : Math.min(a.min, b.min),
        max: a.max === undefined ? b.max : b.max === undefined ? a.max : Math.max(a.max, b.max),
      };
    }
    return (Number(a) || 0) + (Number(b) || 0);
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  const OP = 'gen_ai.operation.name';
  const MODEL_REQ = 'gen_ai.request.model';
  const MODEL_RES = 'gen_ai.response.model';
  const IN_TOK = 'gen_ai.usage.input_tokens';
  const OUT_TOK = 'gen_ai.usage.output_tokens';
  const TOOL = 'gen_ai.tool.name';

  function inc(map, key, by) {
    map[key] = (map[key] || 0) + (by === undefined ? 1 : by);
  }

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function truthy(v) {
    return v === true || v === 'true' || v === 1;
  }

  function sampleValue(v) {
    if (v === null || v === undefined) return String(v);
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  }

  function catalogAdd(catalog, name, attributes, extra) {
    let entry = catalog.get(name);
    if (!entry) {
      entry = Object.assign({ name, count: 0, attributes: new Map() }, extra || {});
      catalog.set(name, entry);
    }
    entry.count++;
    for (const [k, v] of Object.entries(attributes || {})) {
      let a = entry.attributes.get(k);
      if (!a) { a = { key: k, type: Array.isArray(v) ? 'array' : typeof v, samples: new Set() }; entry.attributes.set(k, a); }
      if (a.samples.size < 4) a.samples.add(sampleValue(v));
    }
    return entry;
  }

  function finalizeCatalog(catalog) {
    return [...catalog.values()]
      .map(e => Object.assign({}, e, {
        attributes: [...e.attributes.values()].map(a => ({ key: a.key, type: a.type, samples: [...a.samples] })),
      }))
      .sort((a, b) => b.count - a.count);
  }

  function pickBucketMs(minT, maxT) {
    const span = Math.max(1, maxT - minT);
    const options = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 6 * 3600e3, 86400e3, 7 * 86400e3];
    for (const o of options) if (span / o <= 60) return o;
    return options[options.length - 1];
  }

  const NO_SESSION_ID = '(no session.id)';

  function sessionIdOf(resource) {
    return (resource && resource['session.id']) || NO_SESSION_ID;
  }

  /** "https://github.com/owner/repo.git" / "git@host:owner/repo" -> "owner/repo". */
  function repoNameFromUrl(url) {
    if (typeof url !== 'string' || !url) return undefined;
    const m = url.replace(/\.git$/i, '').replace(/\/+$/, '').match(/([^/:]+)[/:]([^/:]+)$/);
    return m ? m[1] + '/' + m[2] : url;
  }

  function topKey(counts) {
    let best, n = -1;
    for (const k of Object.keys(counts)) if (counts[k] > n) { best = k; n = counts[k]; }
    return best;
  }

  /**
   * Lists distinct resource sessions (one per VS Code window / extension host process).
   * OTel has no session title; `label` is derived from the workspace repo/branch that Copilot attaches to
   * edit events (`copilot_chat.repo.remote_url`, `copilot_chat.repo.head_branch_name`), falling back to
   * the (shortened) session.id.
   */
  function listSessions(records) {
    const sessions = new Map();
    for (const r of records) {
      if (!r.resource) continue;
      const id = sessionIdOf(r.resource);
      let s = sessions.get(id);
      if (!s) {
        s = { id, serviceName: r.resource['service.name'], serviceVersion: r.resource['service.version'], first: undefined, last: undefined, records: 0, repos: {}, branches: {} };
        sessions.set(id, s);
      }
      s.records++;
      const t = r.time || r.start || r.end;
      if (t) { s.first = s.first === undefined ? t : Math.min(s.first, t); s.last = s.last === undefined ? t : Math.max(s.last, t); }
      const a = r.attributes;
      if ((r.kind === 'log' || r.kind === 'span') && a) {
        const repo = repoNameFromUrl(a['copilot_chat.repo.remote_url']);
        if (repo) {
          s.repos[repo] = (s.repos[repo] || 0) + 1;
          const branch = a['copilot_chat.repo.head_branch_name'];
          if (branch) s.branches[repo + '\n' + branch] = (s.branches[repo + '\n' + branch] || 0) + 1;
        }
      }
    }
    const list = [...sessions.values()].sort((a, b) => (a.first || 0) - (b.first || 0));
    for (const s of list) {
      const repos = Object.keys(s.repos).sort((x, y) => s.repos[y] - s.repos[x]);
      s.repo = repos[0];
      const branchKey = s.repo && topKey(Object.fromEntries(Object.entries(s.branches).filter(([k]) => k.startsWith(s.repo + '\n'))));
      s.branch = branchKey ? branchKey.split('\n')[1] : undefined;
      s.repos = repos;
      delete s.branches;
      if (s.repo) {
        s.label = s.repo + (s.branch ? ' @ ' + s.branch : '') + (repos.length > 1 ? ` (+${repos.length - 1})` : '');
      } else if (s.id === NO_SESSION_ID) {
        s.label = s.serviceName ? `${s.serviceName} ${NO_SESSION_ID}` : NO_SESSION_ID;
      } else {
        s.label = s.id.length > 16 ? `${s.id.slice(0, 8)}…${s.id.slice(-4)}` : s.id;
      }
    }
    return list;
  }

  function histTotals(list) {
    return list.reduce((acc, a) => ({
      count: acc.count + num(a.value && a.value.count),
      sum: acc.sum + num(a.value && a.value.sum),
      max: Math.max(acc.max, num(a.value && a.value.max)),
    }), { count: 0, sum: 0, max: 0 });
  }

  /**
   * Builds dashboard-ready statistics from normalized records.
   * @param {object[]} allRecords output of parseJsonl().records
   * @param {{ sessionId?: string }} [options] optional filter on resource `session.id`
   */
  function analyze(allRecords, options) {
    const opts = options || {};
    const records = opts.sessionId
      ? allRecords.filter(r => r.kind === 'lostSpan' || r.kind === 'unknown' || (r.resource && sessionIdOf(r.resource) === opts.sessionId))
      : allRecords;

    const logs = records.filter(r => r.kind === 'log');
    const spans = records.filter(r => r.kind === 'span');
    const metricPoints = records.filter(r => r.kind === 'metric');
    const lostSpans = records.filter(r => r.kind === 'lostSpan').length;
    const unknown = records.filter(r => r.kind === 'unknown').length;
    const metricExportLines = new Set(metricPoints.map(m => m.line)).size;

    // --- time range
    let minT = Infinity, maxT = -Infinity;
    for (const r of records) {
      for (const t of [r.time, r.start, r.end]) {
        if (typeof t === 'number' && isFinite(t)) { if (t < minT) minT = t; if (t > maxT) maxT = t; }
      }
    }
    const hasTime = isFinite(minT);

    // --- catalogs (what is in this file?)
    const eventCatalog = new Map();
    for (const l of logs) catalogAdd(eventCatalog, l.name, l.attributes);
    const spanCatalog = new Map();
    for (const s of spans) {
      const e = catalogAdd(spanCatalog, s.attributes[OP] || s.name, s.attributes, { totalMs: 0 });
      e.totalMs += num(s.durationMs);
    }
    const metricCatalogMap = new Map();
    for (const m of metricPoints) {
      const e = catalogAdd(metricCatalogMap, m.name, m.attributes, { type: m.type, unit: m.unit, description: m.description, series: new Set() });
      e.series.add(stableKey(m.resource) + stableKey(m.attributes));
    }
    const aggregated = [...aggregateMetrics(metricPoints).values()];
    const metricTotals = {};
    for (const a of aggregated) {
      const t = metricTotals[a.name] || (metricTotals[a.name] = { type: a.type, unit: a.unit, value: undefined });
      t.value = mergeValue(t.value, a.value, a.type);
    }
    const metricCatalog = finalizeCatalog(metricCatalogMap)
      .map(e => Object.assign(e, { series: e.series.size, total: metricTotals[e.name] && metricTotals[e.name].value }));

    const resourceAttrs = {};
    for (const r of records) {
      if (!r.resource) continue;
      for (const [k, v] of Object.entries(r.resource)) {
        if (!resourceAttrs[k]) resourceAttrs[k] = new Set();
        if (resourceAttrs[k].size < 5) resourceAttrs[k].add(sampleValue(v));
      }
    }

    // --- LLM usage (prefer per-call events, then spans, then aggregate metrics)
    const inferenceEvents = logs.filter(l => l.name === 'gen_ai.client.inference.operation.details');
    const chatSpans = spans.filter(s => s.attributes[OP] === 'chat');
    const llmSource = inferenceEvents.length ? 'events' : chatSpans.length ? 'spans' : 'metrics';
    const llmItems = llmSource === 'events'
      ? inferenceEvents.map(e => ({ t: e.time, a: e.attributes }))
      : chatSpans.map(s => ({ t: s.start, a: s.attributes }));
    const byModel = {};
    const modelEntry = model => byModel[model] || (byModel[model] = { model, calls: 0, inputTokens: 0, outputTokens: 0, errors: 0 });
    const finishReasons = {};
    const llmErrors = {};
    let inTok = 0, outTok = 0;
    for (const it of llmItems) {
      const m = modelEntry(it.a[MODEL_RES] || it.a[MODEL_REQ] || 'unknown');
      m.calls++;
      m.inputTokens += num(it.a[IN_TOK]);
      m.outputTokens += num(it.a[OUT_TOK]);
      inTok += num(it.a[IN_TOK]);
      outTok += num(it.a[OUT_TOK]);
      if (it.a['error.type']) { m.errors++; inc(llmErrors, it.a['error.type']); }
      let fr = it.a['gen_ai.response.finish_reasons'];
      if (typeof fr === 'string') { try { fr = JSON.parse(fr); } catch (_) { fr = [fr]; } }
      if (Array.isArray(fr)) for (const r of fr) inc(finishReasons, r);
    }
    if (llmSource === 'metrics') {
      for (const a of aggregated) {
        if (a.name !== 'gen_ai.client.token.usage') continue;
        const m = modelEntry(a.attributes[MODEL_RES] || a.attributes[MODEL_REQ] || 'unknown');
        const sum = num(a.value && a.value.sum);
        if (a.attributes['gen_ai.token.type'] === 'output') { m.outputTokens += sum; outTok += sum; }
        else { m.inputTokens += sum; inTok += sum; m.calls += num(a.value && a.value.count); }
      }
    }

    // Latency per model (gen_ai.client.operation.duration in s, copilot_chat.time_to_first_token)
    const latencyByModel = {};
    const latEntry = model => latencyByModel[model] || (latencyByModel[model] = { model, durationCount: 0, durationSum: 0, durationMax: 0, ttftCount: 0, ttftSum: 0 });
    for (const a of aggregated) {
      const model = a.attributes[MODEL_RES] || a.attributes[MODEL_REQ];
      if (!model || !isObject(a.value)) continue;
      if (a.name === 'gen_ai.client.operation.duration') {
        const l = latEntry(model);
        l.durationCount += a.value.count; l.durationSum += num(a.value.sum); l.durationMax = Math.max(l.durationMax, num(a.value.max));
      } else if (a.name === 'copilot_chat.time_to_first_token') {
        const l = latEntry(model);
        l.ttftCount += a.value.count; l.ttftSum += num(a.value.sum);
      }
    }
    if (!aggregated.some(a => a.name === 'gen_ai.client.operation.duration')) {
      for (const s of chatSpans) {
        const l = latEntry(s.attributes[MODEL_RES] || s.attributes[MODEL_REQ] || 'unknown');
        const d = num(s.durationMs) / 1000;
        l.durationCount++; l.durationSum += d; l.durationMax = Math.max(l.durationMax, d);
      }
    }
    const latency = Object.values(latencyByModel).map(l => {
      const ttft = l.ttftCount ? l.ttftSum / l.ttftCount : undefined;
      return {
        model: l.model,
        calls: l.durationCount,
        avgDurationS: l.durationCount ? l.durationSum / l.durationCount : undefined,
        maxDurationS: l.durationMax || undefined,
        // Docs say seconds, but some builds record ms: treat averages > 100 as ms.
        avgTtftS: ttft === undefined ? undefined : ttft > 100 ? ttft / 1000 : ttft,
      };
    }).sort((a, b) => b.calls - a.calls);

    // --- timeline
    const bucketMs = hasTime ? pickBucketMs(minT, maxT) : 0;
    const timeline = [];
    let bucketAt = () => undefined;
    if (hasTime) {
      const startB = Math.floor(minT / bucketMs) * bucketMs;
      const n = Math.floor((maxT - startB) / bucketMs) + 1;
      for (let i = 0; i < n; i++) timeline.push({ t: startB + i * bucketMs, llmCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 });
      bucketAt = t => (typeof t === 'number' ? timeline[Math.min(n - 1, Math.max(0, Math.floor((t - startB) / bucketMs)))] : undefined);
      for (const it of llmItems) {
        const b = bucketAt(it.t);
        if (b) { b.llmCalls++; b.inputTokens += num(it.a[IN_TOK]); b.outputTokens += num(it.a[OUT_TOK]); }
      }
    }

    // --- tools
    const toolEvents = logs.filter(l => l.name === 'copilot_chat.tool.call');
    const toolSpans = spans.filter(s => s.attributes[OP] === 'execute_tool');
    const toolSource = toolEvents.length ? 'events' : toolSpans.length ? 'spans' : 'metrics';
    const tools = {};
    const toolErrors = {};
    const toolEntry = name => tools[name] || (tools[name] = { name, calls: 0, failures: 0, totalMs: 0, maxMs: 0, timedCalls: 0 });
    if (toolSource === 'events') {
      for (const e of toolEvents) {
        const t = toolEntry(e.attributes[TOOL] || 'unknown');
        t.calls++;
        if (!truthy(e.attributes.success)) { t.failures++; inc(toolErrors, e.attributes['error.type'] || 'unknown'); }
        const d = num(e.attributes.duration_ms);
        t.totalMs += d; t.timedCalls++; t.maxMs = Math.max(t.maxMs, d);
        const b = bucketAt(e.time); if (b) b.toolCalls++;
      }
    } else if (toolSource === 'spans') {
      for (const s of toolSpans) {
        const t = toolEntry(s.attributes[TOOL] || s.name);
        t.calls++;
        if (s.attributes['error.type'] || (s.status && s.status.code === 2)) { t.failures++; inc(toolErrors, s.attributes['error.type'] || 'error'); }
        t.totalMs += num(s.durationMs); t.timedCalls++; t.maxMs = Math.max(t.maxMs, num(s.durationMs));
        const b = bucketAt(s.start); if (b) b.toolCalls++;
      }
    } else {
      for (const a of aggregated) {
        if (a.name === 'copilot_chat.tool.call.count') {
          const t = toolEntry(a.attributes[TOOL] || 'unknown');
          const n = num(a.value);
          t.calls += n;
          if (!truthy(a.attributes.success)) t.failures += n;
        } else if (a.name === 'copilot_chat.tool.call.duration' && isObject(a.value)) {
          const t = toolEntry(a.attributes[TOOL] || 'unknown');
          t.totalMs += num(a.value.sum); t.timedCalls += a.value.count; t.maxMs = Math.max(t.maxMs, num(a.value.max));
        }
      }
    }
    const toolList = Object.values(tools)
      .map(t => Object.assign(t, { avgMs: t.timedCalls ? t.totalMs / t.timedCalls : undefined, successRate: t.calls ? (t.calls - t.failures) / t.calls : undefined }))
      .sort((a, b) => b.calls - a.calls);
    const toolCalls = toolList.reduce((s, t) => s + t.calls, 0);
    const toolFailures = toolList.reduce((s, t) => s + t.failures, 0);

    // --- agent
    const turnEvents = logs.filter(l => l.name === 'copilot_chat.agent.turn');
    const invokeSpans = spans.filter(s => s.attributes[OP] === 'invoke_agent');
    const invMetric = aggregated.filter(a => a.name === 'copilot_chat.agent.invocation.duration');
    const turnsH = histTotals(aggregated.filter(a => a.name === 'copilot_chat.agent.turn.count'));
    const invH = histTotals(invMetric);
    const toolCallsPerTurn = {};
    for (const t of turnEvents) inc(toolCallsPerTurn, String(num(t.attributes.tool_call_count)));
    const byAgent = {};
    for (const a of invMetric) inc(byAgent, a.attributes['gen_ai.agent.name'] || 'unknown', num(a.value && a.value.count));
    if (!invMetric.length) for (const s of invokeSpans) inc(byAgent, s.attributes['gen_ai.agent.name'] || 'unknown');
    const agent = {
      invocations: invH.count || invokeSpans.length,
      avgInvocationS: invH.count ? invH.sum / invH.count : invokeSpans.length ? invokeSpans.reduce((s, x) => s + num(x.durationMs), 0) / invokeSpans.length / 1000 : undefined,
      maxInvocationS: invH.max || undefined,
      avgTurnsPerInvocation: turnsH.count ? turnsH.sum / turnsH.count : undefined,
      turnEvents: turnEvents.length,
      avgInputTokensPerTurn: turnEvents.length ? turnEvents.reduce((s, t) => s + num(t.attributes[IN_TOK]), 0) / turnEvents.length : undefined,
      avgOutputTokensPerTurn: turnEvents.length ? turnEvents.reduce((s, t) => s + num(t.attributes[OUT_TOK]), 0) / turnEvents.length : undefined,
      toolCallsPerTurn,
      byAgent,
    };

    // --- chat sessions
    const sessionStarts = logs.filter(l => l.name === 'copilot_chat.session.start');
    const chatSessionsByModel = {};
    const chatSessionsByAgent = {};
    for (const s of sessionStarts) {
      inc(chatSessionsByModel, s.attributes[MODEL_REQ] || 'unknown');
      inc(chatSessionsByAgent, s.attributes['gen_ai.agent.name'] || 'unknown');
    }
    const sessionCountMetric = metricTotals['copilot_chat.session.count'];

    // --- edits & outcomes
    const edits = { feedback: {}, hunks: {}, inline: {}, linesAdded: 0, linesRemoved: 0, byLanguage: {}, bySource: {}, survival: [], userFeedback: {}, userActions: {} };
    const langEntry = lang => edits.byLanguage[lang] || (edits.byLanguage[lang] = { language: lang, added: 0, removed: 0, accepted: 0, rejected: 0 });
    const survivalRaw = [];
    for (const l of logs) {
      const a = l.attributes;
      switch (l.name) {
        case 'copilot_chat.edit.feedback': inc(edits.feedback, a.outcome || 'unknown'); break;
        case 'copilot_chat.edit.hunk.action': inc(edits.hunks, a.outcome || 'unknown'); break;
        case 'copilot_chat.inline.done': inc(edits.inline, truthy(a.accepted) ? 'accepted' : 'rejected'); break;
        case 'copilot_chat.edit.survival':
          if (!truthy(a.did_branch_change)) survivalRaw.push({ delayMs: num(a.time_delay_ms), fourGram: num(a.survival_rate_four_gram), noRevert: num(a.survival_rate_no_revert) });
          break;
        case 'copilot_chat.user.feedback': inc(edits.userFeedback, a.rating || 'unknown'); break;
        default: break;
      }
    }
    for (const a of aggregated) {
      const v = num(a.value);
      if (a.name === 'copilot_chat.lines_of_code.count') {
        const L = langEntry(a.attributes['copilot_chat.language_id'] || 'unknown');
        if (a.attributes.type === 'removed') { edits.linesRemoved += v; L.removed += v; } else { edits.linesAdded += v; L.added += v; }
      } else if (a.name === 'copilot_chat.edit.acceptance.count') {
        const src = a.attributes['copilot_chat.edit.source'] || 'unknown';
        const S = edits.bySource[src] || (edits.bySource[src] = { source: src, accepted: 0, rejected: 0 });
        const outcome = a.attributes['copilot_chat.edit.outcome'] === 'rejected' ? 'rejected' : 'accepted';
        S[outcome] += v;
        if (a.attributes['copilot_chat.language_id']) langEntry(a.attributes['copilot_chat.language_id'])[outcome] += v;
      } else if (a.name === 'copilot_chat.user.action.count') {
        inc(edits.userActions, a.attributes.action || 'unknown', v);
      }
    }
    if (!Object.keys(edits.userFeedback).length) {
      for (const a of aggregated) if (a.name === 'copilot_chat.user.feedback.count') inc(edits.userFeedback, a.attributes.rating || 'unknown', num(a.value));
    }
    // Fall back to hunk-level line counts when the lines_of_code metric is absent
    if (!edits.linesAdded && !edits.linesRemoved) {
      for (const l of logs) {
        if (l.name === 'copilot_chat.edit.hunk.action' && l.attributes.outcome === 'accepted') {
          edits.linesAdded += num(l.attributes.lines_added);
          edits.linesRemoved += num(l.attributes.lines_removed);
        }
      }
    }
    const survivalByDelay = {};
    for (const s of survivalRaw) {
      const e = survivalByDelay[s.delayMs] || (survivalByDelay[s.delayMs] = { delayMs: s.delayMs, n: 0, fourGram: 0, noRevert: 0 });
      e.n++; e.fourGram += s.fourGram; e.noRevert += s.noRevert;
    }
    edits.survival = Object.values(survivalByDelay).sort((a, b) => a.delayMs - b.delayMs)
      .map(e => ({ delayMs: e.delayMs, samples: e.n, avgFourGram: e.fourGram / e.n, avgNoRevert: e.noRevert / e.n }));
    edits.byLanguage = Object.values(edits.byLanguage).sort((a, b) => (b.added + b.removed + b.accepted) - (a.added + a.removed + a.accepted));
    edits.bySource = Object.values(edits.bySource).sort((a, b) => (b.accepted + b.rejected) - (a.accepted + a.rejected));

    // --- errors
    const errors = {};
    for (const r of logs.concat(spans)) if (r.attributes['error.type']) inc(errors, r.attributes['error.type']);

    const sessions = listSessions(records);
    const versions = {};
    for (const s of sessions) if (s.serviceVersion) inc(versions, s.serviceVersion);

    return {
      summary: {
        records: records.length,
        logs: logs.length,
        spans: spans.length,
        lostSpans,
        metricExports: metricExportLines,
        metricPoints: metricPoints.length,
        unknown,
        timeRange: hasTime ? { start: minT, end: maxT } : undefined,
        sessions: sessions.length,
        chatSessions: sessionStarts.length || (sessionCountMetric ? num(sessionCountMetric.value) : 0),
        llmCalls: llmItems.length || Object.values(byModel).reduce((s, m) => s + m.calls, 0),
        inputTokens: inTok,
        outputTokens: outTok,
        toolCalls,
        toolFailures,
        linesAdded: edits.linesAdded,
        linesRemoved: edits.linesRemoved,
        contentCaptured: logs.some(l => 'gen_ai.input.messages' in l.attributes) || spans.some(s => 'gen_ai.input.messages' in s.attributes),
        versions,
      },
      sources: { llm: llmSource, tools: toolSource },
      sessions,
      resourceAttributes: Object.fromEntries(Object.entries(resourceAttrs).map(([k, v]) => [k, [...v]])),
      catalogs: {
        events: finalizeCatalog(eventCatalog),
        metrics: metricCatalog,
        spans: finalizeCatalog(spanCatalog).map(e => Object.assign(e, { avgMs: e.count ? e.totalMs / e.count : undefined })),
      },
      llm: { byModel: Object.values(byModel).sort((a, b) => b.calls - a.calls), finishReasons, errors: llmErrors, latency },
      timeline: { bucketMs, buckets: timeline },
      tools: { list: toolList, errors: toolErrors },
      agent,
      chatSessions: { byModel: chatSessionsByModel, byAgent: chatSessionsByAgent },
      edits,
      errors,
    };
  }

  /** Convenience: parse + analyze in one go. */
  function analyzeJsonl(text, options) {
    const parsed = parseJsonl(text);
    const result = analyze(parsed.records, options);
    result.summary.lines = parsed.lines;
    result.summary.parseErrors = parsed.errors.length;
    result.parseErrors = parsed.errors.slice(0, 50);
    return result;
  }

  return { parseJsonl, normalizeObject, aggregateMetrics, analyze, analyzeJsonl, listSessions, toMs, resourceAttributes };
});
