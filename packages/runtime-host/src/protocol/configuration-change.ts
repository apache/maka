import { requireCount, requireExactRecord } from './codec.js';

export interface ConfigurationChangedFrame {
  readonly kind: 'configuration.changed';
  readonly revision: number;
}

export function decodeConfigurationChangedFrame(value: unknown): ConfigurationChangedFrame {
  const frame = requireExactRecord(value, 'configuration changed frame', ['kind', 'revision']);
  return {
    kind: 'configuration.changed',
    revision: requireCount(frame.revision, 'configuration revision'),
  };
}
