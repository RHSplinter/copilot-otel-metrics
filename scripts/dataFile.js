'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_FILE = path.join(ROOT, 'data', 'copilot-otel.jsonl');
const SAMPLE_FILE = path.join(ROOT, 'data', 'sample-copilot-otel.jsonl');

/**
 * Resolves explicit path > COPILOT_OTEL_FILE > profile export > repository export > bundled sample.
 */
function resolveDataFile(explicit) {
  const candidate = explicit || process.env.COPILOT_OTEL_FILE;
  if (candidate) {
    const p = path.resolve(candidate);
    if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
    return p;
  }
  const profileFile = path.join(os.homedir(), '.copilot', 'otel', 'copilot-otel.jsonl');
  if (fs.existsSync(profileFile)) return profileFile;
  return fs.existsSync(DEFAULT_FILE) ? DEFAULT_FILE : SAMPLE_FILE;
}

module.exports = { resolveDataFile, DEFAULT_FILE, SAMPLE_FILE };
