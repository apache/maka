import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import {
  projectDesktopExternalSessionCatalogItem,
} from '../../preload/external-session-catalog.js';
import { projectDesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';

test('projects imported Session ids into the same Desktop identity space as Session summaries', () => {
  const host = { hostId: 'host-a' };
  const catalogItem = projectDesktopExternalSessionCatalogItem(host, {
    id: 'source-1',
    name: 'Source',
    cwd: '/external',
    importState: {
      importedCount: 1,
      importedSessionIds: ['imported-1'],
      isImporting: false,
    },
  });
  const summary = projectDesktopSessionSummary(
    {
      ...host,
      profileId: 'profile-a',
      profileName: 'Profile A',
      profileKind: 'remote',
    },
    session('imported-1'),
  );

  assert.deepEqual(catalogItem.importState.importedSessionIds, [
    desktopSessionKey({ hostId: host.hostId, sessionId: 'imported-1' }),
  ]);
  assert.equal(catalogItem.importState.importedSessionIds[0], summary.id);
});

function session(id: string): SessionSummary {
  return {
    id,
    name: 'Imported',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'gpt-5',
    permissionMode: 'ask',
  };
}
