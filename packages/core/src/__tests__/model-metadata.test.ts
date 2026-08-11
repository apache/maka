import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  lookupModelMetadata,
  openAiAdapterApiProtocol,
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

describe('openAiAdapterApiProtocol', () => {
  it('routes a normalized gpt-5 family to the Responses wire', () => {
    assert.equal(openAiAdapterApiProtocol(' GPT-5.6-sol '), 'openai-responses');
  });

  it('keeps a non-gpt-5 OpenAI model on the Chat Completions wire', () => {
    assert.equal(openAiAdapterApiProtocol('gpt-4o'), 'openai-chat');
  });

  it('routes only xAI Grok 4.5 through Responses', () => {
    assert.equal(openAiAdapterApiProtocol('grok-4.5', 'xai'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('grok-4.5', 'xai-oauth'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('grok-4.3', 'xai'), 'openai-chat');
    assert.equal(openAiAdapterApiProtocol('grok-4.5', 'openai'), 'openai-chat');
  });

  it('routes only DeepSeek V4 Flash through the provider Responses wire', () => {
    assert.equal(openAiAdapterApiProtocol('deepseek-v4-flash', 'deepseek'), 'openai-responses');
    assert.equal(openAiAdapterApiProtocol('deepseek-v4-pro', 'deepseek'), 'openai-chat');
  });
});
