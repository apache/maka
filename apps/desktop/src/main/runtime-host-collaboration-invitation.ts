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

import {
  decodeRemoteRuntimeHostProfile,
  type RuntimeHostRemoteTransport,
} from '@maka/runtime-host/client';
import { decodeCollaborationInvitationCode } from '@maka/runtime-host/protocol';

const SCHEMA_VERSION = 1;
export const DESKTOP_COLLABORATION_INVITATION_CODE_MAX_BYTES = 32 * 1024;

export interface DesktopCollaborationConnectionTarget {
  readonly name: string;
  readonly transport: RuntimeHostRemoteTransport;
}

export interface DesktopCollaborationInvitation {
  readonly invitationCode: string;
  readonly target: DesktopCollaborationConnectionTarget;
}

export function encodeDesktopCollaborationInvitation(
  value: DesktopCollaborationInvitation,
): string {
  const invitation = decodeCollaborationInvitationCode(value.invitationCode);
  const target = decodeTarget(value.target, invitation.rootId);
  return Buffer.from(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      invitationCode: value.invitationCode,
      target,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeDesktopCollaborationInvitation(
  code: string,
): DesktopCollaborationInvitation {
  if (
    !code ||
    Buffer.byteLength(code, 'utf8') > DESKTOP_COLLABORATION_INVITATION_CODE_MAX_BYTES
  ) {
    throw new Error('Invalid Desktop collaboration invitation');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid Desktop collaboration invitation');
  }
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'invitationCode', 'target'])) {
    throw new Error('Invalid Desktop collaboration invitation');
  }
  if (value.schemaVersion !== SCHEMA_VERSION || typeof value.invitationCode !== 'string') {
    throw new Error('Unsupported Desktop collaboration invitation');
  }
  const invitation = decodeCollaborationInvitationCode(value.invitationCode);
  return {
    invitationCode: value.invitationCode,
    target: decodeTarget(value.target, invitation.rootId),
  };
}

function decodeTarget(value: unknown, rootId: string): DesktopCollaborationConnectionTarget {
  if (!isRecord(value) || !hasExactKeys(value, ['name', 'transport'])) {
    throw new Error('Invalid Desktop collaboration connection target');
  }
  const profile = decodeRemoteRuntimeHostProfile({
    id: 'collaboration-target',
    name: value.name,
    kind: 'remote',
    rootId,
    transport: value.transport,
  });
  return {
    name: profile.name,
    transport: profile.transport,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.slice().sort().every((key, index) => key === keys[index]);
}
