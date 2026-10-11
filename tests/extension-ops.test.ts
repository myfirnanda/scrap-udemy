import assert from 'node:assert/strict';
import test from 'node:test';
import { normalCoursePlayerUrl, restoreLectureCode } from '../src/extension-ops.js';

test('lab URL is forced back into the normal Course Player', () => {
  const url = normalCoursePlayerUrl(
    'https://www.udemy.com/course/example/learn/lecture/12345?cteMode=standalone&udFrontends=true'
  );

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('udFrontends'), 'false');
  assert.equal(parsed.searchParams.has('cteMode'), false);
  assert.equal(parsed.pathname, '/course/example/learn/lecture/12345');
});

test('lecture recovery navigates directly to the exact lecture URL', () => {
  const code = restoreLectureCode(
    'https://www.udemy.com/course/example/learn/lecture/12345',
    '12345'
  );

  assert.match(code, /page\.goto\("https:\/\/www\.udemy\.com\/course\/example\/learn\/lecture\/12345"/);
  assert.match(code, /curriculum-section-container/);
  assert.match(code, /location\.pathname\.includes\('\/lecture\/' \+ id\)/);
});
