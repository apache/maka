/**
 * Maka's deterministic fixture contract is product-owned. Astryx handles the
 * real OS reduced-motion media query; these attributes cover only renderer
 * fixtures, whose captured content must not depend on animation timing.
 */
export function isProgressiveStreamingEnabled(streaming?: boolean): boolean {
  if (!streaming || typeof document === 'undefined') return streaming === true;
  const root = document.documentElement;
  return root.dataset.makaE2eFixture !== 'true' && root.dataset.makaReducedMotion !== 'true';
}
