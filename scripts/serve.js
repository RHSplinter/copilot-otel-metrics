#!/usr/bin/env node
/*
 * Minimal zero-dependency local server for the Copilot OTel dashboard.
 * Usage: node scripts/serve.js [path/to/copilot-otel.jsonl] [--port 4747]
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { resolveDataFile } = require('./dataFile');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = Number(portIdx >= 0 ? args[portIdx + 1] : process.env.PORT || 4747);
const fileArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
const DATA_FILE = resolveDataFile(fileArg);

const ROOT = path.join(__dirname, '..');
const ROUTES = {
  '/': path.join(ROOT, 'dashboard', 'index.html'),
  '/styles.css': path.join(ROOT, 'dashboard', 'styles.css'),
  '/charts.js': path.join(ROOT, 'dashboard', 'charts.js'),
  '/app.js': path.join(ROOT, 'dashboard', 'app.js'),
  '/otelParser.js': path.join(ROOT, 'src', 'parser', 'otelParser.js'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/source') {
    const stat = fs.statSync(DATA_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ path: DATA_FILE, name: path.basename(DATA_FILE), size: stat.size, modified: stat.mtimeMs }));
  }
  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(DATA_FILE).pipe(res);
  }
  const file = ROUTES[url.pathname];
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Copilot OTel dashboard: http://localhost:${PORT}`);
  console.log(`Serving data from: ${path.relative(process.cwd(), DATA_FILE) || DATA_FILE}`);
});
