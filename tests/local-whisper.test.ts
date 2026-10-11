import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldUseLocalWhisper } from '../src/local-whisper.js';

test('local Whisper is used only after Udemy transcript absence is established', () => {
  assert.equal(shouldUseLocalWhisper('Kontrol transcript tidak ditemukan; transcript belum dapat dikonfirmasi tidak tersedia.'), true);
  assert.equal(shouldUseLocalWhisper('Transcript berbahasa Arab dan caption English tidak tersedia.'), true);
});

test('navigation and network failures do not trigger local Whisper', () => {
  assert.equal(shouldUseLocalWhisper('Navigasi lecture belum siap.'), false);
  assert.equal(shouldUseLocalWhisper('Network timeout.'), false);
});
