import assert from 'node:assert/strict';
import test from 'node:test';
import { appendTranscriptCues, transcriptCompletedLine, transcriptPercent, transcriptProgressLine } from '../src/transcript-progress.js';

test('transcript cue batches merge overlapping windows without duplication', () => {
  const cues = [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }];
  appendTranscriptCues(cues, [{ key: 'b', text: 'B' }, { key: 'c', text: 'C' }]);
  assert.deepEqual(cues.map(cue => cue.key), ['a', 'b', 'c']);
});

test('transcript percentage is monotonic and stays below 100 until complete', () => {
  assert.equal(transcriptPercent({ availability: 'available', reason: null, scrollTop: 80, scrollExtent: 100 }, 0), 80);
  assert.equal(transcriptPercent({ availability: 'available', reason: null, scrollTop: 40, scrollExtent: 100 }, 80), 80);
  assert.equal(transcriptPercent({ availability: 'available', reason: null, scrollTop: 100, scrollExtent: 100 }, 80), 99);
  assert.equal(transcriptPercent({ availability: 'available', reason: null, complete: true }, 99), 100);
});

test('progress line falls back to an active heartbeat without a measurable extent', () => {
  assert.match(transcriptProgressLine(null, 42, 3, 12), /\[aktif\].*42 cue.*batch 3.*0:12/);
});

test('100 percent is reserved for the saved transcript line', () => {
  assert.doesNotMatch(transcriptProgressLine(99, 42, 3, 12), /100%/);
  assert.match(transcriptCompletedLine(42), /100%.*42 cue.*tersimpan/);
});
