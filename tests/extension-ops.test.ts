import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadAttachmentCode, normalCoursePlayerUrl, restoreLectureCode } from '../src/extension-ops.js';

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
  assert.match(code, /\(\?:lecture\|quiz\)\/.*id/);
});

test('resource downloads capture the Udemy signed asset URL', () => {
  const code = downloadAttachmentCode(1, 2, 0, 'unused.tmp');

  assert.doesNotThrow(() => new Function(`return (${code})`));
  assert.match(code, /supplementary-assets/);
  assert.match(code, /download_urls/);
  assert.match(code, /attachment\.kind === 'download' && attachment\.href/);
  assert.match(code, /kind: 'direct'/);
  assert.match(code, /element => element\.click\(\)/);
});
