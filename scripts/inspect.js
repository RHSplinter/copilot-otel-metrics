#!/usr/bin/env node
/*
 * Prints an inventory of a Copilot OTel JSONL file: record types, events, metrics, spans and headline numbers.
 * Usage: node scripts/inspect.js [path] [--json]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyzeJsonl } = require('../src/parser/otelParser');
const { resolveDataFile } = require('./dataFile');

const args = process.argv.slice(2);
const file = resolveDataFile(args.find(a => !a.startsWith('--')));
const result = analyzeJsonl(fs.readFileSync(file, 'utf8'));

if (args.includes('--json')) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

const s = result.summary;
const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(n));
const date = t => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '-');

console.log(`File: ${path.relative(process.cwd(), file)}`);
console.log(`Time range: ${date(s.timeRange && s.timeRange.start)} → ${date(s.timeRange && s.timeRange.end)}`);
console.log(`Lines: ${fmt(s.lines)}  (parse errors: ${s.parseErrors})`);
console.log(`  log records (events): ${fmt(s.logs)}`);
console.log(`  metric exports:       ${fmt(s.metricExports)}  (${fmt(s.metricPoints)} data points)`);
console.log(`  spans:                ${fmt(s.spans)}`);
console.log(`  empty {} (lost spans): ${fmt(s.lostSpans)}`);
if (s.unknown) console.log(`  unrecognized:         ${fmt(s.unknown)}`);
console.log(`VS Code windows (resource session.id): ${s.sessions}   versions: ${Object.keys(s.versions).join(', ') || '-'}`);
console.log(`Chat sessions: ${fmt(s.chatSessions)}   LLM calls: ${fmt(s.llmCalls)}   tokens in/out: ${fmt(s.inputTokens)} / ${fmt(s.outputTokens)}`);
console.log(`Tool calls: ${fmt(s.toolCalls)} (${fmt(s.toolFailures)} failed)   lines added/removed: ${fmt(s.linesAdded)} / ${fmt(s.linesRemoved)}`);
console.log(`Content captured: ${s.contentCaptured ? 'yes' : 'no'}`);

console.log('\nResource attributes:');
for (const [k, v] of Object.entries(result.resourceAttributes)) console.log(`  ${k.padEnd(28)} ${v.join(', ')}`);

console.log('\nEvents (log records):');
for (const e of result.catalogs.events) console.log(`  ${String(e.count).padStart(6)}  ${e.name}   [${e.attributes.map(a => a.key).filter(k => k !== 'event.name').join(', ')}]`);

console.log('\nMetrics:');
for (const m of result.catalogs.metrics) {
  const total = m.total && typeof m.total === 'object' ? `count=${fmt(m.total.count)} sum=${fmt(m.total.sum)}` : `total=${fmt(m.total)}`;
  console.log(`  ${m.name.padEnd(42)} ${m.type.padEnd(10)} ${String(m.unit).padEnd(10)} series=${String(m.series).padEnd(4)} ${total}   [${m.attributes.map(a => a.key).join(', ')}]`);
}

if (result.catalogs.spans.length) {
  console.log('\nSpans:');
  for (const sp of result.catalogs.spans) console.log(`  ${String(sp.count).padStart(6)}  ${sp.name}  avg ${fmt(sp.avgMs)} ms`);
}
