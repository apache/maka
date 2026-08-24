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

import { tmpdir } from 'node:os';
import {
  assessSandboxBoundaryExpansion,
  type SandboxBoundaryExpansion,
} from '@maka/core/sandbox-boundary';
import { z } from 'zod';

import { SandboxCommandError } from './sandbox/errors.js';
import {
  normalizeSandboxBoundaryExpansion,
  SandboxBoundaryDeclarationError,
} from './sandbox-boundary-path.js';
import type { MakaToolContext } from './tool-runtime.js';

export const BASH_REQUIRED_BOUNDARY_DESCRIPTION =
  'A specific boundary requirement used only when boundary_intent is expand; under current it has ' +
  'no authority effect and should be omitted. With expand, repeat the same declaration when retrying ' +
  'after approval: normalized absolute paths, subtree for a directory, exact for a file, and network ' +
  'only when the process needs sockets, including loopback connections or listeners. Never add ' +
  'authority speculatively.';

export const bashBoundaryIntentSchema = z
  .enum(['current', 'expand'])
  .default('current')
  .describe(
    'Defaults to current when omitted. Use current when the command needs no specifically declared ' +
      'path or process-network requirement, including ordinary workspace inspection, edits, local Git, ' +
      'and offline builds or tests. Under current, Runtime ignores any supplied required_boundary. Use ' +
      'expand when the command depends on a specifically declared path or process-network capability, ' +
      'whether it is already approved or must be requested; then provide required_boundary.',
  );

const filesystemEntrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'A normalized absolute path. Never use relative paths such as "." or placeholders.',
      ),
    access: z
      .enum(['read', 'write'])
      .describe('Use read for inspection; use write only when the command will modify the target.'),
    scope: z
      .enum(['exact', 'subtree'])
      .describe('Use exact for one file and subtree for an existing directory.'),
  })
  .strict();

export const sandboxBoundaryExpansionSchema = z
  .object({
    filesystem: z
      .object({
        entries: z
          .array(filesystemEntrySchema)
          .min(1)
          .max(32)
          .describe('The smallest set of path requirements declared for this command.'),
      })
      .strict()
      .describe('Filesystem requirements declared for this command.')
      .optional(),
    network: z
      .object({
        enabled: z.literal(true).describe('Enable process network access, including sockets.'),
      })
      .strict()
      .describe(
        'Include only when the command is known, or sandbox evidence shows, that it needs process ' +
          'network access such as an external connection, loopback connection, or listener. Omit for ' +
          'offline commands and tests.',
      )
      .optional(),
  })
  .strict()
  .refine((value) => value.filesystem !== undefined || value.network !== undefined, {
    message: 'At least one sandbox boundary expansion is required',
  })
  .describe('The smallest sandbox authority requirement declared for an operation.');

/**
 * Drop a surplus declaration before its nested schema is evaluated whenever
 * the call did not ask to expand authority. The parsed value therefore agrees
 * with the execution contract: `current` carries no boundary declaration at
 * all, even if a provider serialized a stale or structurally invalid value.
 */
export function preprocessBashBoundaryDeclaration<T extends z.ZodType>(schema: T) {
  return z.preprocess(dropInactiveBashBoundaryDeclaration, schema);
}

function dropInactiveBashBoundaryDeclaration(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (input.boundary_intent !== undefined && input.boundary_intent !== 'current') return value;
  if (!Object.hasOwn(input, 'required_boundary')) return value;
  const normalized = { ...input };
  delete normalized.required_boundary;
  return normalized;
}

export function refineBashBoundaryDeclaration(
  input: {
    boundary_intent?: 'current' | 'expand';
    required_boundary?: SandboxBoundaryExpansion;
  },
  ctx: z.core.$RefinementCtx,
): void {
  if (input.boundary_intent === 'expand' && !input.required_boundary) {
    ctx.addIssue({
      code: 'custom',
      path: ['required_boundary'],
      message: 'required_boundary is required when boundary_intent is expand',
    });
  }
}

export function selectedBashBoundaryExpansion(input: {
  boundary_intent?: 'current' | 'expand';
  required_boundary?: SandboxBoundaryExpansion;
}): SandboxBoundaryExpansion | undefined {
  return input.boundary_intent === 'expand' ? input.required_boundary : undefined;
}

export async function preflightDeclaredSandboxBoundary(
  requiredBoundary: SandboxBoundaryExpansion | undefined,
  ctx: MakaToolContext,
): Promise<SandboxBoundaryExpansion | undefined> {
  if (!requiredBoundary) return undefined;
  let normalized: SandboxBoundaryExpansion;
  try {
    normalized = await normalizeSandboxBoundaryExpansion(requiredBoundary, ctx.cwd);
  } catch (error) {
    if (!(error instanceof SandboxBoundaryDeclarationError)) throw error;
    throw new SandboxCommandError({
      domain: 'command',
      stage: 'validation',
      reason: 'invalid_boundary_declaration',
      recoverable: true,
      message: error.message,
    });
  }
  const boundary = ctx.executionBoundary;
  if (!boundary || boundary.kind === 'bypass' || boundary.kind === 'external') return normalized;
  const assessment = assessSandboxBoundaryExpansion(boundary.profile, normalized, {
    root: ctx.cwd,
    workspaceRoots: [ctx.cwd],
    tmpdir: tmpdir(),
    ...(process.platform === 'win32' ? {} : { slashTmp: '/tmp' }),
  });
  if (assessment.outcome === 'noop') return normalized;
  if (assessment.outcome === 'conflict') {
    throw new SandboxCommandError({
      domain: 'command',
      stage: 'validation',
      reason: 'requires_bypass',
      recoverable: false,
      profileName: boundary.profile.name ?? boundary.profile.type,
      message: 'The declared Bash capability conflicts with an explicit sandbox deny.',
    });
  }
  throw new SandboxCommandError({
    domain: 'command',
    stage: 'validation',
    reason: 'sandbox_boundary_required',
    recoverable: true,
    profileName: boundary.profile.name ?? boundary.profile.type,
    requiredExpansion: normalized,
    message: 'Bash requires an approved session sandbox boundary expansion.',
  });
}
