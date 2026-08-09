import { requireCount, requireExactRecord } from './codec.js';

export interface ProjectCatalogChangedFrame {
  readonly kind: 'project.catalog.changed';
  readonly revision: number;
}

export function decodeProjectCatalogChangedFrame(value: unknown): ProjectCatalogChangedFrame {
  const frame = requireExactRecord(value, 'project catalog changed frame', ['kind', 'revision']);
  return {
    kind: 'project.catalog.changed',
    revision: requireCount(frame.revision, 'project catalog change revision'),
  };
}
