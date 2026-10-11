import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installConsoleLogFile } from '../src/logging.js';

test('console log file receives normal status lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'udemy-log-test-'));
  const file = path.join(root, 'run.log');
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  try {
    installConsoleLogFile(file);
    console.log('status', 42);
    assert.equal(fs.readFileSync(file, 'utf8'), 'status 42\n');
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
