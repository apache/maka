import type { OpenResponsesCompatibilityProfile } from './provider-runtime-policy.js';

export function createOpenResponsesCompatibilityFinalizer(
  profile: OpenResponsesCompatibilityProfile | undefined,
): ((body: Record<string, unknown>) => Record<string, unknown>) | undefined {
  if (!profile) return undefined;
  return (body) => {
    const choice = body.tool_choice;
    if (choice === 'required' || (choice !== null && typeof choice === 'object')) {
      throw new Error('Alibaba Token Plan Responses does not support forced tool_choice');
    }
    return { ...body, store: false };
  };
}
