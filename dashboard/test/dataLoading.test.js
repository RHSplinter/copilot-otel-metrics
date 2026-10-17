'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const parser = require('../src/parser/otelParser');

const root = path.join(__dirname, '..');

test('server selects the profile export once and serves fresh contents on reload', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-otel-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profileFile = path.join(home, '.copilot', 'otel', 'copilot-otel.jsonl');
  fs.mkdirSync(path.dirname(profileFile), { recursive: true });
  fs.writeFileSync(profileFile, '{}\n');
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'serve.js'), '--port', '0'], {
    env: { ...process.env, USERPROFILE: home, HOME: home, COPILOT_OTEL_FILE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await (await fetch(`${base}/api/source`)).json()).path, profileFile);
  assert.equal(await (await fetch(`${base}/api/data`)).text(), '{}\n');
  fs.appendFileSync(profileFile, '{}\n');
  assert.equal(await (await fetch(`${base}/api/data`)).text(), '{}\n{}\n');
  fs.unlinkSync(profileFile);
  assert.equal((await fetch(`${base}/api/data`)).status, 404);
  assert.equal((await fetch(`${base}/api/source`)).status, 404);
  fs.writeFileSync(profileFile, '{}\n');
  assert.equal((await fetch(`${base}/api/data`)).status, 200);
});

test('resolution prioritizes explicit and environment paths, with absent-profile fallbacks', () => {
  const code = fs.readFileSync(path.join(root, 'scripts', 'dataFile.js'), 'utf8');
  const sample = path.join(root, 'data', 'sample-copilot-otel.jsonl');
  const local = path.join(root, 'data', 'copilot-otel.jsonl');
  const profile = path.join('profile', '.copilot', 'otel', 'copilot-otel.jsonl');
  const existing = new Set([sample]);
  const env = {};
  const context = {
    __dirname: path.join(root, 'scripts'), module: { exports: {} }, process: { env },
    require: name => name === 'node:fs' ? { existsSync: p => existing.has(p) }
      : name === 'node:os' ? { homedir: () => 'profile' } : require(name),
  };
  vm.runInNewContext(code, context);
  const resolve = context.module.exports.resolveDataFile;
  assert.equal(resolve(), sample);
  existing.add(local);
  assert.equal(resolve(), local);
  existing.add(profile);
  assert.equal(resolve(), profile);
  env.COPILOT_OTEL_FILE = sample;
  assert.equal(resolve(), sample);
  assert.equal(resolve(local), local);
  assert.throws(() => resolve('missing.jsonl'), /File not found/);
});

function dashboard(fetch) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: false, textContent: '', innerHTML: '', clicks: 0,
      addEventListener(name, handler) { this[name] = handler; },
      click() { this.clicks++; },
    });
    return elements.get(id);
  };
  const window = {
    CopilotOtel: parser,
    Charts: new Proxy({ fmt: String, esc: String }, { get: (target, key) => target[key] || (() => '') }),
  };
  const document = {
    getElementById: get, addEventListener(name, handler) { this[name] = handler; },
    body: { classList: { add() {}, remove() {} } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8'),
    { window, document, fetch, location: { protocol: 'http:' }, setTimeout, clearTimeout });
  return { window, document, get };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('session dropdown prefixes model tags and retains session IDs as filter values', async () => {
  const data = ['hydrafusion', 'hydrafusion-max', 'gpt-4o'].map((model, i) => JSON.stringify({
    hrTime: [1750000000, 0], _body: 'gen_ai.client.inference.operation.details',
    resource: { attributes: { 'session.id': `window-${i}` } },
    attributes: { 'event.name': 'gen_ai.client.inference.operation.details', 'gen_ai.request.model': model },
  })).join('\n');
  const ui = dashboard(async url => {
    if (url === '/api/source') return { ok: true, json: async () => ({ path: 'models.jsonl', size: data.length, modified: 1 }) };
    if (url === '/api/names') return { ok: true, json: async () => ({ mcpServers: [] }) };
    return { ok: true, text: async () => data };
  });
  await settle();
  const select = ui.get('sessionFilter');
  assert.match(select.innerHTML, /value="window-0"[^>]*>\[HydraFusion\] window-0/);
  assert.match(select.innerHTML, /value="window-1"[^>]*>\[HydraFusion Max\] window-1/);
  assert.match(select.innerHTML, /value="window-2"[^>]*>window-2/);
  select.value = 'window-1';
  select.change();
  assert.equal(ui.window.__analysis.summary.sessions, 1);
  await ui.get('reload').click();
  await settle();
  assert.equal(select.value, 'window-1');
});

test('shows a loading indicator with the file name until the data is parsed', async () => {
  let releaseData;
  const dataReady = new Promise(resolve => { releaseData = resolve; });
  const ui = dashboard(async url => url === '/api/source'
    ? { ok: true, json: async () => ({ path: '/home/me/.copilot/otel/copilot-otel.jsonl', name: 'copilot-otel.jsonl', size: 3, modified: 1 }) }
    : { ok: true, text: () => dataReady });
  await settle();
  assert.equal(ui.get('loading').hidden, false);
  assert.equal(ui.get('loadingTitle').textContent, 'Loading copilot-otel.jsonl…');
  assert.match(ui.get('loadingDetail').textContent, /\.copilot\/otel\/copilot-otel\.jsonl/);
  assert.equal(ui.get('reload').disabled, true);
  releaseData('{}\n');
  await settle();
  assert.equal(ui.get('loading').hidden, true);
  assert.equal(ui.get('reload').disabled, false);
  assert.equal(ui.window.__analysis.summary.lines, 1);
});

test('dashboard loads once, reloads the server, and reloads a newly selected file handle', async () => {
  const calls = [];
  let data = '{}\n';
  const ui = dashboard(async (url, options) => {
    if (url === '/api/names') return { ok: true, json: async () => ({ mcpServers: [] }) };
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ path: 'profile-export.jsonl', size: data.length, modified: 1 }),
      text: async () => data,
    };
  });
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(ui.window.__analysis.summary.lines, 1);
  data += '{}\n';
  await ui.get('reload').click();
  assert.equal(calls.length, 4);
  assert.equal(ui.window.__analysis.summary.lines, 2);
  assert.ok(calls.every(call => call.options.cache === 'no-store'));

  let localData = '{}\n';
  ui.window.showOpenFilePicker = async () => [{
    getFile: async () => ({ name: 'picked.jsonl', size: localData.length, text: async () => localData }),
  }];
  ui.get('openFile').click({ preventDefault() {} });
  await settle();
  assert.equal(ui.window.__analysis.summary.lines, 1);
  localData += '{}\n{}\n';
  await ui.get('reload').click();
  assert.equal(ui.window.__analysis.summary.lines, 3);
  assert.equal(calls.length, 4);
  assert.match(ui.get('source').textContent, /picked.jsonl/);

  ui.window.showOpenFilePicker = async () => { throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); };
  ui.get('openFile').click({ preventDefault() {} });
  await settle();
  assert.equal(ui.get('loadError').hidden, true);

  await ui.get('fileInput').change({ target: { files: [{ name: 'fallback.jsonl', size: 3, text: async () => '{}\n' }] } });
  await settle();
  await ui.get('reload').click();
  assert.equal(ui.get('fileInput').clicks, 1);
  assert.match(ui.get('loadError').textContent, /select the loaded file again/);
  assert.equal(calls.length, 4);
});

test('read failures are visible, preserve loaded data, and allow retry', async () => {
  let failing = false;
  const ui = dashboard(async () => {
    if (failing) throw new Error('File unavailable');
    return { ok: true, json: async () => ({ path: 'export.jsonl', size: 3, modified: 1 }), text: async () => '{}\n' };
  });
  await settle();
  failing = true;
  await ui.get('reload').click();
  assert.match(ui.get('loadError').textContent, /File unavailable/);
  assert.equal(ui.get('content').hidden, false);
  assert.equal(ui.window.__analysis.summary.lines, 1);
  failing = false;
  await ui.get('reload').click();
  assert.equal(ui.get('loadError').hidden, true);
});

test('dropped file handles reload fresh data without switching back to the server', async () => {
  let serverCalls = 0;
  const ui = dashboard(async url => {
    if (url !== '/api/names') serverCalls++;
    return { ok: true, json: async () => ({ path: 'server.jsonl', size: 3, modified: 1 }), text: async () => '{}\n' };
  });
  await settle();
  let contents = '{}\n{}\n';
  let unavailable = false;
  const handle = {
    getFile: async () => {
      if (unavailable) throw new Error('Dropped file removed');
      return { name: 'dropped.jsonl', size: contents.length, text: async () => contents };
    },
  };
  await ui.document.drop({
    preventDefault() {},
    dataTransfer: { files: [{}], items: [{ getAsFileSystemHandle: async () => handle }] },
  });
  assert.equal(ui.window.__analysis.summary.lines, 2);
  contents += '{}\n';
  await ui.get('reload').click();
  assert.equal(ui.window.__analysis.summary.lines, 3);
  unavailable = true;
  await ui.get('reload').click();
  assert.match(ui.get('loadError').textContent, /Dropped file removed/);
  assert.equal(ui.window.__analysis.summary.lines, 3);
  assert.equal(serverCalls, 2);
});

test('an initial server error can be retried with Reload', async () => {
  let missing = true;
  const ui = dashboard(async () => ({
    ok: !missing,
    json: async () => ({ path: 'export.jsonl', size: 3, modified: 1 }),
    text: async () => missing ? 'File not found' : '{}\n',
  }));
  await settle();
  assert.equal(ui.get('content').hidden, true);
  assert.match(ui.get('loadError').textContent, /File not found/);
  missing = false;
  await ui.get('reload').click();
  assert.equal(ui.get('loadError').hidden, true);
  assert.equal(ui.window.__analysis.summary.lines, 1);
});
