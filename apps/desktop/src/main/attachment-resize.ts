import { MAX_MODEL_IMAGE_EDGE } from '@maka/core/attachments';

export const ATTACHMENT_IMAGE_MAX_EDGE = MAX_MODEL_IMAGE_EDGE;

/**
 * Compute the target size to scale an image down so its longest edge fits
 * `maxEdge`, preserving aspect ratio. Returns `null` when the image already
 * fits or has no usable dimensions (no resize needed). Pure so it can be
 * tested without Electron's nativeImage.
 */
export function computeResizeDimensions(
  width: number,
  height: number,
  maxEdge: number = ATTACHMENT_IMAGE_MAX_EDGE,
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest === 0 || longest <= maxEdge) return null;
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
