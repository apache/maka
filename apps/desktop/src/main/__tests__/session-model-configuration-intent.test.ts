/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  equalSessionModelConfigurationIntent,
  modelConfigurationIntentForModel,
  modelConfigurationIntentForThinking,
} from '../../renderer/features/session-settings/testing.js';

const modelA = {
  llmConnectionId: 'openai-id',
  llmConnectionSlug: 'openai-main',
  model: 'model-a',
};
const modelB = {
  llmConnectionId: 'anthropic-id',
  llmConnectionSlug: 'anthropic-main',
  model: 'model-b',
};

test('a model selection resets thinking to the new model default', () => {
  assert.deepEqual(modelConfigurationIntentForModel(modelB), {
    modelTarget: modelB,
    thinkingLevel: null,
    changedSetting: 'model',
  });
});

test('a thinking selection retains the pending cross-connection model target', () => {
  const pendingModel = modelConfigurationIntentForModel(modelB);

  assert.deepEqual(modelConfigurationIntentForThinking(modelA, pendingModel, 'high'), {
    modelTarget: modelB,
    thinkingLevel: 'high',
    changedSetting: 'thinking',
  });
});

test('configuration equality ignores which control produced the same Host payload', () => {
  assert.equal(
    equalSessionModelConfigurationIntent(
      { modelTarget: modelB, thinkingLevel: null, changedSetting: 'model' },
      { modelTarget: modelB, thinkingLevel: null, changedSetting: 'thinking' },
    ),
    true,
  );
});
