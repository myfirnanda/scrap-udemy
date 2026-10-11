import assert from 'node:assert/strict';
import test from 'node:test';
import { isArabicTranscript } from '../src/transcript-language.js';

test('detects a predominantly Arabic transcript', () => {
  assert.equal(isArabicTranscript('هذا نص عربي طويل بما يكفي لاكتشاف لغة النص بشكل صحيح.'), true);
});

test('does not classify an English transcript with technical words as Arabic', () => {
  assert.equal(isArabicTranscript('This course uses Visual Studio, SQL Server, Azure, and .NET services.'), false);
});

test('ignores a short incidental Arabic fragment', () => {
  assert.equal(isArabicTranscript('English explanation with the word مرحبا once.'), false);
});
