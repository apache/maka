import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { promoteWhatsAppAuthState } from '../whatsapp-auth.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('WhatsApp auth state promotion', () => {
  test('replaces an existing session only when staged credentials are promoted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-whatsapp-auth-'));
    tempRoots.push(root);
    const active = join(root, 'default');
    const staging = join(root, '.default.pairing-test');
    await mkdir(active);
    await mkdir(staging);
    await writeFile(join(active, 'creds.json'), 'old-session');
    await writeFile(join(staging, 'creds.json'), 'new-session');

    assert.equal(await readFile(join(active, 'creds.json'), 'utf8'), 'old-session');
    await promoteWhatsAppAuthState(staging, active);
    assert.equal(await readFile(join(active, 'creds.json'), 'utf8'), 'new-session');
    await assert.rejects(access(staging));
  });

  test('installs the first linked session when no active directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-whatsapp-auth-'));
    tempRoots.push(root);
    const active = join(root, 'default');
    const staging = join(root, '.default.pairing-test');
    await mkdir(staging);
    await writeFile(join(staging, 'creds.json'), 'first-session');

    await promoteWhatsAppAuthState(staging, active);
    assert.equal(await readFile(join(active, 'creds.json'), 'utf8'), 'first-session');
  });
});
