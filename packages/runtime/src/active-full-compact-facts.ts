import type { ModelMessage } from './model-protocol.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { estimateTokens } from './context-budget-helpers.js';
import { serializeToolResultForArchive } from './tool-result-archive.js';

interface FactSourceEntry {
  sourceId: string;
  messageIndex: number;
  partIndex?: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  runtimeEventId?: string;
  toolCallId?: string;
  toolName?: string;
  contentKind: string;
  archiveRef?: { artifactId: string };
}

interface SelectedFactSource {
  decision: 'selected';
  entries: FactSourceEntry[];
}

export interface ActiveFullCompactFactSummary {
  schemaVersion: 1;
  text: string;
  processState?: string[];
  vmState?: string[];
  artifactPaths?: string[];
  commandsTried?: Array<{ command: string; outcome: string; sourceIds?: string[] }>;
  latestVerifierFailure?: string;
  constraints?: string[];
  failedHypotheses?: string[];
  currentHypothesis?: string;
  nextActions?: string[];
  archiveRefs?: string[];
}

interface SelectedSourceSlice {
  entry: FactSourceEntry;
  text: string;
  role: FactSourceEntry['role'];
  sourceId: string;
}

const DEFAULT_CHARS_PER_TOKEN = 4;
const PROCESS_FACT_PATTERN =
  /\b(pid|process|listening|listen|port|127\.0\.0\.1|localhost|nc -l|server|service|background|foreground|timeout|url)\b/i;
const VM_FACT_PATTERN =
  /\b(vm|guest|boot|booted|login|kernel|panic|mount|reachable|refused|guest ip|hostfwd)\b/i;
const OUTCOME_FACT_PATTERN =
  /\b(exit code|exit=|status|failed|failure|error|timeout|assert|missing|listening|pid|port|reachable|refused|boot|login|self-check)\b/i;
const VERIFIER_CONTEXT_PATTERN = /\b(verifier|self-check|self check|test|assert|check)\b/i;
const FAILURE_PATTERN = /\b(fail|failed|failure|error|assert|expected|missing|timeout|red)\b/i;
const CONSTRAINT_PATTERN =
  /\b(constraint|do not|must|only|without|avoid|no hidden|no task-specific|preserve|keep)\b/i;
const FAILED_HYPOTHESIS_PATTERN =
  /\b(failed hypothesis|abandoned|hypothesis.+failed|tried.+failed|failed because|not enough|does not work|did not work)\b/i;
const CURRENT_HYPOTHESIS_PATTERN = /\b(current hypothesis|working theory|next i think|i think)\b/i;
const NEXT_ACTION_PATTERN = /\b(next action|next:|next i|retry|rerun|continue|check|inspect)\b/i;
const PATH_PATTERN =
  /(?:\/[A-Za-z0-9._~+@%=-]+(?:\/[A-Za-z0-9._~+@%=-]+)+|(?:\.{1,2}\/)?[A-Za-z0-9._~+@%=-]+(?:\/[A-Za-z0-9._~+@%=-]+)+)/g;
const SHELL_TOOL_PATTERN = /\b(bash|shell|exec|terminal|run|command|cmd|sh|powershell|zsh)\b/i;

export function buildActiveFullCompactFactSummary(input: {
  selection: SelectedFactSource;
  messages: readonly ModelMessage[];
  runtimeEvents?: readonly RuntimeEvent[];
  maxSummaryEstimatedTokens?: number;
  charsPerToken?: number;
}): ActiveFullCompactFactSummary {
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const maxSummaryEstimatedTokens = finitePositive(input.maxSummaryEstimatedTokens) ?? 512;
  const entries = input.selection.entries;
  const slices = selectedSourceSlices(input.selection, input.messages, input.runtimeEvents ?? []);
  const providerMessages = uniqueSorted(entries.map((entry) => String(entry.messageIndex)));
  const archiveRefs = uniqueSorted(
    entries.map((entry) => entry.archiveRef?.artifactId).filter(nonEmpty),
  );
  const toolCalls = uniqueSorted(entries.map((entry) => entry.toolCallId).filter(nonEmpty));
  const contentKinds = uniqueSorted(entries.map((entry) => entry.contentKind));
  const runtimeEvents = uniqueSorted(entries.map((entry) => entry.runtimeEventId).filter(nonEmpty));
  const commandsTried = extractProcessCommandAttempts(
    input.selection,
    input.messages,
    input.runtimeEvents ?? [],
  );
  const operationalSlices = slices.filter(
    (slice) => slice.role !== 'system' && slice.role !== 'user',
  );
  const processState = extractFactLines(operationalSlices, PROCESS_FACT_PATTERN, 8, 220);
  const vmState = extractFactLines(operationalSlices, VM_FACT_PATTERN, 8, 220);
  const artifactPaths = extractArtifactPathsFromSlices(slices, 8);
  const latestVerifierFailure = extractLatestVerifierFailure(slices);
  const constraints = extractConstraintLines(slices, 8);
  const failedHypotheses = extractFailedHypotheses(slices, 8);
  const currentHypothesis = extractCurrentHypothesis(slices);
  const nextActions = extractNextActions(slices, 8);
  const hasProcessFacts =
    processState.length > 0 ||
    vmState.length > 0 ||
    artifactPaths.length > 0 ||
    commandsTried.length > 0 ||
    latestVerifierFailure !== undefined;
  const text = boundedSummaryText(
    [
      hasProcessFacts
        ? 'Earlier active provider messages were compacted into deterministic benchmark/process state.'
        : 'Earlier active provider messages were compacted; only source and coverage metadata was extractable.',
      `Covered ${providerMessages.length} provider messages, ${entries.length} source entries, ${runtimeEvents.length} runtime events, ${toolCalls.length} tool calls, ${archiveRefs.length} archive refs.`,
      'Raw covered payloads were replaced in the provider request while source/archive refs preserve evidence.',
      `Content kinds: ${contentKinds.join(', ') || 'none'}.`,
    ].join(' '),
    Math.min(maxSummaryEstimatedTokens, 220),
    charsPerToken,
  );

  return fitSummaryToBudget(
    {
      schemaVersion: 1,
      text,
      ...(processState.length > 0 ? { processState } : {}),
      ...(vmState.length > 0 ? { vmState } : {}),
      ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
      ...(commandsTried.length > 0 ? { commandsTried } : {}),
      ...(latestVerifierFailure ? { latestVerifierFailure } : {}),
      ...(constraints.length > 0
        ? { constraints }
        : {
            constraints: [
              'Provider-visible raw covered payloads were replaced with this source-bearing compact block.',
            ],
          }),
      ...(failedHypotheses.length > 0 ? { failedHypotheses } : {}),
      ...(currentHypothesis ? { currentHypothesis } : {}),
      nextActions:
        nextActions.length > 0
          ? nextActions
          : [
              'Continue from the preserved recent active provider messages after this compact block.',
            ],
      ...(archiveRefs.length > 0 ? { archiveRefs } : {}),
    },
    maxSummaryEstimatedTokens,
    charsPerToken,
  );
}

function selectedSourceSlices(
  selection: SelectedFactSource,
  messages: readonly ModelMessage[],
  runtimeEvents: readonly RuntimeEvent[],
): SelectedSourceSlice[] {
  const runtimeById = new Map(runtimeEvents.map((event) => [event.id, event]));
  const runtimeByToolCallId = new Map<string, RuntimeEvent[]>();
  for (const event of runtimeEvents) {
    const toolCallId = runtimeToolCallId(event);
    if (toolCallId) pushMap(runtimeByToolCallId, toolCallId, event);
  }

  return sortedSelectedEntries(selection).map((entry) => {
    const providerText = partText(providerEntryPart(entry, messages));
    const runtimeEvent = entry.runtimeEventId
      ? runtimeById.get(entry.runtimeEventId)
      : matchingRuntimeEventForEntry(entry, runtimeByToolCallId);
    const runtimeText = runtimeEvent ? runtimeEventText(runtimeEvent) : '';
    return {
      entry,
      sourceId: entry.sourceId,
      role: entry.role,
      text: uniqueSorted([providerText, runtimeText].filter(nonEmpty)).join('\n'),
    };
  });
}

function extractProcessCommandAttempts(
  selection: SelectedFactSource,
  messages: readonly ModelMessage[],
  runtimeEvents: readonly RuntimeEvent[],
): Array<{ command: string; outcome: string; sourceIds?: string[] }> {
  const slices = selectedSourceSlices(selection, messages, runtimeEvents);
  const commands: Array<{ command: string; outcome: string; sourceIds?: string[] }> = [];
  const seen = new Set<string>();

  for (const entry of sortedSelectedEntries(selection)) {
    const part = providerEntryPart(entry, messages);
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type !== 'tool-call') continue;
    const toolName =
      typeof record.toolName === 'string' ? record.toolName : (entry.toolName ?? 'tool');
    const toolInput = 'input' in record ? record.input : record.args;
    const command = commandTextFromToolInput(toolName, toolInput);
    const key = entry.toolCallId ?? `${entry.sourceId}:${command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const related = slices.filter(
      (slice) =>
        (entry.toolCallId && slice.entry.toolCallId === entry.toolCallId) ||
        slice.sourceId === entry.sourceId,
    );
    commands.push({
      command,
      outcome: commandOutcome(related),
      sourceIds: uniqueSorted(related.map((slice) => slice.sourceId)),
    });
    if (commands.length >= 10) break;
  }

  return commands;
}

function commandTextFromToolInput(toolName: string, input: unknown): string {
  const command = stringField(input, ['command', 'cmd', 'script', 'shell', 'code']);
  if (SHELL_TOOL_PATTERN.test(toolName) && command) return clip(sanitizeFactLine(command), 240);
  return `${toolName} ${clip(stableStringify(input), 200)}`;
}

function commandOutcome(slices: readonly SelectedSourceSlice[]): string {
  const archiveRefs = uniqueSorted(
    slices.map((slice) => slice.entry.archiveRef?.artifactId).filter(nonEmpty),
  );
  const factLines = extractLinesFromText(
    slices.map((slice) => slice.text).join('\n'),
    OUTCOME_FACT_PATTERN,
    2,
    220,
  );
  const archiveText =
    archiveRefs.length > 0 ? `raw result archived as ${archiveRefs.join(', ')}` : '';
  return (
    [factLines.join(' | '), archiveText].filter(nonEmpty).join('; ') ||
    'completed; detailed output covered by active full compact source refs'
  );
}

function extractFactLines(
  slices: readonly SelectedSourceSlice[],
  pattern: RegExp,
  maxItems: number,
  maxChars: number,
): string[] {
  return uniqueInOrder(
    slices.flatMap((slice) => extractLinesFromText(slice.text, pattern, maxItems, maxChars)),
  ).slice(0, maxItems);
}

function extractArtifactPathsFromSlices(
  slices: readonly SelectedSourceSlice[],
  maxItems: number,
): string[] {
  const paths: string[] = [];
  for (const slice of slices) {
    for (const match of slice.text.matchAll(PATH_PATTERN)) {
      const path = sanitizePath(match[0]);
      if (path) paths.push(path);
    }
  }
  return uniqueSorted(paths).slice(0, maxItems);
}

function extractLatestVerifierFailure(slices: readonly SelectedSourceSlice[]): string | undefined {
  for (const slice of [...slices].reverse()) {
    const lines = splitCandidateLines(slice.text).reverse();
    for (const line of lines) {
      if (VERIFIER_CONTEXT_PATTERN.test(line) && FAILURE_PATTERN.test(line)) {
        return clip(sanitizeFactLine(line), 400);
      }
    }
  }
  return undefined;
}

function extractConstraintLines(
  slices: readonly SelectedSourceSlice[],
  maxItems: number,
): string[] {
  return uniqueInOrder(
    slices
      .filter(
        (slice) => slice.role === 'system' || slice.role === 'user' || slice.role === 'assistant',
      )
      .flatMap((slice) => extractLinesFromText(slice.text, CONSTRAINT_PATTERN, maxItems, 220)),
  ).slice(0, maxItems);
}

function extractFailedHypotheses(
  slices: readonly SelectedSourceSlice[],
  maxItems: number,
): string[] {
  return uniqueInOrder(
    slices
      .filter((slice) => slice.role === 'assistant')
      .flatMap((slice) =>
        extractLinesFromText(slice.text, FAILED_HYPOTHESIS_PATTERN, maxItems, 220),
      ),
  ).slice(0, maxItems);
}

function extractCurrentHypothesis(slices: readonly SelectedSourceSlice[]): string | undefined {
  for (const slice of [...slices].reverse()) {
    if (slice.role !== 'assistant') continue;
    for (const line of splitCandidateLines(slice.text).reverse()) {
      if (CURRENT_HYPOTHESIS_PATTERN.test(line)) return clip(sanitizeFactLine(line), 220);
    }
  }
  return undefined;
}

function extractNextActions(slices: readonly SelectedSourceSlice[], maxItems: number): string[] {
  return uniqueInOrder(
    slices
      .filter((slice) => slice.role === 'assistant')
      .flatMap((slice) => extractLinesFromText(slice.text, NEXT_ACTION_PATTERN, maxItems, 220)),
  ).slice(0, maxItems);
}

function fitSummaryToBudget(
  summary: ActiveFullCompactFactSummary,
  maxSummaryEstimatedTokens: number,
  charsPerToken: number,
): ActiveFullCompactFactSummary {
  const maxTokens = Math.max(1, maxSummaryEstimatedTokens);
  const fitted: ActiveFullCompactFactSummary = { ...summary };
  const optionalDropOrder: Array<keyof ActiveFullCompactFactSummary> = [
    'archiveRefs',
    'failedHypotheses',
    'nextActions',
    'currentHypothesis',
    'constraints',
    'latestVerifierFailure',
    'commandsTried',
    'artifactPaths',
    'vmState',
    'processState',
  ];
  for (const key of optionalDropOrder) {
    if (estimateTokens(stableStringify(fitted).length, charsPerToken) <= maxTokens) return fitted;
    delete fitted[key];
  }
  if (estimateTokens(stableStringify(fitted).length, charsPerToken) <= maxTokens) return fitted;

  const baseOverhead = stableStringify({ ...fitted, text: '' }).length;
  const maxTextChars = Math.max(1, maxTokens * charsPerToken - baseOverhead);
  return { schemaVersion: 1, text: clip(fitted.text, maxTextChars) };
}

function extractLinesFromText(
  text: string,
  pattern: RegExp,
  maxItems: number,
  maxChars: number,
): string[] {
  const lines: string[] = [];
  for (const line of splitCandidateLines(text)) {
    if (!pattern.test(line)) continue;
    const cleaned = clip(sanitizeFactLine(line), maxChars);
    if (!cleaned) continue;
    lines.push(cleaned);
    if (lines.length >= maxItems) break;
  }
  return lines;
}

function splitCandidateLines(text: string): string[] {
  return text
    .replaceAll('\\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map(sanitizeFactLine)
    .filter(
      (line) =>
        line.length > 0 &&
        line.length <= 1000 &&
        !isPlaceholderMetadataLine(line) &&
        !isTaskRunMetadataLine(line) &&
        !isLowSignalRawLogLine(line),
    );
}

function sanitizeFactLine(line: string): string {
  return line
    .replace(/\s+/g, ' ')
    .replace(/^[`"'[{( ]+/, '')
    .replace(/[`"',\]}) ]+$/, '')
    .trim();
}

function sanitizePath(value: string): string | undefined {
  const path = value.replace(/[.,;:)>\]}]+$/, '').trim();
  if (path.length < 3 || path.length > 180 || isLowSignalInternalPath(path)) return undefined;
  return path;
}

function isPlaceholderMetadataLine(line: string): boolean {
  return (
    line.includes('maka.active_archived_tool_result') ||
    line.includes('rewriteVersion') ||
    line.includes('bodySha256') ||
    line.includes('originalEstimatedTokens')
  );
}

function isTaskRunMetadataLine(line: string): boolean {
  const normalized = line.toLowerCase();
  if (/\btask_run_(created|queued|started|updated|completed|failed|cancelled)\b/.test(normalized))
    return true;
  if (
    /\b(taskrunid|task_run_id|runtimeeventid|runtime_event_id|invocationid|invocation_id)\b/.test(
      normalized,
    )
  ) {
    return !containsOperationalSignal(normalized);
  }
  if (
    /["'](?:sessionid|session_id|turnid|turn_id|runid|run_id)["']?\s*[:=]/i.test(line) &&
    /["'](?:status|taxonomy|event|type|createdat|created_at)["']?\s*[:=]/i.test(line)
  ) {
    return !containsOperationalSignal(normalized);
  }
  return false;
}

function isLowSignalRawLogLine(line: string): boolean {
  return (
    /\b(noise|spam|debug spam)\b/i.test(line) ||
    /\braw\b.*\b(log|output|noise|spam)\b/i.test(line) ||
    /do[_-]?not[_-]?leak/i.test(line)
  );
}

function containsOperationalSignal(normalizedLine: string): boolean {
  return (
    /\b(command|cmd|qemu|xorriso|mount|boot|kernel|initramfs|ssh|sshd|port|pid|exit code|failure|failed|timeout)\b/.test(
      normalizedLine,
    ) || /(?:^|[\s"'])\/(?:app|boot|tmp|workspace|etc|var)\//.test(normalizedLine)
  );
}

function isLowSignalInternalPath(path: string): boolean {
  return (
    /\/maka-task-run\//.test(path) ||
    /\/runs\/sessions\//.test(path) ||
    /\/exports\/harbor-/.test(path) ||
    /\/runtime-events\.jsonl$/.test(path) ||
    /\/events\.jsonl$/.test(path) ||
    /\/task-run\.json$/.test(path) ||
    /\/result\.json$/.test(path)
  );
}

function sortedSelectedEntries(selection: SelectedFactSource): FactSourceEntry[] {
  return [...selection.entries].sort(
    (left, right) =>
      left.messageIndex - right.messageIndex ||
      (left.partIndex ?? -1) - (right.partIndex ?? -1) ||
      left.sourceId.localeCompare(right.sourceId),
  );
}

function providerEntryPart(entry: FactSourceEntry, messages: readonly ModelMessage[]): unknown {
  const message = messages[entry.messageIndex] as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return content;
  return entry.partIndex === undefined ? content : content[entry.partIndex];
}

function partText(part: unknown): string {
  if (part === undefined || part === null) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object') return stableStringify(part);
  const record = part as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (
    (record.type === 'reasoning' || record.type === 'thinking') &&
    typeof (record.text ?? record.reasoning) === 'string'
  ) {
    return String(record.text ?? record.reasoning);
  }
  if (record.type === 'tool-call') return stableStringify(record.input ?? record.args ?? record);
  if (record.type === 'tool-result') return payloadText(toolResultPayload(record));
  return stableStringify(record);
}

function payloadText(payload: unknown): string {
  return typeof payload === 'string' ? payload : serializeToolResultForArchive(payload);
}

function matchingRuntimeEventForEntry(
  entry: FactSourceEntry,
  runtimeByToolCallId: ReadonlyMap<string, readonly RuntimeEvent[]>,
): RuntimeEvent | undefined {
  if (!entry.toolCallId) return undefined;
  const candidates = runtimeByToolCallId.get(entry.toolCallId) ?? [];
  const preferredKind =
    entry.contentKind === 'function_call'
      ? 'function_call'
      : entry.contentKind === 'function_response' ||
          entry.contentKind === 'tool_result' ||
          entry.contentKind === 'active_archive_placeholder'
        ? 'function_response'
        : undefined;
  return candidates.find((event) => event.content?.kind === preferredKind) ?? candidates[0];
}

function runtimeEventText(event: RuntimeEvent): string {
  const content = event.content;
  if (!content) return '';
  switch (content.kind) {
    case 'text':
    case 'thinking':
      return content.text;
    case 'function_call':
      return stableStringify(content.args);
    case 'function_response':
      return serializeToolResultForArchive(content.result);
    case 'error':
      return stableStringify(content);
  }
}

function runtimeToolCallId(event: RuntimeEvent): string | undefined {
  if (event.content?.kind === 'function_call' || event.content?.kind === 'function_response')
    return event.content.id;
  return event.refs?.toolCallId;
}

function toolResultPayload(part: Record<string, unknown>): unknown {
  if ('result' in part) return part.result;
  const output = part.output;
  if (output && typeof output === 'object' && 'value' in output) {
    return (output as { value?: unknown }).value;
  }
  return output ?? part;
}

function stringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

function boundedSummaryText(
  text: string,
  maxEstimatedTokens: number,
  charsPerToken: number,
): string {
  return clip(text, Math.max(1, maxEstimatedTokens * charsPerToken));
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
