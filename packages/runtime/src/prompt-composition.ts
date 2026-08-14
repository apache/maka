import type {
  ContextDiagnosticsComposition,
  ContextDiagnosticsSegment,
} from './context-diagnostics.js';
import type { PreparedRequestSegmentKind } from './request-shape.js';

/**
 * The three fields a fold needs, and no more.
 *
 * `PreparedRequestSegment` satisfies this structurally, so a live capture folds
 * without conversion — but a decoder reading one back off the ledger does not
 * have to invent an `index` or a `hash` it never uses just to produce the wider
 * type. A fabricated field is a silent wrong answer waiting for the first
 * caller that reads it.
 */
export interface SizedRequestSegment {
  kind: PreparedRequestSegmentKind;
  bytes: number;
  label?: string;
}

/**
 * Folds one request's captured segments into "what was this prompt made of"
 * (#2323).
 *
 * The bar above this in the Inspector answers how full the context is, from
 * provider-reported tokens. This answers what filled it, and the two are not
 * views of one number: composition is measured in **bytes of serialized
 * request**, sums to `requestBytes`, and never sums to the reported
 * `inputTokens`. Nothing here estimates tokens — a byte count is the fact this
 * layer holds, and turning it into a token figure is a display decision that
 * has to be labelled as an estimate where it is made (#1679).
 *
 * `tool_schema` folds per tool rather than into one total, because that is the
 * only breakdown a reader can act on: "tool definitions are 40%" names nothing
 * to remove. Every other kind folds whole — one system prompt, one history, one
 * options blob — and splitting `message` by what produced it is not knowable
 * here, where messages arrive already serialized.
 */
export function foldPromptComposition(
  segments: readonly SizedRequestSegment[],
): ContextDiagnosticsComposition | undefined {
  if (segments.length === 0) return undefined;

  const byKind = new Map<PreparedRequestSegmentKind, number>();
  const byTool = new Map<string, number>();
  let unlabelledToolBytes = 0;

  for (const segment of segments) {
    byKind.set(segment.kind, (byKind.get(segment.kind) ?? 0) + segment.bytes);
    if (segment.kind !== 'tool_schema') continue;
    if (segment.label === undefined) unlabelledToolBytes += segment.bytes;
    else byTool.set(segment.label, (byTool.get(segment.label) ?? 0) + segment.bytes);
  }

  // A zero-byte kind is dropped rather than shown as `≈0`, the same way
  // `/context` folds it — a part nothing contributed to is not a part.
  const folded: ContextDiagnosticsSegment[] = KIND_ORDER.flatMap((kind) => {
    const bytes = byKind.get(kind) ?? 0;
    return bytes > 0 ? [{ kind: PART_KINDS[kind], bytes }] : [];
  });
  if (folded.length === 0) return undefined;

  // Sorted by size because the question the list answers is "what is big
  // enough to be worth removing", and ties by name so a reader comparing two
  // reads of the same session sees the same order.
  const ranked = [...byTool.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  // Bounded HERE, at the owner that decides what the list means — not at the
  // wire decoder. A single MCP server may advertise up to 1000 tools, so a cap
  // downstream only moves the cliff: the 257th tool would fail the whole query
  // instead of being summarised. What falls below the cut is carried as a
  // remainder, so the rows still account for every tool byte.
  const tools = ranked.slice(0, MAX_TOOL_ROWS);
  const remainder = ranked.slice(MAX_TOOL_ROWS);
  const remainingToolBytes = remainder.reduce((carry, tool) => carry + tool.bytes, 0);

  return {
    segments: folded,
    ...(tools.length > 0 ? { tools } : {}),
    ...(remainder.length > 0
      ? { remainingTools: { count: remainder.length, bytes: remainingToolBytes } }
      : {}),
    ...(unlabelledToolBytes > 0 ? { unlabelledToolBytes } : {}),
  };
}

/**
 * The diagnostic append that carries the segments, alongside the durable
 * metering record on the same run stream.
 */
export const PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE = 'provider_request_attempt_recorded';

/**
 * Reads one run event into the composition of the request it describes.
 *
 * Returns undefined for every event that is not a decodable capture, so a
 * caller walking the run stream can recognise this alongside the metering
 * record without a second read. Absence is the honest outcome: this append is
 * best-effort, and a record that will not decode is a composition the reader
 * does not have — not a prompt made of nothing.
 */
export function readPromptCompositionEvent(event: {
  readonly type: string;
  readonly data?: unknown;
}): { attemptId: string; composition: ContextDiagnosticsComposition } | undefined {
  if (event.type !== PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE) return undefined;
  const data = event.data;
  if (!isRecord(data)) return undefined;
  const attemptId = data.attemptId;
  if (typeof attemptId !== 'string' || attemptId.length === 0) return undefined;
  if (!Array.isArray(data.segments)) return undefined;

  const segments: SizedRequestSegment[] = [];
  for (const value of data.segments) {
    const segment = readSegment(value);
    // One unreadable segment makes every share of this request wrong, so the
    // whole composition is dropped rather than silently under-counted.
    if (!segment) return undefined;
    segments.push(segment);
  }

  const composition = foldPromptComposition(segments);
  return composition ? { attemptId, composition } : undefined;
}

function readSegment(value: unknown): SizedRequestSegment | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (!KIND_ORDER.includes(kind as PreparedRequestSegmentKind)) return undefined;
  if (!isNonNegativeInteger(value.bytes)) return undefined;
  if (value.label !== undefined && typeof value.label !== 'string') return undefined;
  return {
    kind: kind as PreparedRequestSegmentKind,
    bytes: value.bytes,
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * How many tools the fold names individually.
 *
 * Generous enough that a normal registry is listed whole, small enough that a
 * pathological one cannot make this record unbounded. The panel shows fewer
 * still; this is the bound on what crosses a wire and sits in a projection.
 */
const MAX_TOOL_ROWS = 64;

const KIND_ORDER: readonly PreparedRequestSegmentKind[] = [
  'system_prompt',
  'tool_schema',
  'message',
  'provider_options',
];

/**
 * The CLI's `/context` vocabulary, reused rather than re-invented: the same
 * four buckets already fold the same segments for `readLatestContextDiagnostics`
 * (#1580), and two names for one fact is how two surfaces start disagreeing.
 */
const PART_KINDS: Record<PreparedRequestSegmentKind, ContextDiagnosticsSegment['kind']> = {
  system_prompt: 'system_instructions',
  tool_schema: 'tool_definitions',
  message: 'messages',
  provider_options: 'other',
};
