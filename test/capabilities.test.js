'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../src/parser/otelParser.js');
const { readMcpServerNames } = require('../scripts/mcpNames.js');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const res = { attributes: { 'service.name': 'github-copilot', 'service.version': '1.0.95-0' } };
const scope = { name: 'github.copilot' };
let n = 0;
const span = (name, attributes, extra = {}) => ({
  type: 'span', traceId: 't1', spanId: 's' + n++, name, kind: 0, startTime: [1790000000, 0], endTime: [1790000002, 0],
  attributes, status: { code: extra.failed ? 2 : 0 }, events: [], resource: res, instrumentationScope: scope, ...extra.fields,
});
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n');

test('sha256Hex matches node:crypto', () => {
  for (const s of ['', 'abc', 'github-mcp-server', 'é ünïcode ✓', 'x'.repeat(1000)]) assert.equal(P.sha256Hex(s), sha(s));
});

test('parses Copilot CLI metric lines as cumulative sums', () => {
  const metric = value => ({ type: 'metric', name: 'github.copilot.mcp.server.connection.count', unit: '{attempt}', dataPoints: [{ attributes: { outcome: 'success' }, startTime: [1790000000, 0], endTime: [1790000000 + value, 0], value }], resource: res, instrumentationScope: scope });
  const a = P.analyzeJsonl(jsonl([metric(2), metric(5)]));
  assert.equal(a.summary.unknown, 0);
  assert.deepEqual(a.capabilities.mcp.connections, { success: 5 });
});

test('analyzes agents, skills, custom agents, hashed MCP servers and permissions', () => {
  const ctx = {
    'github.copilot.context.skills': JSON.stringify(['review', 'unused-skill']),
    'github.copilot.context.custom_agent_names': JSON.stringify(['docs-writer']),
    'github.copilot.context.mcp_server_names': JSON.stringify([sha('github-mcp-server'), sha('my-private-server')]),
  };
  const tool = `${sha('github-mcp-server')}/${sha('search_code')}`;
  const priv = `${sha('my-private-server')}/${sha('do_thing')}`;
  const lines = [
    span('invoke_agent', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': 'c1', ...ctx, 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10, 'github.copilot.turn_count': 2 }, { fields: { spanId: 'root' } }),
    span('invoke_agent explore', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'explore', 'gen_ai.conversation.id': 'c1' }, { fields: { spanId: 'sub', parentSpanId: 'root' } }),
    span('invoke_agent docs-writer', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'docs-writer', 'gen_ai.conversation.id': 'c2', ...ctx }),
    span('execute_tool skill review', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'skill', 'gen_ai.skill.name': 'review' }, { fields: { parentSpanId: 'root' } }),
    span(`execute_tool ${tool}`, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': tool, 'github.copilot.tool.parameters.mcp_server_name_hash': sha('github-mcp-server') }, { fields: { parentSpanId: 'root' } }),
    span(`execute_tool ${tool}`, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': tool, 'github.copilot.tool.parameters.mcp_server_name_hash': sha('github-mcp-server'), 'error.type': 'McpError' }, { failed: true, fields: { parentSpanId: 'root' } }),
    span(`execute_tool ${priv}`, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': priv, 'github.copilot.tool.parameters.mcp_server_name_hash': sha('my-private-server') }, { fields: { parentSpanId: 'root' } }),
    span('permission', { 'github.copilot.permission.kind': 'shell', 'github.copilot.permission.result': 'approved' }),
    span('permission', { 'github.copilot.permission.kind': 'shell', 'github.copilot.permission.result': 'denied-interactively-by-user' }),
    span('session.timing.skills_loading', { 'github.copilot.session.timing.phase': 'skills_loading' }),
    span('session.timing.unrelated_phase', {}),
  ];
  const c = P.analyzeJsonl(jsonl(lines)).capabilities;

  assert.equal(c.contextConversations, 2);
  const agents = Object.fromEntries(c.agents.map(a => [a.name, a]));
  assert.equal(agents.explore.subagent, true);
  assert.equal(agents['docs-writer'].custom, true);
  assert.equal(agents['Copilot CLI'].inputTokens, 100);

  const skills = Object.fromEntries(c.skills.map(s => [s.name, s]));
  assert.equal(skills.review.count, 1);
  assert.equal(skills.review.availableIn, 2);
  assert.equal(skills['unused-skill'].count, 0);
  assert.deepEqual(c.customAgents.map(x => [x.name, x.invocations]), [['docs-writer', 1]]);

  const gh = c.mcp.servers.find(s => s.name === 'github-mcp-server');
  assert.ok(gh.resolved);
  assert.equal(gh.calls, 2);
  assert.equal(gh.failures, 1);
  assert.deepEqual(gh.tools.map(t => t.name), ['search_code']);
  const unresolved = c.mcp.servers.find(s => s.id === sha('my-private-server'));
  assert.equal(unresolved.resolved, false);
  assert.match(unresolved.name, /^[0-9a-f]{8}…$/);

  assert.deepEqual(c.permissions, [{ kind: 'shell', approved: 1, denied: 1, other: 0 }]);
  assert.deepEqual(c.startupTimings.map(t => t.name), ['skills_loading']);

  const resolved = P.analyzeJsonl(jsonl(lines), { knownNames: ['my-private-server'] }).capabilities;
  const priv2 = resolved.mcp.servers.find(s => s.id === sha('my-private-server'));
  assert.equal(priv2.name, 'my-private-server');
  assert.equal(priv2.resolved, true);
});

test('counts CLI spans alongside VS Code events without double counting VS Code spans', () => {
  const vscodeRes = { _rawAttributes: [['service.name', 'copilot-chat'], ['session.id', 'w']], _asyncAttributesPending: false };
  const log = attrs => ({ hrTime: [1790000000, 0], resource: vscodeRes, instrumentationScope: { name: 'copilot-chat' }, attributes: attrs, _body: '' });
  const vscodeSpan = { resource: { attributes: { 'service.name': 'copilot-chat', 'session.id': 'w' } }, instrumentationScope: { name: 'copilot-chat' }, traceId: 'v', spanId: 'v1', name: 'execute_tool read_file', kind: 0, startTime: [1790000000, 0], endTime: [1790000001, 0], attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'read_file' }, status: { code: 0 } };
  const lines = [
    log({ 'event.name': 'copilot_chat.tool.call', 'gen_ai.tool.name': 'read_file', duration_ms: 5, success: true }),
    vscodeSpan,
    span('execute_tool view', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'view' }),
  ];
  const a = P.analyzeJsonl(jsonl(lines));
  assert.equal(a.sources.tools, 'events + spans');
  assert.deepEqual(a.tools.list.map(t => [t.name, t.calls]).sort(), [['read_file', 1], ['view', 1]]);
});

test('readMcpServerNames returns only server names from Copilot CLI and VS Code configs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpnames-'));
  try {
    fs.mkdirSync(path.join(home, '.copilot', 'pkg', 'win32-x64', '1.0.0', 'plugins', 'computer-use'), { recursive: true });
    fs.writeFileSync(path.join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { 'cli-server': { command: 'x', env: { TOKEN: 'secret' } } } }));
    fs.writeFileSync(path.join(home, '.copilot', 'pkg', 'win32-x64', '1.0.0', 'plugins', 'computer-use', 'mcp.json'), JSON.stringify({ mcpServers: { 'computer-use': {} } }));
    const user = path.join(home, '.config', 'Code', 'User');
    fs.mkdirSync(user, { recursive: true });
    fs.writeFileSync(path.join(user, 'mcp.json'), '{\n // comment with "quotes"\n "servers": { "vscode-server": { "url": "https://x//y" }, },\n}');
    fs.writeFileSync(path.join(home, 'broken.json'), '{');
    const names = readMcpServerNames({ home, platform: 'linux', env: {}, cwd: home });
    assert.deepEqual(names, ['cli-server', 'computer-use', 'vscode-server']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
