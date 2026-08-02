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
        throw new Error(
          'request_sandbox_boundary is not available on this surface, so the sandbox was not widened. ' +
            'Retrying will fail the same way — redo the work inside the paths already allowed, or tell the user which path needs access.',
        );
      }
      return context.requestSandboxBoundary(expansion, justification);
    },
  };
}
