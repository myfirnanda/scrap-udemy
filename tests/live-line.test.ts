import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveLine } from '../src/live-line.js';

test('live line updates in place and adds a newline only when finished', () => {
  let output = '';
  const line = new LiveLine(value => { output += value; });
  line.update('progress 10%');
  line.update('progress 20%');
  line.finish('progress 100%');
  assert.equal(output, '\rprogress 10%\rprogress 20%\rprogress 100%\n');
});

test('spinner starts on the same live line and can be stopped', () => {
  let output = '';
  const line = new LiveLine(value => { output += value; });
  line.startSpinner('Membuka lecture...');
  line.stopSpinner();
  line.finish('selesai');
  assert.match(output, /^\r      Transcript \[\|\] Membuka lecture\.\.\.\rselesai/);
});
