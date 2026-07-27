const SENSITIVE_KEY_SUFFIXES = new Set([
  'auth',
  'authorization',
  'credential',
  'credentials',
  'passwd',
  'password',
  'secret',
  'token',
]);
const SENSITIVE_KEY_QUALIFIERS = new Set(['api', 'private', 'secret', 'ssh']);

const POSIX_LINE_CONTINUATION_SOURCE = String.raw`\\\r?\n`;
const OPTIONAL_POSIX_LINE_CONTINUATION_SOURCE = `(?:${POSIX_LINE_CONTINUATION_SOURCE})*`;
const OPTIONAL_SHELL_SEPARATOR_SOURCE = `(?:[ \\t]|${POSIX_LINE_CONTINUATION_SOURCE})*`;
const AWS_SECRET_ACCESS_KEY_ENV_SOURCE = posixContinuedTokenSource('AWS_SECRET_ACCESS_KEY');

const QUOTED_SECRET_KEY_VALUE_PATTERN = /((?:"([^"\\]+)"\s*:\s*"))(?:\\.|[^"\\])*/g;
const GENERIC_ASSIGNMENT_PATTERN = new RegExp(
  `\\b([A-Za-z][A-Za-z0-9_-]*)${OPTIONAL_SHELL_SEPARATOR_SOURCE}(?:\\+=|[:=])${OPTIONAL_SHELL_SEPARATOR_SOURCE}`,
  'g',
);
const SHELL_ASSIGNMENT_KEY_PATTERN = new RegExp(
  `\\b([A-Za-z](?:[A-Za-z0-9_-]|${POSIX_LINE_CONTINUATION_SOURCE})*)`,
  'g',
);
const AUTHORIZATION_HEADER_PATTERN =
  /\b((?:proxy-)?authorization:\s*(?:bearer|basic|token)\s+)[^\s"'<>]+/gi;
const AWS_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b${AWS_SECRET_ACCESS_KEY_ENV_SOURCE}${OPTIONAL_SHELL_SEPARATOR_SOURCE}[:=]${OPTIONAL_SHELL_SEPARATOR_SOURCE}`,
  'gi',
);

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-(?:ant-)?[a-z0-9_-]{8,})\b/gi,
  /\b(AIza[0-9A-Za-z_-]{20,})\b/g,
  /\b(gh[pousr]_[0-9A-Za-z_]{20,})\b/g,
  /\b(xox[abprs]-[0-9A-Za-z-]{10,})\b/g,
  /\b([a-f0-9]{40,})\b/gi,
];

export function redactSecrets(value: string): string {
  const json = redactSerializedJsonSecrets(value);
  return json ?? redactTextSecrets(value);
}

function redactTextSecrets(value: string): string {
  let next = value;
  next = redactUrlQuerySecrets(next);
  next = next.replace(QUOTED_SECRET_KEY_VALUE_PATTERN, (match, prefix: string, key: string) =>
    isSensitiveKey(key) ? `${prefix}[redacted]` : match,
  );
  next = next.replace(
    AUTHORIZATION_HEADER_PATTERN,
    (_match, prefix: string) => `${prefix}[redacted]`,
  );
  next = redactShellSecrets(next);
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, (_match, prefixOrSecret: string) => {
      if (prefixOrSecret.includes(':') || prefixOrSecret.includes('='))
        return `${prefixOrSecret}[redacted]`;
      return '[redacted]';
    });
  }
  return next;
}

function posixContinuedTokenSource(token: string): string {
  return [...token]
    .map((character) => escapeRegExpLiteral(character))
    .join(OPTIONAL_POSIX_LINE_CONTINUATION_SOURCE);
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

interface ShellWord {
  start: number;
  end: number;
  decoded: string | undefined;
  staticFragments: string[];
  complete: boolean;
  uncertain: boolean;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

interface AssignmentCandidate {
  start: number;
  valueStart: number;
}

type ShellQuote = "'" | '"' | 'ansi' | undefined;
type ExpansionCloser = ')' | '}' | '`';

interface ExpansionFrame {
  id: number;
  closer: ExpansionCloser;
  restoreQuote: ShellQuote;
  parent: ExpansionFrame | undefined;
}

interface ShellContextState {
  index: number;
  quote: ShellQuote;
  expansion: ExpansionFrame | undefined;
}

interface ShellContextMachine {
  states: ShellContextState[];
  frames: Map<string, ExpansionFrame>;
  nextFrameId: number;
  overflowed: boolean;
}

const MAX_SHELL_CONTEXT_STATES = 16;

function readShellWord(value: string, start: number): ShellWord | undefined {
  if (start >= value.length || isShellBoundary(value[start]!)) return undefined;

  let decoded = '';
  let quote: ShellQuote;
  let uncertain = false;
  let complete = true;
  let index = start;
  const staticFragments = [''];
  const appendStatic = (text: string): void => {
    decoded += text;
    staticFragments[staticFragments.length - 1] += text;
  };
  const markUncertain = (): void => {
    uncertain = true;
    staticFragments.push('');
  };
  while (index < value.length) {
    const character = value[index]!;
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else appendStatic(character);
      index += 1;
      continue;
    }
    if (quote === 'ansi') {
      if (character === "'") {
        quote = undefined;
      } else if (character === '\\') {
        const escaped = consumeAnsiCEscape(value, index);
        markUncertain();
        complete = complete && escaped.complete;
        index = escaped.end;
        if (!escaped.complete) break;
        continue;
      } else {
        appendStatic(character);
      }
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === '\\') {
        const escaped = consumeShellEscape(value, index);
        if (!escaped.complete) {
          complete = false;
          index = escaped.end;
          break;
        }
        const escapedCharacter = value[index + 1];
        if (escapedCharacter === '\n' || escapedCharacter === '\r') {
          // POSIX line continuation contributes no decoded character.
        } else if (
          escapedCharacter === '$' ||
          escapedCharacter === '`' ||
          escapedCharacter === '"' ||
          escapedCharacter === '\\'
        ) {
          appendStatic(escapedCharacter);
        } else {
          appendStatic(`\\${escapedCharacter}`);
        }
        index = escaped.end;
        continue;
      } else if (character === '$' || character === '`') {
        const expansion = consumeShellExpansion(value, index);
        markUncertain();
        complete = complete && expansion.complete;
        index = expansion.end;
        continue;
      } else {
        appendStatic(character);
      }
      index += 1;
      continue;
    }
    if (isShellBoundary(character)) break;
    if (character === '$' && value[index + 1] === "'") {
      quote = 'ansi';
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (character === '\\') {
      const escaped = consumeShellEscape(value, index);
      if (!escaped.complete) {
        complete = false;
        index = escaped.end;
        break;
      }
      if (escaped.decoded !== undefined) appendStatic(escaped.decoded);
      index = escaped.end;
      continue;
    }
    if (character === '$' || character === '`') {
      const expansion = consumeShellExpansion(value, index);
      markUncertain();
      complete = complete && expansion.complete;
      index = expansion.end;
      continue;
    }
    appendStatic(character);
    index += 1;
  }
  if (quote !== undefined) complete = false;
  return {
    start,
    end: index,
    decoded: complete && !uncertain ? decoded : undefined,
    staticFragments,
    complete,
    uncertain,
  };
}

function readAssignmentValue(
  value: string,
  start: number,
  outerQuote: ShellQuote,
): ShellWord | undefined {
  if (!outerQuote) return readShellWord(value, start);
  if (start >= value.length) return undefined;

  let index = start;
  let complete = false;
  while (index < value.length) {
    const character = value[index]!;
    if ((outerQuote === 'ansi' || outerQuote === "'") && character === "'") {
      complete = true;
      break;
    }
    if (outerQuote === '"' && character === '"') {
      complete = true;
      break;
    }
    if (character === '\\' && outerQuote !== "'") {
      const escaped =
        outerQuote === 'ansi' ? consumeAnsiCEscape(value, index) : consumeShellEscape(value, index);
      index = escaped.end;
      if (!escaped.complete) break;
      continue;
    }
    if (outerQuote === '"' && (character === '$' || character === '`')) {
      const expansion = consumeShellExpansion(value, index);
      index = expansion.end;
      if (!expansion.complete) break;
      continue;
    }
    index += 1;
  }
  return {
    start,
    end: index,
    decoded: undefined,
    staticFragments: [],
    complete,
    uncertain: false,
  };
}

function advanceShellQuoteContexts(
  value: string,
  end: number,
  machine: ShellContextMachine,
): { quoteContexts: ShellQuote[]; overflowFallback: boolean } {
  while (true) {
    const nextIndex = Math.min(
      ...machine.states.map((state) =>
        state.index < end ? state.index : Number.POSITIVE_INFINITY,
      ),
    );
    if (!Number.isFinite(nextIndex)) break;
    machine.states = boundShellContextStates(
      machine.states.flatMap((state) =>
        state.index === nextIndex ? stepShellContext(value, state, machine) : state,
      ),
      machine,
    );
  }
  const contexts = new Set<ShellQuote>(machine.states.map((state) => state.quote));
  const boundaryQuote = value[end - 1];
  const ambiguousBoundaryQuote =
    (boundaryQuote === "'" || boundaryQuote === '"') &&
    contexts.has(undefined) &&
    contexts.has(boundaryQuote);
  return {
    quoteContexts: [...contexts],
    overflowFallback: machine.overflowed || ambiguousBoundaryQuote,
  };
}

function stepShellContext(
  value: string,
  state: ShellContextState,
  machine: ShellContextMachine,
): ShellContextState[] {
  const character = value[state.index]!;
  if (state.quote) {
    const closer = state.quote === '"' ? '"' : "'";
    if (character === closer) {
      state.quote = undefined;
      state.index += 1;
    } else if (character === '\\' && state.quote !== "'") {
      state.index =
        state.quote === 'ansi'
          ? consumeAnsiCEscape(value, state.index).end
          : consumeShellEscape(value, state.index).end;
    } else if (state.quote === '"' && enterShellExpansion(value, state, machine)) {
      return [state];
    } else {
      state.index += 1;
    }
    return [state];
  }
  const expansion = state.expansion;
  if (expansion && character === expansion.closer) {
    state.expansion = expansion.parent;
    state.quote = expansion.restoreQuote;
    state.index += 1;
    return [state];
  }
  if (enterShellExpansion(value, state, machine)) return [state];
  if (character === '(' && expansion?.closer === ')') {
    pushExpansionFrame(state, machine, ')');
    state.index += 1;
    return [state];
  }
  if (character === '\\') {
    state.index = consumeShellEscape(value, state.index).end;
  } else if (character === '$' && value[state.index + 1] === "'") {
    state.quote = 'ansi';
    state.index += 2;
  } else if (character === "'" && isProseApostrophe(value, state.index)) {
    const literal = { ...state, index: state.index + 1 };
    state.quote = "'";
    state.index += 1;
    return [state, literal];
  } else if (character === "'" || character === '"') {
    state.quote = character;
    state.index += 1;
  } else {
    state.index += 1;
  }
  return [state];
}

function enterShellExpansion(
  value: string,
  state: ShellContextState,
  machine: ShellContextMachine,
): boolean {
  const character = value[state.index];
  const next = value[state.index + 1];
  const closer =
    character === '`'
      ? '`'
      : character === '$' && next === '('
        ? ')'
        : character === '$' && next === '{'
          ? '}'
          : undefined;
  if (!closer) return false;
  pushExpansionFrame(state, machine, closer);
  state.index += closer === '`' ? 1 : 2;
  return true;
}

function pushExpansionFrame(
  state: ShellContextState,
  machine: ShellContextMachine,
  closer: ExpansionCloser,
): void {
  const key = `${state.expansion?.id ?? 0}:${closer}:${state.quote ?? '-'}`;
  let frame = machine.frames.get(key);
  if (!frame) {
    frame = {
      id: machine.nextFrameId,
      closer,
      restoreQuote: state.quote,
      parent: state.expansion,
    };
    machine.nextFrameId += 1;
    machine.frames.set(key, frame);
  }
  state.expansion = frame;
  state.quote = undefined;
}

function boundShellContextStates(
  states: ShellContextState[],
  machine: ShellContextMachine,
): ShellContextState[] {
  const unique = new Map<string, ShellContextState>();
  for (const state of states)
    unique.set(`${state.index}:${state.quote ?? '-'}:${state.expansion?.id ?? 0}`, state);
  const deduplicated = [...unique.values()];
  if (deduplicated.length <= MAX_SHELL_CONTEXT_STATES) return deduplicated;

  machine.overflowed = true;
  const selected: ShellContextState[] = [];
  for (const quote of [undefined, "'", '"', 'ansi'] as ShellQuote[]) {
    const state = deduplicated.find((candidate) => candidate.quote === quote);
    if (state) selected.push(state);
  }
  for (const state of deduplicated) {
    if (selected.length >= MAX_SHELL_CONTEXT_STATES) break;
    if (!selected.includes(state)) selected.push(state);
  }
  return selected;
}

function isProseApostrophe(value: string, index: number): boolean {
  return /[\p{L}\p{N}]/u.test(value[index - 1] ?? '');
}

function consumeShellEscape(
  value: string,
  start: number,
): { end: number; decoded: string | undefined; complete: boolean } {
  if (start + 1 >= value.length) return { end: value.length, decoded: undefined, complete: false };
  const next = value[start + 1]!;
  if (next === '\n') return { end: start + 2, decoded: undefined, complete: true };
  if (next === '\r' && value[start + 2] === '\n')
    return { end: start + 3, decoded: undefined, complete: true };
  return { end: start + 2, decoded: next, complete: true };
}

function consumeAnsiCEscape(value: string, start: number): { end: number; complete: boolean } {
  if (start + 1 >= value.length) return { end: value.length, complete: false };

  const escape = value[start + 1]!;
  if (escape === '\r' && value[start + 2] === '\n') return { end: start + 3, complete: true };
  if (escape === 'c') {
    const end = Math.min(start + 3, value.length);
    return { end, complete: end === start + 3 };
  }

  const maxDigits = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
  if (maxDigits > 0) {
    let end = start + 2;
    while (end < value.length && end < start + 2 + maxDigits && /[0-9A-Fa-f]/.test(value[end]!))
      end += 1;
    return { end, complete: true };
  }
  if (/[0-7]/.test(escape)) {
    let end = start + 2;
    while (end < value.length && end < start + 4 && /[0-7]/.test(value[end]!)) end += 1;
    return { end, complete: true };
  }
  return { end: start + 2, complete: true };
}

function consumeShellExpansion(value: string, start: number): { end: number; complete: boolean } {
  const opener = value[start + 1];
  if (value[start] === '`') return consumeDelimitedExpansion(value, start + 1, '`');
  if (opener === '(') return consumeDelimitedExpansion(value, start + 2, ')');
  if (opener === '{') return consumeDelimitedExpansion(value, start + 2, '}');

  let end = start + 1;
  while (end < value.length && /[A-Za-z0-9_?*#@!$-]/.test(value[end]!)) end += 1;
  return { end, complete: true };
}

function consumeDelimitedExpansion(
  value: string,
  start: number,
  closer: ')' | '}' | '`',
): { end: number; complete: boolean } {
  const closers: Array<')' | '}' | '`'> = [closer];
  let quote: "'" | '"' | undefined;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === closers.at(-1)) {
      closers.pop();
      if (closers.length === 0) return { end: index + 1, complete: true };
      continue;
    }
    if (character === '$' && value[index + 1] === '(') {
      closers.push(')');
      index += 1;
    } else if (character === '$' && value[index + 1] === '{') {
      closers.push('}');
      index += 1;
    } else if (character === '(' && closers.at(-1) === ')') {
      closers.push(')');
    } else if (character === '`') {
      closers.push('`');
    }
  }
  return { end: value.length, complete: false };
}

function shellWords(value: string): ShellWord[] {
  const words: ShellWord[] = [];
  let index = 0;
  while (index < value.length) {
    if (isShellBoundary(value[index]!)) {
      index += 1;
      continue;
    }
    if (
      value[index] === '\\' &&
      (value[index + 1] === '\n' || (value[index + 1] === '\r' && value[index + 2] === '\n')) &&
      (index === 0 || isShellBoundary(value[index - 1]!))
    ) {
      index += value[index + 1] === '\r' ? 3 : 2;
      continue;
    }
    const word = readShellWord(value, index);
    if (!word) {
      index += 1;
      continue;
    }
    words.push(word);
    index = word.end;
  }
  return words;
}

function isShellBoundary(character: string): boolean {
  return /\s|[;&|()<>]/.test(character);
}

function isShellSeparator(value: string, start: number, end: number): boolean {
  if (start === end) return false;
  return /^(?:[ \t]|\\\r?\n)+$/.test(value.slice(start, end));
}

function redactShellSecrets(value: string): string {
  const replacements: Replacement[] = [];
  const words = shellWords(value);

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const next = words[index + 1];
    if (
      shellWordCouldResolveTo(word, '--secret-access-key', 'secret-access') &&
      next &&
      isShellSeparator(value, word.end, next.start)
    ) {
      replacements.push(replacementForShellWord(value, next));
    }

    const configure = words[index + 1];
    const set = words[index + 2];
    const key = words[index + 3];
    const secret = words[index + 4];
    if (
      word.decoded === 'aws' &&
      configure?.decoded === 'configure' &&
      set?.decoded === 'set' &&
      key &&
      isShellSeparator(value, word.end, configure.start) &&
      isShellSeparator(value, configure.end, set.start) &&
      isShellSeparator(value, set.end, key.start)
    ) {
      if (isPossibleAwsConfigSecretKey(key)) {
        if (secret && isShellSeparator(value, key.end, secret.start))
          replacements.push(replacementForShellWord(value, secret));
      }
    }
  }

  collectAssignmentReplacements(value, replacements);
  return applyReplacements(value, replacements);
}

function shellWordCouldResolveTo(
  word: ShellWord,
  target: string,
  requiredStaticFragment?: string,
): boolean {
  if (word.decoded !== undefined) return word.decoded === target;
  if (!word.uncertain) return false;

  const staticText = word.staticFragments.join('');
  if (staticText.length === 0) return false;
  if (requiredStaticFragment && !staticText.includes(requiredStaticFragment)) return false;
  const first = word.staticFragments[0]!;
  const last = word.staticFragments.at(-1)!;
  if (!target.startsWith(first) || !target.endsWith(last)) return false;

  let cursor = first.length;
  const suffixStart = target.length - last.length;
  for (const fragment of word.staticFragments.slice(1, -1)) {
    const index = target.indexOf(fragment, cursor);
    if (index < 0 || index + fragment.length > suffixStart) return false;
    cursor = index + fragment.length;
  }
  return cursor <= suffixStart;
}

function isPossibleAwsConfigSecretKey(word: ShellWord): boolean {
  if (word.decoded !== undefined) return isAwsConfigSecretKey(word.decoded);
  if (!word.uncertain) return false;
  if (shellWordCouldResolveTo(word, 'aws_secret_access_key')) return true;

  const profileNames = new Set(['x']);
  for (const fragment of word.staticFragments) {
    for (const segment of fragment.match(/[A-Za-z0-9_-]+/g) ?? []) profileNames.add(segment);
  }
  for (const profileName of profileNames) {
    if (shellWordCouldResolveTo(word, `profile.${profileName}.aws_secret_access_key`)) return true;
  }
  return false;
}

function collectAssignmentReplacements(value: string, replacements: Replacement[]): void {
  const contextMachine: ShellContextMachine = {
    states: [{ index: 0, quote: undefined, expansion: undefined }],
    frames: new Map(),
    nextFrameId: 1,
    overflowed: false,
  };
  let coveredUntil = 0;
  for (const candidate of assignmentCandidates(value)) {
    const context = advanceShellQuoteContexts(value, candidate.start, contextMachine);
    if (candidate.start < coveredUntil) continue;
    const word = preferredAssignmentValue(
      value,
      candidate.valueStart,
      context.quoteContexts,
      context.overflowFallback,
    );
    if (!word) continue;
    replacements.push(replacementForShellWord(value, word));
    coveredUntil = word.end;
  }
}

function preferredAssignmentValue(
  value: string,
  start: number,
  quoteContexts: ShellQuote[],
  overflowFallback: boolean,
): ShellWord | undefined {
  const interpretations = [...new Set(quoteContexts)]
    .map((quote) => readAssignmentValue(value, start, quote))
    .filter((word): word is ShellWord => word !== undefined);
  const complete = interpretations.filter((word) => word.complete);
  const candidates = overflowFallback || complete.length === 0 ? interpretations : complete;
  return candidates.reduce<ShellWord | undefined>(
    (longest, word) => (!longest || word.end > longest.end ? word : longest),
    undefined,
  );
}

function assignmentCandidates(value: string): AssignmentCandidate[] {
  const candidate = (match: RegExpExecArray): AssignmentCandidate => ({
    start: match.index,
    valueStart: match.index + match[0].length,
  });
  return [
    ...[...value.matchAll(GENERIC_ASSIGNMENT_PATTERN)]
      .filter((match) => isAssignmentSensitiveKey(match[1]!))
      .map(candidate),
    ...[...value.matchAll(AWS_SECRET_ASSIGNMENT_PATTERN)].map(candidate),
    ...indexedAssignmentCandidates(value),
  ]
    .sort((left, right) => left.start - right.start || left.valueStart - right.valueStart)
    .filter(
      (candidate, index, sorted) =>
        index === 0 ||
        candidate.start !== sorted[index - 1]!.start ||
        candidate.valueStart !== sorted[index - 1]!.valueStart,
    );
}

function indexedAssignmentCandidates(value: string): AssignmentCandidate[] {
  const candidates: AssignmentCandidate[] = [];
  for (const match of value.matchAll(SHELL_ASSIGNMENT_KEY_PATTERN)) {
    const key = match[1]!.replace(/\\\r?\n/g, '');
    if (!isAssignmentSensitiveKey(key)) continue;

    let index = match.index + match[0].length;
    if (value[index] !== '[') continue;
    index = consumeShellAssignmentIndex(value, index);
    if (index < 0) continue;
    while (value[index] === '\\' && (value[index + 1] === '\n' || value[index + 1] === '\r')) {
      const continuation = consumeShellEscape(value, index);
      if (!continuation.complete || continuation.decoded !== undefined) break;
      index = continuation.end;
    }
    if (value[index] === '+') index += 1;
    if (value[index] !== '=') continue;
    index += 1;
    while (
      value[index] === ' ' ||
      value[index] === '\t' ||
      (value[index] === '\\' && (value[index + 1] === '\n' || value[index + 1] === '\r'))
    ) {
      if (value[index] === '\\') {
        const continuation = consumeShellEscape(value, index);
        if (!continuation.complete || continuation.decoded !== undefined) break;
        index = continuation.end;
      } else {
        index += 1;
      }
    }
    candidates.push({ start: match.index, valueStart: index });
  }
  return candidates;
}

function consumeShellAssignmentIndex(value: string, start: number): number {
  let depth = 1;
  let quote: ShellQuote;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === 'ansi') {
      if (character === "'") {
        quote = undefined;
      } else if (character === '\\') {
        index = consumeAnsiCEscape(value, index).end - 1;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === '\\') {
        index = consumeShellEscape(value, index).end - 1;
      } else if (character === '$' || character === '`') {
        index = consumeShellExpansion(value, index).end - 1;
      }
      continue;
    }
    if (character === '$' && value[index + 1] === "'") {
      quote = 'ansi';
      index += 1;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '\\') {
      index = consumeShellEscape(value, index).end - 1;
    } else if (character === '$' || character === '`') {
      index = consumeShellExpansion(value, index).end - 1;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function replacementForShellWord(value: string, word: ShellWord): Replacement {
  const raw = value.slice(word.start, word.end);
  const quote = raw.at(0);
  const replacement =
    word.complete && (quote === '"' || quote === "'") && raw.at(-1) === quote
      ? `${quote}[redacted]${quote}`
      : '[redacted]';
  return { start: word.start, end: word.end, value: replacement };
}

function applyReplacements(value: string, replacements: Replacement[]): string {
  const ordered = replacements
    .filter((replacement) => replacement.start < replacement.end)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const nonOverlapping: Replacement[] = [];
  for (const replacement of ordered) {
    const previous = nonOverlapping.at(-1);
    if (!previous || replacement.start >= previous.end) nonOverlapping.push(replacement);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of nonOverlapping) {
    parts.push(value.slice(cursor, replacement.start), replacement.value);
    cursor = replacement.end;
  }
  parts.push(value.slice(cursor));
  return parts.join('');
}

function isAwsConfigSecretKey(key: string): boolean {
  return key === 'aws_secret_access_key' || /^profile\.[^.]+\.aws_secret_access_key$/s.test(key);
}

function redactSerializedJsonSecrets(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    return undefined;
  }
  try {
    const redacted = redactJsonValue(JSON.parse(value));
    return redacted.changed ? JSON.stringify(redacted.value) : value;
  } catch {
    return undefined;
  }
}

function redactJsonValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactJsonValue(item);
      changed = changed || redacted.changed;
      return redacted.value;
    });
    return { value: next, changed };
  }
  if (typeof value === 'string') {
    const next = redactTextSecrets(value);
    return { value: next, changed: next !== value };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      next[key] = '[redacted]';
      changed = true;
      continue;
    }
    const redacted = redactJsonValue(raw);
    next[key] = redacted.value;
    changed = changed || redacted.changed;
  }
  return { value: next, changed };
}

function redactUrlQuerySecrets(value: string): string {
  return value.replace(/([?&])([^=\s&?#]+)=([^&\s#]*)/g, (match, sep: string, key: string) => {
    if (!isSensitiveKey(key)) return match;
    return `${sep}${key}=[redacted]`;
  });
}

function isSensitiveKey(key: string): boolean {
  const segments = sensitiveKeySegments(key);
  const suffix = segments.at(-1);
  if (!suffix) return false;
  if (suffix !== 'key') return SENSITIVE_KEY_SUFFIXES.has(suffix);
  if (segments.length === 1) return true;
  if (SENSITIVE_KEY_QUALIFIERS.has(segments.at(-2) ?? '')) return true;
  const qualifiedKey = segments.slice(-3).join('_');
  return qualifiedKey === 'service_account_key' || qualifiedKey === 'secret_access_key';
}

function sensitiveKeySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isAssignmentSensitiveKey(key: string): boolean {
  if (!isSensitiveKey(key)) return false;
  const suffix = sensitiveKeySegments(key).at(-1);
  return suffix !== 'auth' && suffix !== 'authorization';
}

export function generalizedErrorMessage(error: unknown, fallback = 'Operation failed'): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message);
  const lower = redacted.toLowerCase();
  if (lower.includes('timeout')) return 'Request timed out';
  if (lower.includes('429') || lower.includes('rate')) return 'Rate limit exceeded';
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth'))
    return 'Authentication failed';
  if (lower.includes('5') && /\b5\d\d\b/.test(lower)) return 'Provider returned an error';
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('econn') ||
    lower.includes('enotfound')
  )
    return 'Network error';
  return fallback;
}

/**
 * Chinese-locale companion to `generalizedErrorMessage()` (PR110b
 * follow-up). Same classification rules; returns Chinese phrasing
 * instead of English. Used by surfaces that must enforce a
 * Chinese-only error copy contract (session start, onboarding setup
 * banners, etc.) — the English version would have leaked through any
 * matched category, breaking the gate.
 *
 * The fallback default is also Chinese so callers that don't supply
 * one still produce a Chinese-only result. Pass a more specific
 * Chinese fallback (e.g. "会话已创建但发送失败，请重试。") for better
 * UX when the classifier can't categorize.
 */
export function generalizedErrorMessageChinese(error: unknown, fallback = '操作失败'): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message);
  const lower = redacted.toLowerCase();
  if (lower.includes('timeout')) return '请求超时';
  if (lower.includes('429') || lower.includes('rate')) return '触发模型速率限制';
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth')) return '鉴权失败';
  if (lower.includes('5') && /\b5\d\d\b/.test(lower)) return '模型服务返回错误';
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('econn') ||
    lower.includes('enotfound')
  )
    return '网络错误';
  return fallback;
}
