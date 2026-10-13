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

import { requireExactRecord, requireId, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';

export type ArtifactChangedFrame =
  | {
      readonly kind: 'artifact.changed';
      readonly reason: 'deleted';
      readonly sessionId: string;
      readonly artifactId: string;
    }
  | {
      readonly kind: 'artifact.changed';
      readonly reason: 'session_purged';
      readonly sessionId: string;
    };

export function decodeArtifactChangedFrame(value: unknown): ArtifactChangedFrame {
  const candidate = requireRecord(value, 'Artifact changed frame');
  const fields =
    candidate.reason === 'deleted'
      ? ['kind', 'reason', 'sessionId', 'artifactId']
      : ['kind', 'reason', 'sessionId'];
  const frame = requireExactRecord(value, 'Artifact changed frame', fields);
  if (frame.kind !== 'artifact.changed') {
    throw invalidProtocolFrame('Invalid Artifact changed frame kind');
  }
  if (frame.reason === 'deleted') {
    return {
      kind: 'artifact.changed',
      reason: 'deleted',
      sessionId: requireId(frame.sessionId, 'sessionId'),
      artifactId: requireId(frame.artifactId, 'artifactId'),
    };
  }
  if (frame.reason !== 'session_purged') {
    throw invalidProtocolFrame('Invalid Artifact change reason');
  }
  return {
    kind: 'artifact.changed',
    reason: 'session_purged',
    sessionId: requireId(frame.sessionId, 'sessionId'),
  };
}
