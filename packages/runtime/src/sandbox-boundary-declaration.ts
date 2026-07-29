import { tmpdir } from 'node:os';
import {
  assessSandboxBoundaryExpansion,
  validateSandboxBoundaryExpansion,
  type SandboxBoundaryExpansion,
} from '@maka/core';
import { z } from 'zod';

import { SandboxCommandError } from './sandbox/errors.js';
import type { MakaToolContext } from './tool-runtime.js';

const filesystemEntrySchema = z
  .object({
    path: z.string().min(1),
    access: z.enum(['read', 'write']),
    scope: z.enum(['exact', 'subtree']),
  })
  .strict();

export const sandboxBoundaryExpansionSchema = z
  .object({
    filesystem: z
      .object({
        entries: z.array(filesystemEntrySchema).min(1).max(32),
      })
      .strict()
      .optional(),
    network: z
      .object({
        enabled: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.filesystem !== undefined || value.network !== undefined, {
    message: 'At least one sandbox boundary expansion is required',
  });

export function preflightDeclaredSandboxBoundary(
  requiredBoundary: SandboxBoundaryExpansion | undefined,
  ctx: MakaToolContext,
): void {
  if (!requiredBoundary) return;
  const validated = validateSandboxBoundaryExpansion(requiredBoundary);
  if (!validated.ok) {
    throw new Error(validated.message);
  }
  const boundary = ctx.executionBoundary;
  if (!boundary || boundary.kind === 'bypass' || boundary.kind === 'external') return;
  const assessment = assessSandboxBoundaryExpansion(boundary.profile, validated.expansion, {
    root: ctx.cwd,
    workspaceRoots: [ctx.cwd],
    tmpdir: tmpdir(),
    slashTmp: '/tmp',
  });
  if (assessment.outcome === 'noop') return;
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
    requiredExpansion: validated.expansion,
    message: 'Bash requires an approved session sandbox boundary expansion.',
  });
}
