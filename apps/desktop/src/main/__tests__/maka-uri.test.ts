import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
} from '@maka/ui/maka-uri';

describe('Maka URI safety boundary', () => {
  it('parses only supported settings and compose destinations', () => {
    assert.deepEqual(parseMakaUri('maka://settings/general'), {
      kind: 'settings',
      section: 'general',
    });
    assert.deepEqual(parseMakaUri('maka://compose?text=hello'), {
      kind: 'compose',
      text: 'hello',
    });
    assert.deepEqual(parseMakaUri('maka://compose/?text=%E4%BD%A0%E5%A5%BD'), {
      kind: 'compose',
      text: '你好',
    });
  });

  it('rejects malformed, case-variant, and oversized internal URIs', () => {
    const invalidInputs: unknown[] = [
      '',
      null,
      'https://example.com/',
      'Maka://settings/account',
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
      'maka://settings/account/edit',
      'maka://settings/account?force=1',
      'maka://settings/account#section',
      'maka://SETTINGS/account',
      'maka://compose?text=',
      'maka://compose?other=value',
      'maka://compose/run?text=hi',
      'maka://tool/Bash?cmd=ls',
      'maka:///account',
      'maka://user@settings/account',
      'maka://settings:9999/account',
    ];
    for (const href of invalidHrefs) assert.equal(parseMakaUri(href), null, href);
  });

  it('flags case-variant internal candidates without allowing navigation', () => {
    for (const href of [
      'maka://settings/account',
      'Maka://settings/account',
    ]) {
      assert.equal(isMakaUriCandidate(href), true, href);
      if (!href.startsWith('maka:')) assert.equal(parseMakaUri(href), null, href);
    }
    for (const input of [
      'https://example.com/',
      'makafake://oops',
      null,
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
      'not a url',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'maka://settings/account',
      'ftp://host',
    ];
    for (const href of rejected) {
      assert.equal(isSafeExternalScheme(href as string), false, String(href));
    }
  });
});
