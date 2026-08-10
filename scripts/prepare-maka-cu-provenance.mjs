export function resolveMakaCuSourceBranch({ currentBranch, remoteBranches = [], explicitBranch }) {
  const explicit = explicitBranch?.trim();
  if (explicit) return explicit;

  const current = currentBranch.trim();
  if (current && current !== 'HEAD') return current;

  const candidates = [
    ...new Set(
      remoteBranches
        .map((branch) => branch.trim())
        .filter((branch) => branch.includes('/') && !branch.endsWith('/HEAD'))
        .map((branch) => branch.replace(/^[^/]+\//, '')),
    ),
  ];
  if (candidates.length === 1) return candidates[0];

  throw new Error(
    candidates.length === 0
      ? 'detached source commit has no matching remote branch'
      : `detached source commit matches multiple remote branches: ${candidates.join(', ')}`,
  );
}
