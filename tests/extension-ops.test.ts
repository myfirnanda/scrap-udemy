import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreLectureCode } from '../src/extension-ops.js';

test('lecture recovery navigates directly to the exact lecture URL', () => {
  const code = restoreLectureCode(
    'https://www.udemy.com/course/example/learn/lecture/12345',
    '12345'
  );

  assert.match(code, /page\.goto\("https:\/\/www\.udemy\.com\/course\/example\/learn\/lecture\/12345"/);
  assert.match(code, /curriculum-section-container/);
  assert.match(code, /location\.pathname\.includes\('\/lecture\/' \+ id\)/);
});
