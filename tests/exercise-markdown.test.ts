import assert from 'node:assert/strict';
import test from 'node:test';
import { exerciseToMarkdown } from '../src/exercise-markdown.js';

test('coding exercise Markdown includes instructions and starter TODO without solution data', () => {
  const markdown = exerciseToMarkdown({
    title: 'Token Budget Lab',
    instructionsHtml: '<p>Implement the manager.</p>',
    learningObjective: 'Practice budget enforcement.',
    hintsHtml: ['<p>Start with the empty case.</p>'],
    files: [{ fileName: 'exercise.py', content: '# TODO: implement\npass' }],
    language: 'PYTHON3_10'
  }, html => html.replace(/<\/?p>/g, ''));

  assert.match(markdown, /^# Token Budget Lab/m);
  assert.match(markdown, /```python\n# TODO: implement/);
  assert.match(markdown, /Start with the empty case/);
  assert.doesNotMatch(markdown, /solution|correct_response|evaluation test/i);
});
