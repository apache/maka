import type { SandboxBoundaryExpansion, SandboxBoundarySettlement } from '@maka/core';
import { z } from 'zod';

import { sandboxBoundaryExpansionSchema } from './sandbox-boundary-declaration.js';
import type { MakaTool } from './tool-runtime.js';

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
        expansion: sandboxBoundaryExpansionSchema,
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
