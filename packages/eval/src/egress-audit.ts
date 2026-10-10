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

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from './experiment.js';

export const EGRESS_AUDIT_DESTINATION = 'egress-hits.jsonl';
export const EGRESS_AUDIT_ARTIFACT_PATH = `artifacts/${EGRESS_AUDIT_DESTINATION}`;

export interface EgressAuditEvidence {
  readonly failureReason: string | null;
  readonly artifacts: readonly JsonObject[];
}

export function egressAuditCollection(): readonly JsonObject[] {
  return [
    {
      source: '/opt/maka-egress-state/hits.jsonl',
      destination: EGRESS_AUDIT_DESTINATION,
      service: 'maka-eval-mitmproxy',
    },
  ];
}

interface EgressAuditSummary {
  readonly truncated: boolean;
  readonly policyErrorCount: number;
  readonly malformedLineCount: number;
}

export function describeEgressAudit(
  bytes: Buffer | undefined,
  required: boolean,
): EgressAuditEvidence {
  if (!required) return cleanEvidence();
  if (bytes === undefined) return missingEvidence();

  return {
    failureReason: null,
    artifacts: [
      {
        kind: 'egress-audit',
        path: EGRESS_AUDIT_ARTIFACT_PATH,
        bytes: bytes.byteLength,
        sha256: digest(bytes),
        ...summarize(bytes),
      },
    ],
  };
}

export async function readEgressAuditEvidence(
  trialPath: string,
  required: boolean,
): Promise<EgressAuditEvidence> {
  if (!required) return cleanEvidence();
  const auditPath = join(trialPath, EGRESS_AUDIT_ARTIFACT_PATH);
  try {
    return describeEgressAudit(await readFile(auditPath), true);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return missingEvidence();
    return {
      failureReason: `failed to read egress audit log ${auditPath}${code ? ` (${code})` : ''}`,
      artifacts: [{ kind: 'egress-audit-unreadable', path: EGRESS_AUDIT_ARTIFACT_PATH }],
    };
  }
}

function summarize(bytes: Buffer): EgressAuditSummary {
  let truncated = false;
  let policyErrorCount = 0;
  let malformedLineCount = 0;

  for (const line of jsonLines(bytes)) {
    const record = decodeRecord(line);
    if (record === undefined) continue;
    if (record === null) {
      malformedLineCount += 1;
    } else if (record.ruleId === 'audit_truncated') {
      truncated = true;
    } else if (record.ruleId === 'policy_error') {
      policyErrorCount += 1;
    }
  }

  return { truncated, policyErrorCount, malformedLineCount };
}

function* jsonLines(bytes: Buffer): Generator<Buffer> {
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline === -1 ? bytes.length : newline;
    yield bytes.subarray(start, end);
    start = newline === -1 ? bytes.length : newline + 1;
  }
}

function decodeRecord(line: Buffer): { readonly ruleId?: unknown } | null | undefined {
  if (line.length === 0) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(line).trim();
    if (!text) return undefined;
    const decoded: unknown = JSON.parse(text);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    return decoded as { readonly ruleId?: unknown };
  } catch {
    return null;
  }
}

function cleanEvidence(): EgressAuditEvidence {
  return { failureReason: null, artifacts: [] };
}

function missingEvidence(): EgressAuditEvidence {
  return {
    failureReason: 'egress audit log missing',
    artifacts: [{ kind: 'egress-audit-missing', path: EGRESS_AUDIT_ARTIFACT_PATH }],
  };
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}
