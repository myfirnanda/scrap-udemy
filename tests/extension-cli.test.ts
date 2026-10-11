import assert from 'node:assert/strict';
import test from 'node:test';
import { isModalStateFailure } from '../src/extension-cli.js';

test('beforeunload modal failures are recognized for automatic recovery', () => {
  const error = Object.assign(new Error('command failed'), {
    stdout: 'Error: Tool "browser_run_code_unsafe" does not handle the modal state.\n### Modal state\n- ["beforeunload" dialog with message ""]'
  });
  assert.equal(isModalStateFailure(error), true);
  assert.equal(isModalStateFailure(new Error('ordinary locator timeout')), false);
});
