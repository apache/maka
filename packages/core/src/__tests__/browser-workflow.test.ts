import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BROWSER_WORKFLOW_REDACTED_VALUE,
  isBrowserWorkflow,
  isSafeBrowserWorkflowUrl,
  isSensitiveBrowserInput,
  validateBrowserWorkflow,
} from '../browser-workflow.js';

const workflow = {
  schemaVersion: 1 as const,
  id: 'workflow-1',
  name: 'Sign in',
  createdAt: 1,
  updatedAt: 2,
  actions: [
    { id: 'a1', kind: 'navigate' as const, url: 'https://example.test/' },
    { id: 'a2', kind: 'click' as const, locator: { kind: 'test_id' as const, value: 'submit' } },
    {
      id: 'a3',
      kind: 'type' as const,
      locator: { kind: 'name' as const, value: 'password' },
      sensitive: true,
      submit: true,
    },
  ],
};

describe('browser workflow contract', () => {
  test('accepts stable actions and validates the complete workflow', () => {
    assert.equal(isBrowserWorkflow(workflow), true);
    assert.deepEqual(validateBrowserWorkflow(workflow), workflow);
  });

  test('accepts explicit checked-state actions and rejects missing states', () => {
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          {
            id: 'check-yearly',
            kind: 'check',
            locator: { kind: 'test_id', value: 'billing-yearly' },
            checked: true,
          },
        ],
      }),
      true,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          {
            id: 'check-yearly',
            kind: 'check',
            locator: { kind: 'test_id', value: 'billing-yearly' },
          },
        ],
      }),
      false,
    );
  });

  test('rejects snapshot refs and invalid sensitive payloads', () => {
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [{ id: 'click', kind: 'click', locator: { kind: 'text', value: '[12]' } }],
      }),
      false,
      'temporary snapshot refs are never accepted as workflow locators',
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          {
            id: 'type',
            kind: 'type',
            locator: { kind: 'name', value: 'password' },
            sensitive: true,
            value: 'raw-secret',
            submit: false,
          },
        ],
      }),
      false,
    );
    assert.throws(() => validateBrowserWorkflow({ ...workflow, actions: [] }));
    assert.equal(BROWSER_WORKFLOW_REDACTED_VALUE, '__MAKA_REDACTED__');
  });

  test('rejects URL credentials, fragments, and secret-bearing query or path parameters', () => {
    for (const url of [
      'https://user:password@example.test/',
      'https://example.test/callback?access_token=secret',
      'https://example.test/callback?code=temporary-authorization-code',
      'https://example.test/callback?state=one-time-secret',
      'https://example.test/#one-time-code',
      'https://example.test/reset/one-time-password-reset-token',
      'https://example.test/magic/opaque-login-token',
      'https://example.test/invitations/accept/opaque-invitation-token',
      'https://example.test/verify/opaque-verification-token',
    ]) {
      assert.equal(isSafeBrowserWorkflowUrl(url), false, url);
      assert.equal(
        isBrowserWorkflow({ ...workflow, actions: [{ id: 'navigate', kind: 'navigate', url }] }),
        false,
        url,
      );
    }
    assert.equal(isSafeBrowserWorkflowUrl('https://example.test/search?q='), true);
  });

  test('requires one bounded observable condition for wait actions', () => {
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [{ id: 'wait', kind: 'wait', selector: '  ', timeoutMs: 10_000 }],
      }),
      false,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [{ id: 'wait', kind: 'wait', text: '', timeoutMs: 10_000 }],
      }),
      false,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          {
            id: 'wait',
            kind: 'wait',
            selector: '[data-testid="ready"]',
            text: 'Ready',
            timeoutMs: 10_000,
          },
        ],
      }),
      false,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          { id: 'wait', kind: 'wait', selector: '[data-testid="ready"]', timeoutMs: 10_000 },
        ],
      }),
      true,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          { id: 'wait', kind: 'wait', url: 'https://example.test/complete', timeoutMs: 10_000 },
        ],
      }),
      true,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [{ id: 'wait', kind: 'wait', navigation: true, timeoutMs: 10_000 }],
      }),
      true,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          {
            id: 'wait',
            kind: 'wait',
            navigation: true,
            url: 'https://example.test/complete',
            timeoutMs: 10_000,
          },
        ],
      }),
      false,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          {
            id: 'wait',
            kind: 'wait',
            selector: '[data-testid="ready"]',
            url: 'https://example.test/complete',
            timeoutMs: 10_000,
          },
        ],
      }),
      false,
    );
  });

  test('detects sensitive browser fields without inspecting their value', () => {
    const detect = isSensitiveBrowserInput as (input: Record<string, string>) => boolean;
    assert.equal(isSensitiveBrowserInput({ type: 'password' }), true);
    assert.equal(isSensitiveBrowserInput({ autocomplete: 'one-time-code' }), true);
    assert.equal(isSensitiveBrowserInput({ autocomplete: 'cc-number' }), true);
    assert.equal(detect({ placeholder: 'Enter your API key' }), true);
    assert.equal(detect({ name: 'security-pin' }), true);
    assert.equal(detect({ testId: 'auth-token-input' }), true);
    assert.equal(detect({ labelText: 'Client secret' }), true);
    assert.equal(isSensitiveBrowserInput({ name: 'email' }), false);
    assert.equal(isSensitiveBrowserInput({ ariaLabel: 'Search' }), false);
  });
});
