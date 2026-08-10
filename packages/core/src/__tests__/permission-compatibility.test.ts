import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  categorizeBash,
  classifyToolUse,
  isToolCategory,
  permissionReasonForCategory,
} from '../permission.js';

describe('legacy permission payload classification', () => {
  test('keeps historical command reviews conservatively categorized', () => {
    expect(categorizeBash('ls -la')).toBe('shell_unsafe');
    expect(categorizeBash('rm -rf /tmp/example')).toBe('fs_destructive');
    expect(categorizeBash('git reset --hard')).toBe('git_destructive');
    expect(categorizeBash('sudo true')).toBe('privileged');
  });

  test('keeps plan-mode tool availability classification independent of authorization', () => {
    expect(classifyToolUse({ toolName: 'Read', args: {} })).toBe('read');
    expect(classifyToolUse({ toolName: 'Write', args: {} })).toBe('file_write');
    expect(classifyToolUse({ toolName: 'apply_patch', args: {} })).toBe('file_write');
    expect(classifyToolUse({ toolName: 'ExploreAgent', args: {}, categoryHint: 'subagent' })).toBe(
      'subagent',
    );
  });

  test('keeps Client Capabilities behind a conservative permission floor', () => {
    expect(isToolCategory('client_capability')).toBe(true);
    expect(permissionReasonForCategory('client_capability')).toBe('custom');
  });
});
