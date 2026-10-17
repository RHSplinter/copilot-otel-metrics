'use strict';

// Copilot CLI / agent host spans identify their session only by `gen_ai.conversation.id`. The CLI keeps each
// session's title, repository and branch in `~/.copilot/session-state/<id>/workspace.yaml`; read just those fields
// so the dashboard can show readable session names.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIELDS = { name: 'name', summary: 'summary', repository: 'repository', branch: 'branch' };

function parseWorkspaceYaml(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\w+):\s*(.*)$/);
    if (!m || !FIELDS[m[1]]) continue;
    let v = m[2].trim();
    if (/^[|>][-+]?$/.test(v)) {
      // Block scalar: the value is on the following indented lines.
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      v = block.filter(Boolean).join(' ');
    } else if (/^(['"]).*\1$/.test(v)) {
      v = v.slice(1, -1);
    }
    if (v) out[FIELDS[m[1]]] = v;
  }
  if (!out.name && out.summary) out.name = out.summary;
  delete out.summary;
  return out;
}

/** @returns {Object<string, { name?: string, repository?: string, branch?: string }>} keyed by session id */
function readCliSessions(home = os.homedir()) {
  const dir = path.join(home, '.copilot', 'session-state');
  const sessions = {};
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return sessions;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const info = parseWorkspaceYaml(fs.readFileSync(path.join(dir, e.name, 'workspace.yaml'), 'utf8'));
      if (Object.keys(info).length) sessions[e.name] = info;
    } catch (_) { /* no workspace.yaml */ }
  }
  return sessions;
}

module.exports = { readCliSessions, parseWorkspaceYaml };
