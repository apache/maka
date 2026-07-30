import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderSwarmModePrompt } from '../swarm-mode.js';

describe('Swarm Mode shared prompt', () => {
  test('makes swarm the preferred default while preserving agent judgment', () => {
    const prompt = renderSwarmModePrompt();
    assert.match(prompt, /<orchestration_mode>/);
    assert.match(prompt, /preferred default execution strategy/);
    assert.match(prompt, /decide whether parallel delegation would materially improve/);
    assert.match(prompt, /at least two meaningful independent items/);
    assert.match(prompt, /You may continue directly/);
    assert.match(prompt, /only tool in its assistant step/);
    assert.match(prompt, /whole batch to settle/);
    assert.match(prompt, /semantically synthesize/);
    assert.match(prompt, /Do not manufacture parallelism/);
    assert.doesNotMatch(prompt, /routing is mandatory/);
  });
});
