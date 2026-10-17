'use strict';

// Copilot CLI hashes MCP server names (sha256) in telemetry. To show readable names the dashboard needs candidate
// names: this collects the server *names* (keys only - never commands, URLs, env or headers, which may hold secrets)
// from local Copilot CLI and VS Code MCP configuration files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function vscodeUserDirs(home, platform, env) {
  const products = ['Code', 'Code - Insiders', 'VSCodium'];
  let base;
  if (platform === 'win32') base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return products.map(p => path.join(base, p, 'User'));
}

/** Finds files named mcp.json / .mcp.json below `dir` (bounded depth). */
function findMcpFiles(dir, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && (e.name === 'mcp.json' || e.name === '.mcp.json' || e.name === 'mcp-config.json')) out.push(p);
    else if (e.isDirectory() && depth > 0 && e.name !== 'node_modules') findMcpFiles(p, depth - 1, out);
  }
  return out;
}

/** Lists candidate MCP config files for the current OS. */
function mcpConfigFiles({ home = os.homedir(), platform = process.platform, env = process.env, cwd = process.cwd() } = {}) {
  const files = [path.join(home, '.copilot', 'mcp-config.json'), path.join(cwd, '.vscode', 'mcp.json'), path.join(cwd, '.mcp.json')];
  for (const dir of vscodeUserDirs(home, platform, env)) {
    files.push(path.join(dir, 'mcp.json'));
    findMcpFiles(path.join(dir, 'profiles'), 1, files);
  }
  // Plugin-contributed servers (Copilot CLI bundled/installed plugins, VS Code agent plugins)
  for (const dir of [path.join(home, '.copilot', 'pkg'), path.join(home, '.copilot', 'installed-plugins'),
    path.join(home, '.vscode', 'agent-plugins'), path.join(home, '.vscode-insiders', 'agent-plugins')]) {
    findMcpFiles(dir, 5, files);
  }
  return [...new Set(files)];
}

const stripJsonComments = text => text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '');

/** Returns the sorted, de-duplicated MCP server names found in local configs. */
function readMcpServerNames(options) {
  const names = new Set();
  for (const file of mcpConfigFiles(options)) {
    let json;
    try {
      json = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')).replace(/,(\s*[}\]])/g, '$1'));
    } catch (_) { continue; }
    for (const key of ['mcpServers', 'servers']) {
      const servers = json && json[key];
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) for (const name of Object.keys(servers)) names.add(name);
    }
  }
  return [...names].sort();
}

module.exports = { readMcpServerNames, mcpConfigFiles };
