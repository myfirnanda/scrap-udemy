import assert from 'node:assert/strict';
import test from 'node:test';
import { decidePageHealth, type PageSignals } from '../src/page-health.js';

const healthy: PageSignals = {
  urlPath: '/course/context-engineering/learn/lecture/57528597',
  title: 'course: context engineering | udemy',
  curriculumVisible: true,
  expectedLecture: true,
  visibleChallengeElement: false,
  shortChallengePage: false
};

test('normal course remains ready when its content mentions access denied', () => {
  assert.equal(decidePageHealth({ ...healthy, shortChallengePage: true }).state, 'ready');
});

test('course slug containing challenge is not treated as a security page', () => {
  assert.equal(decidePageHealth({ ...healthy, urlPath: '/course/30-day-coding-challenge/learn/lecture/1' }).state, 'ready');
});

test('course title containing Access Denied remains ready while curriculum is healthy', () => {
  assert.equal(decidePageHealth({ ...healthy, title: 'access denied: fixing iam | udemy' }).state, 'ready');
});

test('a hidden challenge widget does not block a healthy course', () => {
  assert.equal(decidePageHealth({ ...healthy, visibleChallengeElement: false }).state, 'ready');
});

test('a visible challenge widget blocks immediately', () => {
  assert.equal(decidePageHealth({ ...healthy, visibleChallengeElement: true }).state, 'blocked');
});

test('a challenge page without Course Player requires two matching signals', () => {
  const result = decidePageHealth({ ...healthy, curriculumVisible: false, expectedLecture: false, title: 'Just a moment...', shortChallengePage: true });
  assert.equal(result.state, 'blocked');
  assert.deepEqual(result.evidence, ['challenge-title', 'short-challenge-page']);
});

test('one soft signal without Course Player is transient, not blocked', () => {
  assert.equal(decidePageHealth({ ...healthy, curriculumVisible: false, expectedLecture: false, title: 'Just a moment...' }).state, 'transient');
});
