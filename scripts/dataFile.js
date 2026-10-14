'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_FILE = path.join(ROOT, 'data', 'copilot-otel.jsonl');
const SAMPLE_FILE = path.join(ROOT, 'data', 'sample-copilot-otel.jsonl');

/**
 * Resolves which JSONL file to use: explicit path > COPILOT_OTEL_FILE env > data/copilot-otel.jsonl > bundled sample.
 */
function resolveDataFile(explicit) {
  const candidate = explicit || process.env.COPILOT_OTEL_FILE;
  if (candidate) {
    const p = path.resolve(candidate);
    if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
    return p;
  }
  return fs.existsSync(DEFAULT_FILE) ? DEFAULT_FILE : SAMPLE_FILE;
}

module.exports = { resolveDataFile, DEFAULT_FILE, SAMPLE_FILE };
