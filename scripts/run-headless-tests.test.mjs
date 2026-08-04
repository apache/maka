import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { runHeadlessTests } from './run-headless-tests.mjs';

test('runHeadlessTests isolates user state and removes its temporary files', () => {
  const cwd = resolve('packages/headless');
  let credentialsPath;
  let globalConfigPath;

  const status = runHeadlessTests({
    cwd,
    env: {
      PATH: '/test/bin',
      LANG: 'en_US.UTF-8',
      CI: 'true',
      NORMAL_VALUE: 'kept',
      TOKENIZER_PATH: '/host/tokenizer',
      HOME: '/host/home',
      USERPROFILE: '/host/profile',
      XDG_CONFIG_HOME: '/host/config',
      XDG_DATA_HOME: '/host/data',
      XDG_STATE_HOME: '/host/state',
      XDG_CACHE_HOME: '/host/cache',
      APPDATA: '/host/appdata',
      TMPDIR: '/host/tmp',
      TMP: '/host/tmp',
      TEMP: '/host/tmp',
      GIT_CONFIG_GLOBAL: '/host/gitconfig',
      GIT_CONFIG_NOSYSTEM: '0',
      GROQ_API_KEY: 'secret',
      huggingface_token: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      SSH_PRIVATE_KEY_FILE: '/host/private-key',
      MAKA_CREDENTIALS_PATH: '/host/credentials.json',
      HTTP_PROXY: 'http://host-proxy',
      https_proxy: 'http://host-proxy',
      All_Proxy: 'http://host-proxy',
      no_proxy: 'localhost',
    },
    spawnSync(command, args, options) {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['--test', 'dist/**/*.test.js']);
      assert.equal(options.cwd, cwd);
      assert.equal(options.stdio, 'inherit');
      assert.equal(options.env.PATH, '/test/bin');
      assert.equal(options.env.LANG, 'en_US.UTF-8');
      assert.equal(options.env.CI, 'true');
      assert.equal(options.env.NORMAL_VALUE, 'kept');
      assert.equal(options.env.TOKENIZER_PATH, '/host/tokenizer');
      for (const name of [
        'GROQ_API_KEY',
        'huggingface_token',
        'AWS_SECRET_ACCESS_KEY',
        'SSH_PRIVATE_KEY_FILE',
        'HTTP_PROXY',
        'https_proxy',
        'All_Proxy',
        'no_proxy',
      ]) {
        assert.equal(options.env[name], undefined);
      }

      const tempDir = options.env.HOME;
      assert.equal(options.env.USERPROFILE, tempDir);
      for (const name of [
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'APPDATA',
        'MAKA_CREDENTIALS_PATH',
        'GIT_CONFIG_GLOBAL',
        'TMPDIR',
        'TMP',
        'TEMP',
      ]) {
        assert.equal(relative(tempDir, options.env[name]).startsWith('..'), false);
      }
      // mkdtemp() against os.tmpdir() fails unless the directory already exists,
      // so this one cannot be left for the code under test to create.
      assert.equal(statSync(options.env.TMPDIR).isDirectory(), true);
      assert.equal(options.env.TMP, options.env.TMPDIR);
      assert.equal(options.env.TEMP, options.env.TMPDIR);

      credentialsPath = options.env.MAKA_CREDENTIALS_PATH;
      assert.equal(readFileSync(credentialsPath, 'utf8'), '{"version":1,"values":{}}\n');
      if (process.platform !== 'win32') {
        assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
      }
      assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
      globalConfigPath = options.env.GIT_CONFIG_GLOBAL;
      assert.equal(readFileSync(globalConfigPath, 'utf8'), '');
      return { error: undefined, signal: null, status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(existsSync(dirname(credentialsPath)), false);
  assert.equal(existsSync(credentialsPath), false);
  assert.equal(existsSync(globalConfigPath), false);
});
