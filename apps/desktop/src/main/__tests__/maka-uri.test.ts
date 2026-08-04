import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SETTINGS_SECTIONS } from '@maka/core';
import {
  isMakaUri,
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
} from '@maka/ui/maka-uri';

describe('Maka URI safety boundary', () => {
  it('parses only supported settings and compose destinations', () => {
    for (const section of SETTINGS_SECTIONS) {
      assert.deepEqual(parseMakaUri(`maka://settings/${section}`), {
        kind: 'settings',
        section,
      });
    }

    const composeCases = [
      ['maka://compose?text=hello', 'hello'],
      ['maka://compose?text=%E4%BD%A0%E5%A5%BD', '你好'],
      ['maka://compose/?text=Hello%20world%21', 'Hello world!'],
    ] as const;
    for (const [href, text] of composeCases) {
      assert.deepEqual(parseMakaUri(href), { kind: 'compose', text });
    }
  });

  it('rejects malformed, case-variant, and oversized internal URIs', () => {
    const invalidInputs: unknown[] = [
      '',
      null,
      undefined,
      42,
      'https://example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'Maka://settings/account',
      'MAKA://settings/account',
      'maka://',
      'maka:settings/account',
      `maka://compose?text=${'x'.repeat(8192)}`,
    ];
    for (const input of invalidInputs) {
      assert.equal(parseMakaUri(input as string), null, String(input));
    }
  });

  it('rejects widened settings, compose, and action namespaces', () => {
    const invalidHrefs = [
      'maka://settings/zzz',
      'maka://settings/',
      'maka://settings',
      'maka://settings/account/edit',
      'maka://settings/account?force=1',
      'maka://settings/account#section',
      'maka://SETTINGS/account',
      'maka://compose?text=',
      'maka://compose?other=value',
      `maka://compose?text=${'a'.repeat(5000)}`,
      'maka://compose/run?text=hi',
      'maka://tool/Bash?cmd=ls',
      'maka://auth/oauth?provider=claude',
      'maka://exec/shell',
      'maka://run/skill',
      'maka://mcp/connect',
      'maka://session/abc-123',
      'maka://runtime/background-tasks/shell-run-1',
      'maka:///account',
      'maka://user@settings/account',
      'maka://settings:9999/account',
    ];
    for (const href of invalidHrefs) assert.equal(parseMakaUri(href), null, href);
  });

  it('recognizes only the exact internal scheme', () => {
    for (const href of ['maka://settings/account', 'maka://tool/run', 'maka:']) {
      assert.equal(isMakaUri(href), true, href);
    }
    for (const input of [
      'https://example.com/',
      'Maka://settings/account',
      '   maka://settings/account',
      null,
      undefined,
    ]) {
      assert.equal(isMakaUri(input as string), false, String(input));
    }
  });

  it('flags case-variant internal candidates without allowing navigation', () => {
    for (const href of [
      'maka://settings/account',
      'Maka://settings/account',
      'MAKA://compose?text=hi',
      'MaKa://settings/health',
    ]) {
      assert.equal(isMakaUriCandidate(href), true, href);
      if (!href.startsWith('maka:')) assert.equal(parseMakaUri(href), null, href);
    }
    for (const input of [
      'https://example.com/',
      'javascript:alert(1)',
      'makafake://oops',
      null,
      undefined,
      42,
    ]) {
      assert.equal(isMakaUriCandidate(input as string), false, String(input));
    }
  });

  it('allows only explicit external schemes', () => {
    for (const href of [
      'http://example.com',
      'https://example.com/path?q=1',
      'mailto:user@example.com',
    ]) {
      assert.equal(isSafeExternalScheme(href), true, href);
    }

    const rejected: unknown[] = [
      '',
      null,
      undefined,
      42,
      'not a url',
      '://no-scheme',
      'user@example.com',
      'mailto-info:contact',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox("x")',
      'maka://settings/account',
      'Maka://settings/account',
      'ms-excel://something',
      'telnet://host',
      'ftp://host',
    ];
    for (const href of rejected) {
      assert.equal(isSafeExternalScheme(href as string), false, String(href));
    }
  });
});
