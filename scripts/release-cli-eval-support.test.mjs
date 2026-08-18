import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  createTaskFixture,
  findEvalReleaseTarball,
  isolatedEnvironment,
  readFrameworkOutputs,
} from './release-cli-eval-support.mjs';

describe('installed Eval release validation support', () => {
  test('reports the unsupported platform before inspecting release artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'maka-eval-support-platform-'));
    try {
      assert.throws(
        () => findEvalReleaseTarball(join(root, 'missing-release'), 'win32', 'x64'),
        /requires Linux x64/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('creates the Git fixture without inheriting host Git configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'maka-eval-support-git-'));
    const globalConfig = join(root, 'host.gitconfig');
    writeFileSync(globalConfig, '[commit]\n\tgpgSign = true\n', 'utf8');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const environment = isolatedEnvironment(join(root, 'home'));
      assert.equal(environment.GIT_CONFIG_GLOBAL, undefined);
      const fixture = createTaskFixture(
        join(root, 'fixture'),
        environment,
        'python:3.12-slim@sha256:test',
      );
      assert.match(fixture.commit, /^[0-9a-f]{40}$/u);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves the primary process failure when diagnostics are truncated', () => {
    const root = mkdtempSync(join(tmpdir(), 'maka-eval-support-failure-'));
    const trialsRoot = join(root, 'trials');
    mkdirSync(join(trialsRoot, 'trial'), { recursive: true });
    writeFileSync(join(trialsRoot, 'trial/preparation-error.json'), '{"broken":', 'utf8');
    try {
      assert.throws(
        () =>
          readFrameworkOutputs({
            framework: 'pier',
            invocation: { status: 1, stdout: '', stderr: 'primary framework failure' },
            outputRoot: join(root, 'output'),
            trialsRoot,
          }),
        (error) => {
          assert.match(error.message, /pier exited with status 1/u);
          assert.match(error.message, /primary framework failure/u);
          assert.match(error.message, /parseError/u);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves the primary process failure when diagnostics cannot be read', {
    skip: process.platform === 'win32',
  }, () => {
    const root = mkdtempSync(join(tmpdir(), 'maka-eval-support-unreadable-'));
    const trialsRoot = join(root, 'trials');
    mkdirSync(join(trialsRoot, 'trial'), { recursive: true });
    symlinkSync('missing-trial.log', join(trialsRoot, 'trial/trial.log'));
    try {
      assert.throws(
        () =>
          readFrameworkOutputs({
            framework: 'harbor',
            invocation: { status: 1, stdout: '', stderr: 'primary framework failure' },
            outputRoot: join(root, 'output'),
            trialsRoot,
          }),
        (error) => {
          assert.match(error.message, /harbor exited with status 1/u);
          assert.match(error.message, /primary framework failure/u);
          assert.match(error.message, /diagnosticError.*ENOENT/u);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports malformed successful output with the attempt evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'maka-eval-support-output-'));
    const attemptsRoot = join(root, 'output/attempts/cell');
    mkdirSync(attemptsRoot, { recursive: true });
    writeFileSync(
      join(attemptsRoot, '000001.json'),
      JSON.stringify({ cellId: 'task::1::subject', sequence: 1, result: {} }),
      'utf8',
    );
    try {
      assert.throws(
        () =>
          readFrameworkOutputs({
            framework: 'harbor',
            invocation: { status: 0, stdout: 'not-json', stderr: '' },
            outputRoot: join(root, 'output'),
            trialsRoot: join(root, 'trials'),
          }),
        (error) => {
          assert.match(error.message, /harbor produced invalid summary JSON/u);
          assert.match(error.message, /parseError/u);
          assert.match(error.message, /000001\.json/u);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
