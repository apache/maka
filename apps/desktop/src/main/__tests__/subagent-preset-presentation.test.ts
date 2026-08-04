import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection, SubagentPreset } from '@maka/core';
import {
  nextSubagentDraftForName,
  resolveSubagentRoute,
  subagentPresetAvailability,
  suggestSubagentPresetId,
} from '../../renderer/settings/subagent-preset-presentation.js';

function connection(input: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'deepseek',
    name: 'DeepSeek',
    providerType: 'deepseek',
    defaultModel: 'deepseek-chat',
    enabled: true,
    enabledModelIds: ['deepseek-chat'],
    createdAt: 0,
    updatedAt: 0,
    ...input,
  };
}

function preset(input: Partial<SubagentPreset> = {}): SubagentPreset {
  return {
    id: 'fast-reader',
    name: 'Fast reader',
    description: 'Read large repositories quickly',
    profile: 'local_read',
    connectionSlug: 'deepseek',
    model: 'deepseek-chat',
    enabled: true,
    ...input,
  };
}

describe('subagentPresetAvailability', () => {
  it('distinguishes disabled and broken model routes from usable presets', () => {
    assert.deepEqual(subagentPresetAvailability(preset(), [connection()]), {
      kind: 'available',
      tone: 'success',
    });
    // The tone is asserted with the kind, not separately: it is what decides
    // the badge variant, so a broken route quietly turning green is a pure-data
    // regression this file is the only place to catch. `available` and
    // `disabled` render no badge — the switch beside the row says the second —
    // but they stay in the value range so callers branch on one thing.
    assert.deepEqual(subagentPresetAvailability(preset({ enabled: false }), []), {
      kind: 'disabled',
      tone: 'neutral',
    });
    assert.deepEqual(subagentPresetAvailability(preset(), []), {
      kind: 'missing_connection',
      tone: 'destructive',
    });
    assert.deepEqual(subagentPresetAvailability(preset(), [connection({ enabled: false })]), {
      kind: 'connection_disabled',
      tone: 'warning',
    });
    assert.deepEqual(
      subagentPresetAvailability(preset({ model: 'deepseek-reasoner' }), [connection()]),
      { kind: 'model_disabled', tone: 'warning' },
    );
  });
});

describe('suggestSubagentPresetId', () => {
  it('creates stable safe ids and resolves collisions', () => {
    assert.equal(suggestSubagentPresetId('Fast Code Reader', new Set()), 'fast-code-reader');
    assert.equal(suggestSubagentPresetId('快速阅读', new Set()), 'subagent');
    assert.equal(
      suggestSubagentPresetId('Fast Code Reader', new Set(['fast-code-reader', 'fast-code-reader-2'])),
      'fast-code-reader-3',
    );
  });
});

describe('nextSubagentDraftForName', () => {
  const draft = { name: '', id: '' };

  it('derives the id from the name until the user takes the id over', () => {
    assert.deepEqual(nextSubagentDraftForName(draft, 'Fast Code Reader', false, new Set()), {
      name: 'Fast Code Reader',
      id: 'fast-code-reader',
    });
    // Once the user has typed an id, a later name edit must not overwrite it —
    // an editor that silently drops this gate looks identical on screen.
    assert.deepEqual(
      nextSubagentDraftForName({ name: 'Fast', id: 'my-own-id' }, 'Fast Reader', true, new Set()),
      { name: 'Fast Reader', id: 'my-own-id' },
    );
  });

  it('keeps other draft fields untouched and resolves collisions', () => {
    assert.deepEqual(
      nextSubagentDraftForName(
        { name: '', id: '', model: 'glm-4.7' },
        'Fast Code Reader',
        false,
        new Set(['fast-code-reader']),
      ),
      { name: 'Fast Code Reader', id: 'fast-code-reader-2', model: 'glm-4.7' },
    );
  });

  it('falls back to a safe id for a name with no ASCII, so two of them differ', () => {
    const first = nextSubagentDraftForName(draft, '快速阅读', false, new Set());
    assert.equal(first.id, 'subagent');
    assert.equal(
      nextSubagentDraftForName(draft, '网页研究', false, new Set([first.id])).id,
      'subagent-2',
    );
  });
});

describe('resolveSubagentRoute', () => {
  const fastReader = preset();

  it('resolves an edit route to the preset it names', () => {
    assert.deepEqual(resolveSubagentRoute({ kind: 'edit', presetId: 'fast-reader' }, [fastReader]), {
      level: 'edit',
      preset: fastReader,
    });
  });

  it('renders the list for an edit route whose preset is gone', () => {
    // The whole reason this is a function: `preset: null` is what the editor
    // reads as "new", so an edit level that kept rendering with a vanished
    // preset would be its create branch — and saving appends rather than
    // updates. Falling back to the list is what keeps those two apart.
    assert.deepEqual(resolveSubagentRoute({ kind: 'edit', presetId: 'gone' }, [fastReader]), {
      level: 'list',
      preset: null,
    });
  });

  it('carries list and create through untouched', () => {
    assert.deepEqual(resolveSubagentRoute({ kind: 'list' }, [fastReader]), {
      level: 'list',
      preset: null,
    });
    assert.deepEqual(resolveSubagentRoute({ kind: 'create' }, []), {
      level: 'create',
      preset: null,
    });
  });
});
