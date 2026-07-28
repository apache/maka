import type { SandboxBoundaryExpansion, SandboxBoundarySettlement } from '@maka/core';
import { z } from 'zod';

import type { MakaTool } from './tool-runtime.js';

const filesystemEntrySchema = z
  .object({
    path: z.string().min(1),
    access: z.enum(['read', 'write']),
    scope: z.enum(['exact', 'subtree']),
  })
  .strict();

const expansionSchema = z
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

export function buildRequestSandboxBoundaryTool(): MakaTool<
  { expansion: SandboxBoundaryExpansion; justification: string },
  SandboxBoundarySettlement
> {
  return {
    name: 'request_sandbox_boundary',
    description:
      'Request the smallest session sandbox boundary expansion needed to retry a local tool that returned sandbox_boundary_required.',
    parameters: z
      .object({
        expansion: expansionSchema,
        justification: z.string().min(1),
      })
      .strict(),
    impl: ({ expansion, justification }, context) => {
      if (!context.requestSandboxBoundary) {
        throw new Error('Sandbox boundary expansion is unavailable on this surface');
      }
      return context.requestSandboxBoundary(expansion, justification);
    },
  };
}
