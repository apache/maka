import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  lookupModelMetadata,
  openAiAdapterApiProtocol,
  resolveModelInputModalities,
  resolveModelPdfSupport,
  resolveModelVisionSupport,
} from '../model-metadata.js';
import type { ModelInfo, ProviderType } from '../llm-connections.js';

describe('model-metadata vision capability', () => {
  it('treats a Claude newer than the generated snapshot as able to read images', () => {
    // The generated table is a snapshot of models.dev, so a Claude released
    // after it is absent from the table rather than listed as text-only.
    // Resolving absent to "no vision" silently drops the user's attachment and
    // turns an image tool result into a sentence about the model.
    assert.deepEqual(lookupModelMetadata('anthropic', 'claude-opus-6'), {});
    assert.equal(resolveModelVisionSupport('anthropic', undefined, 'claude-opus-6'), true);
    assert.equal(resolveModelVisionSupport('anthropic', undefined, 'claude-fable-1'), true);
  });

  it('still fails closed for the Claude generation that cannot read images', () => {
    // claude-2.x and claude-instant carry no family segment, so widening the
    // default to the pre-4 id shape must not reach them.
    for (const id of ['claude-2.1', 'claude-2.0', 'claude-instant-1.2']) {
      assert.equal(resolveModelVisionSupport('anthropic', undefined, id), false, id);
    }
  });

  it('confines the default to the providers that serve Anthropic their own models', () => {
    // A claude-prefixed id on somebody else's provider says nothing about what
    // is actually behind it, so the default must not travel with the id.
    for (const providerType of [
      'openrouter',
      'anthropic-compatible',
      'kimi-coding-plan',
    ] satisfies ProviderType[]) {
      assert.equal(
        resolveModelVisionSupport(providerType, undefined, 'claude-opus-6'),
        false,
        providerType,
      );
    }
    assert.equal(resolveModelVisionSupport('openai', undefined, 'some-unlisted-model'), false);
  });

  it('yields to what a connection reports, in both directions', () => {
    const denied: ModelInfo[] = [{ id: 'claude-opus-6', capabilities: { vision: false } }];
    assert.equal(resolveModelVisionSupport('anthropic', denied, 'claude-opus-6'), false);
    const granted: ModelInfo[] = [{ id: 'some-unlisted-model', capabilities: { vision: true } }];
    assert.equal(resolveModelVisionSupport('openai', granted, 'some-unlisted-model'), true);
  });

  it('lets a user declaration outrank every other signal, in both directions', () => {
    // Declared vision wins over stored capabilities, generated metadata, and
    // the provider default — the relay user knows what the backing model is,
    // none of the inferred sources can.
    const stored: ModelInfo[] = [
      { id: 'my-reasoner', capabilities: { vision: true } },
      { id: 'claude-opus-6', capabilities: { vision: true } },
    ];
    assert.equal(
      resolveModelVisionSupport('openai-compatible', stored, 'my-reasoner', false),
      false,
    );
    assert.equal(
      resolveModelVisionSupport('openai-compatible', stored, 'claude-opus-6', false),
      false,
    );
    assert.equal(
      resolveModelVisionSupport('openai-compatible', undefined, 'some-unlisted-model', true),
      true,
    );
    // anthropic defaults claude-* to vision; an explicit declaration still wins.
    assert.equal(resolveModelVisionSupport('anthropic', undefined, 'claude-opus-6', false), false);
    // undefined declaration means "no opinion": the old chain decides.
    assert.equal(
      resolveModelVisionSupport('openai-compatible', stored, 'my-reasoner', undefined),
      true,
    );
    assert.equal(
      resolveModelVisionSupport('openai-compatible', undefined, 'some-unlisted-model', undefined),
      false,
    );
  });

});

describe('resolveModelVisionSupport', () => {
  it('falls back to in-repo metadata when stored models are bare ids (post-fetch)', () => {
    assert.equal(
      resolveModelVisionSupport(
        'anthropic',
        [{ id: 'claude-sonnet-4-5-20250929' }],
        'claude-sonnet-4-5-20250929',
      ),
      true,
    );
    assert.equal(
      resolveModelVisionSupport(
        'claude-subscription',
        [{ id: 'claude-sonnet-4-6' }],
        'claude-sonnet-4-6',
      ),
      true,
    );
    assert.equal(
      resolveModelVisionSupport('deepseek', [{ id: 'deepseek-chat' }], 'deepseek-chat'),
      false,
    );
    assert.equal(resolveModelVisionSupport('moonshot', [{ id: 'kimi-k2.6' }], 'kimi-k2.6'), true);
    assert.equal(
      resolveModelVisionSupport('kimi-coding-plan', [{ id: 'kimi-for-coding' }], 'kimi-for-coding'),
      true,
    );
  });
});

describe('models.dev extended model facts', () => {
  it('keeps PDF input in the generated modality facts', () => {
    const metadata = lookupModelMetadata('anthropic', 'claude-sonnet-4-5');
    assert.equal(metadata.modalities?.input.includes('pdf'), true);
    assert.equal(resolveModelPdfSupport('anthropic', undefined, 'claude-sonnet-4-5'), true);
    assert.equal(
      resolveModelInputModalities('anthropic', undefined, 'claude-sonnet-4-5').includes('pdf'),
      true,
    );
  });
});

describe('openAiAdapterApiProtocol', () => {
  it('routes every gpt-5* family to the Responses wire', () => {
    for (const modelId of [
      'gpt-5',
      'gpt-5-codex',
      'gpt-5.5',
      'gpt-5.6-sol',
      'GPT-5',
      ' gpt-5.4 ',
    ]) {
      assert.equal(openAiAdapterApiProtocol(modelId), 'openai-responses', modelId);
    }
  });

  it('keeps every other OpenAI-adapter model on the Chat Completions wire', () => {
    for (const modelId of ['gpt-4o', 'gpt-4.1', 'o3', 'o4-mini', 'chatgpt-4o-latest']) {
      assert.equal(openAiAdapterApiProtocol(modelId), 'openai-chat', modelId);
    }
  });

  it('routes only xAI Grok 4.5 through Responses', () => {
    assert.equal(openAiAdapterApiProtocol('grok-4.5', 'xai'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('grok-4.5', 'xai-oauth'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('grok-4.3', 'xai'), 'openai-chat');
    assert.equal(openAiAdapterApiProtocol('grok-4.3', 'xai-oauth'), 'openai-chat');
    assert.equal(openAiAdapterApiProtocol('grok-4.5', 'openai'), 'openai-chat');
  });

  it('routes only DeepSeek V4 Flash through the provider Responses wire', () => {
    assert.equal(openAiAdapterApiProtocol('deepseek-v4-flash', 'deepseek'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('deepseek-v4-pro', 'deepseek'), 'openai-chat');
    assert.equal(openAiAdapterApiProtocol('deepseek-chat', 'deepseek'), 'openai-chat');
  });
});
