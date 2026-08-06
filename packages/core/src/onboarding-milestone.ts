export function hasSettledInitialOnboarding(
  milestones: ReadonlyArray<{
    id: string;
    completedAt?: number;
    skippedAt?: number;
  }>,
): boolean {
  return milestones.some(
    (milestone) =>
      milestone.id === 'initial_onboarding' &&
      (milestone.completedAt !== undefined || milestone.skippedAt !== undefined),
  );
}
