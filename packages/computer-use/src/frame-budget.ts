// One frame budget for every computer-use backend. The bound is the model's
// context, not the transport: a frame that survives the wire but blows the
// context window is no more usable than one that never arrived, so both the
// cua-driver backend (frames inline, base64 on stdout) and the maka-cu backend
// (frames by file reference) measure the same decoded bytes against it.

/** Frames above this get re-encoded before the cap check; small crisp PNGs pass through. */
export const FRAME_COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024;

export const FRAME_MAX_BYTES = 8 * 1024 * 1024;

export function exceedsFrameCap(byteLength: number): boolean {
  return byteLength > FRAME_MAX_BYTES;
}
