import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PROVIDER_REGISTRY,
  type ProviderDefaults,
  type ProviderType,
} from '../provider-registry.js';
import {
  PROVIDER_CONTRACT_DIMENSIONS,
  PROVIDER_CONTRACT_MATRIX_PLAN,
  buildProviderContractMatrixPlan,
  listProviderContractCells,
  type ProviderContractCell,
  type ProviderContractDimension,
} from '../provider-contract-matrix.js';

const plan = PROVIDER_CONTRACT_MATRIX_PLAN;

function rowFor(providerType: ProviderType) {
  const row = plan.rows.find((entry) => entry.providerType === providerType);
  assert.ok(row, `expected a matrix row for ${providerType}`);
  return row;
}

function cellFor(
  providerType: ProviderType,
  dimension: ProviderContractDimension,
): ProviderContractCell {
  return rowFor(providerType).cells[dimension];
}

describe('provider contract matrix — row selection', () => {
  it('includes every ready, wired provider and excludes experimental / unavailable ones', () => {
    const rowTypes = new Set(plan.rows.map((row) => row.providerType));
    for (const [providerType, def] of Object.entries(PROVIDER_REGISTRY) as Array<
      [ProviderType, ProviderDefaults]
    >) {
      const shouldBeRow = def.status === 'ready' && def.runtimeAdapter.kind !== 'unavailable';
      assert.equal(
        rowTypes.has(providerType),
        shouldBeRow,
        `${providerType} row membership should be ${shouldBeRow}`,
      );
    }
  });

  it('keeps github-copilot as a row even though it has no readyOrder', () => {
    // The whole point of not reusing READY_PROVIDER_TYPES: its membership is
    // "has a readyOrder", which drops github-copilot.
    assert.equal(PROVIDER_REGISTRY['github-copilot'].readyOrder, undefined);
    assert.ok(plan.rows.some((row) => row.providerType === 'github-copilot'));
  });

  it('excludes the experimental oauth providers and the unavailable gemini-cli', () => {
    for (const excluded of ['claude-subscription', 'openai-codex', 'gemini-cli'] as const) {
      assert.ok(
        !plan.rows.some((row) => row.providerType === excluded),
        `${excluded} must not be a row`,
      );
    }
  });

  it('exposes the four contract dimensions', () => {
    assert.deepEqual(plan.dimensions, PROVIDER_CONTRACT_DIMENSIONS);
    assert.deepEqual(
      [...PROVIDER_CONTRACT_DIMENSIONS],
      ['discovery', 'exact-model-id', 'tool-loop', 'reasoning-replay'],
    );
  });
});

describe('provider contract matrix — every cell is exactly one of three states', () => {
  it('assigns a known state with the state-specific payload to every cell', () => {
    for (const { providerType, dimension, cell } of listProviderContractCells(plan)) {
      const where = `${providerType}/${dimension}`;
      switch (cell.state) {
        case 'generated':
          if (dimension === 'discovery') {
            assert.ok(cell.discovery, `${where} generated discovery must carry a discovery plan`);
          } else {
            assert.ok(cell.wire, `${where} generated wire cell must carry a wire`);
          }
          break;
        case 'override':
          assert.equal(cell.overrideKey, `${providerType}:${dimension}`, `${where} override key`);
          assert.ok(cell.contract.length > 0, `${where} override must state its contract`);
          break;
        case 'not-applicable':
          assert.ok(cell.reason.length > 0, `${where} not-applicable must carry a reason`);
          break;
        default:
          assert.fail(`${where} has an unknown cell state`);
      }
    }
  });
});

describe('provider contract matrix — discovery derivation', () => {
  it('marks protocol discovery generated and carries the derived request shape', () => {
    const siliconflow = cellFor('siliconflow', 'discovery');
    assert.equal(siliconflow.state, 'generated');
    assert.equal(siliconflow.state === 'generated' && siliconflow.discovery?.protocol, 'openai');
    assert.deepEqual(siliconflow.state === 'generated' ? siliconflow.discovery?.query : undefined, {
      sub_type: 'chat',
    });

    const vercel = cellFor('vercel', 'discovery');
    assert.equal(vercel.state, 'generated');
    assert.equal(vercel.state === 'generated' && vercel.discovery?.auth, 'none');
    assert.equal(vercel.state === 'generated' && vercel.discovery?.filter, 'language-models');
  });

  it('derives auth none when the provider has no credential to send', () => {
    const lmStudio = cellFor('lm-studio', 'discovery');
    assert.equal(lmStudio.state, 'generated');
    assert.equal(lmStudio.state === 'generated' && lmStudio.discovery?.auth, 'none');
  });

  it('derives auth optional when the provider credential is user-optional', () => {
    const localai = cellFor('localai', 'discovery');
    assert.equal(localai.state, 'generated');
    assert.equal(localai.state === 'generated' && localai.discovery?.auth, 'optional');
  });

  it('marks fireworks / cohere / ollama discovery as override', () => {
    for (const providerType of ['fireworks-ai', 'cohere', 'ollama'] as const) {
      const cell = cellFor(providerType, 'discovery');
      assert.equal(cell.state, 'override', `${providerType} discovery should be override`);
    }
  });

  it('marks github-copilot discovery as override (special subscription models wire)', () => {
    assert.equal(cellFor('github-copilot', 'discovery').state, 'override');
  });

  it('marks fallback discovery not-applicable with a no-/models reverse assertion', () => {
    for (const providerType of [
      'volcengine-ark',
      'tencent-coding-plan',
      'cloudflare-workers-ai',
    ] as const) {
      const cell = cellFor(providerType, 'discovery');
      assert.equal(cell.state, 'not-applicable', `${providerType} discovery should be N/A`);
      assert.equal(
        cell.state === 'not-applicable' ? cell.reverseAssertion : undefined,
        'must-not-request-models-endpoint',
      );
    }
  });
});

describe('provider contract matrix — wire and reasoning derivation', () => {
  it('generates wire cells for non-subscription adapters against the protocol wire', () => {
    assert.deepEqual(
      [cellFor('openai', 'tool-loop').state, cellFor('openai', 'exact-model-id').state],
      ['generated', 'generated'],
    );
    const anthropicLoop = cellFor('anthropic', 'tool-loop');
    assert.equal(anthropicLoop.state === 'generated' && anthropicLoop.wire, 'anthropic-messages');
    const googleLoop = cellFor('google', 'tool-loop');
    assert.equal(googleLoop.state === 'generated' && googleLoop.wire, 'google-generate');
    const cohereLoop = cellFor('cohere', 'tool-loop');
    assert.equal(cohereLoop.state === 'generated' && cohereLoop.wire, 'cohere-v2');
  });

  it('marks github-copilot wire dimensions as override', () => {
    for (const dimension of ['exact-model-id', 'tool-loop', 'reasoning-replay'] as const) {
      assert.equal(cellFor('github-copilot', dimension).state, 'override', `copilot ${dimension}`);
    }
  });

  it('generates a plain reasoning_content round-trip for plain openai-compatible providers', () => {
    const cell = cellFor('volcengine-ark', 'reasoning-replay');
    assert.equal(cell.state, 'generated');
    assert.deepEqual(cell.state === 'generated' ? cell.reasoningReplay : undefined, {
      sourceField: 'reasoning_content',
      replayField: 'reasoning_content',
    });
  });

  it('keeps xAI Chat reasoning replay generated when Grok 4.5 uses Responses', () => {
    for (const providerType of ['xai', 'xai-oauth'] as const) {
      const cell = cellFor(providerType, 'reasoning-replay');
      assert.equal(cell.state, 'generated');
      assert.deepEqual(cell.state === 'generated' ? cell.reasoningReplay : undefined, {
        sourceField: 'reasoning_content',
        replayField: 'reasoning_content',
      });
    }
  });

  it('generates a reasoning field rename when the adapter declares replayAssistantReasoningAs', () => {
    const cell = cellFor('ollama-cloud', 'reasoning-replay');
    assert.equal(cell.state, 'generated');
    assert.equal(
      cell.state === 'generated' ? cell.reasoningReplay?.replayField : undefined,
      'reasoning',
    );
  });

  it('marks zenmux signed reasoning_details replay as override', () => {
    assert.equal(cellFor('zenmux', 'reasoning-replay').state, 'override');
  });

  it('marks native-SDK adapters not-applicable for reasoning replay', () => {
    for (const providerType of ['anthropic', 'openai', 'google', 'cohere'] as const) {
      assert.equal(
        cellFor(providerType, 'reasoning-replay').state,
        'not-applicable',
        `${providerType} reasoning-replay should be N/A`,
      );
    }
  });
});

describe('provider contract matrix — sample model id derivation', () => {
  it('uses the provider first fallback model when present', () => {
    assert.equal(rowFor('anthropic').sampleModelId, PROVIDER_REGISTRY.anthropic.fallbackModels[0]);
  });

  it('never routes the OpenAI adapter sample id to the Responses wire', () => {
    assert.ok(!/^gpt-5/i.test(rowFor('openai').sampleModelId));
  });

  it('falls back to a synthetic id when the provider ships no fallback snapshot', () => {
    // openai-compatible custom and lm-studio have empty fallback snapshots.
    assert.equal(rowFor('lm-studio').sampleModelId, 'conformance-sample-model');
    assert.equal(rowFor('openai-compatible').sampleModelId, 'conformance-sample-model');
  });

  it('derives the declared edge wire samples with per-id wire resolution', () => {
    assert.deepEqual(rowFor('opencode-go').edgeWireSamples, [
      { modelId: 'kimi-k2.7-code', wire: 'openai-chat' },
    ]);
    assert.deepEqual(rowFor('localai').edgeWireSamples, [
      { modelId: 'localai/Qwen3-8B-Instruct-GGUF:Q4_K_M', wire: 'openai-chat' },
    ]);
    assert.deepEqual(rowFor('lm-studio').edgeWireSamples, [
      { modelId: 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF', wire: 'openai-chat' },
    ]);
    assert.deepEqual(rowFor('minimax-coding-plan').edgeWireSamples, [
      { modelId: 'MiniMax-M2.7-highspeed', wire: 'anthropic-messages' },
    ]);
    assert.deepEqual(rowFor('tencent-tokenhub').edgeWireSamples, [
      { modelId: 'hy3-preview', wire: 'openai-chat' },
    ]);
    assert.deepEqual(rowFor('openai').edgeWireSamples, []);
  });
});

describe('provider contract matrix — derivation is a total function over a fixture registry', () => {
  it('classifies a minimal ready openai-compatible fixture without touching the live registry', () => {
    const fixture: Record<string, ProviderDefaults> = {
      'fixture-provider': {
        label: 'Fixture',
        description: 'test',
        baseUrl: 'https://example.test/v1',
        authKind: 'api_key',
        backendKind: 'ai-sdk',
        fallbackModels: ['fixture-model'],
        status: 'ready',
        protocol: 'openai',
        runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
        modelDiscovery: { kind: 'protocol' },
        category: 'overseas',
      },
      'fixture-experimental': {
        label: 'Fixture Experimental',
        description: 'test',
        baseUrl: '',
        authKind: 'oauth_token',
        backendKind: 'ai-sdk',
        fallbackModels: [],
        status: 'phase3-experimental',
        protocol: 'openai',
        runtimeAdapter: { kind: 'unavailable' },
        modelDiscovery: { kind: 'fallback' },
        category: 'oauth',
      },
    };
    const fixturePlan = buildProviderContractMatrixPlan(fixture);
    assert.deepEqual(
      fixturePlan.rows.map((row) => row.providerType),
      ['fixture-provider'],
    );
    const row = fixturePlan.rows[0]!;
    assert.equal(row.sampleModelId, 'fixture-model');
    assert.equal(row.cells.discovery.state, 'generated');
    assert.equal(row.cells['tool-loop'].state, 'generated');
    assert.equal(row.cells['reasoning-replay'].state, 'generated');
  });
});
