import type { EditorCommand, EditorCompletionItem, EditorDiagnostic, EditorPosition, EditorRange } from "nsh/base";

// A language server for the Editor demo, simulated in the app: what a
// TypeScript server answers (symbols, hover, definitions, completion,
// inline completion, a linter's diagnostics and their quick fixes,
// document colors), found with a few regular expressions over the text.
// Each answer comes back a little later, as a real server's does over its
// connection, so the demo handles answers that arrive after the text
// changed.

/** What a name in the file is. */
export type SymbolKind = "class" | "interface" | "function" | "method" | "field" | "variable" | "constant" | "parameter";

/** A name declared in the file (or a member of one of its types). */
export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  /** Its signature, as hover shows it. */
  signature: string;
  /** Its JSDoc comment. */
  doc?: string;
  /** Where its name is declared. */
  range: EditorRange;
  /** The lines it is visible on (a function's parameters and locals);
   * everywhere without. */
  scope?: { start: number; end: number };
  /** The name of its type: what members follow a `.` after it (a
   * function's: what it returns). */
  type?: string;
  /** A function's or method's body: its first and last lines. */
  body?: { start: number; end: number };
}

/** A replacement of a range of the text. */
export interface TextEdit {
  range: EditorRange;
  text: string;
}

/** A code action: edits to apply, or an editor command to run. */
export interface CodeAction {
  title: string;
  kind: "quickfix" | "refactor" | "source";
  edits?: TextEdit[];
  command?: EditorCommand;
}

/** A diagnostic and the quick fixes that resolve it. */
export interface Problem {
  diagnostic: EditorDiagnostic;
  fixes: CodeAction[];
}

/** A color literal of the text, as `#rrggbb`. */
export interface DocumentColor {
  range: EditorRange;
  color: string;
}

/** What hover shows: Markdown, about the word at `range`. */
export interface Hover {
  markdown: string;
  range: EditorRange;
}

/** A completion request, as the editor reports it. */
export interface CompletionQuery {
  position: EditorPosition;
  query: string;
  trigger: "typing" | "character" | "invoked";
  character?: string | null;
}

const pos = (line: number, column: number): EditorPosition => ({ line, column });
const span = (line: number, start: number, end: number): EditorRange => ({ start: pos(line, start), end: pos(line, end) });

// Answers come back after a server's round trip.
const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

const KEYWORDS = [
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "interface", "let",
  "new", "null", "of", "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
  "undefined", "var", "void", "while", "yield",
];
const KEYWORD_SET = new Set(KEYWORDS);
const PRIMITIVES = ["string", "number", "boolean", "unknown", "void", "never", "any"];

/** A member of a built-in object or type. */
interface Builtin {
  name: string;
  kind: "method" | "field" | "constant";
  signature: string;
  doc: string;
  type?: string;
}

const method = (name: string, signature: string, doc: string, type?: string): Builtin => ({ name, kind: "method", signature, doc, type });
const field = (name: string, signature: string, doc: string, type?: string): Builtin => ({ name, kind: "field", signature, doc, type });

/** The globals the server knows, by name: what they are and their members. */
const GLOBALS: Record<string, { signature: string; doc: string; members: Builtin[] }> = {
  console: {
    signature: "var console: Console",
    doc: "The console of the runtime: messages for the developer.",
    members: [
      method("log", "(method) Console.log(...data: any[]): void", "Prints its arguments, separated by spaces."),
      method("info", "(method) Console.info(...data: any[]): void", "Prints an informational message."),
      method("warn", "(method) Console.warn(...data: any[]): void", "Prints a warning."),
      method("error", "(method) Console.error(...data: any[]): void", "Prints an error."),
      method("table", "(method) Console.table(data: any): void", "Prints an array or object as a table."),
    ],
  },
  Math: {
    signature: "var Math: Math",
    doc: "Mathematical constants and functions.",
    members: [
      method("abs", "(method) Math.abs(x: number): number", "The absolute value of `x`.", "number"),
      method("ceil", "(method) Math.ceil(x: number): number", "The smallest integer at least `x`.", "number"),
      method("floor", "(method) Math.floor(x: number): number", "The largest integer at most `x`.", "number"),
      method("max", "(method) Math.max(...values: number[]): number", "The largest of the values.", "number"),
      method("min", "(method) Math.min(...values: number[]): number", "The smallest of the values.", "number"),
      method("random", "(method) Math.random(): number", "A pseudo-random number from 0 up to 1.", "number"),
      method("round", "(method) Math.round(x: number): number", "`x` rounded to the nearest integer.", "number"),
      method("sqrt", "(method) Math.sqrt(x: number): number", "The square root of `x`.", "number"),
      { name: "PI", kind: "constant", signature: "(property) Math.PI: number", doc: "The ratio of a circle's circumference to its diameter.", type: "number" },
    ],
  },
  JSON: {
    signature: "var JSON: JSON",
    doc: "Converts values to and from JSON.",
    members: [
      method("parse", "(method) JSON.parse(text: string): any", "The value the JSON text describes."),
      method("stringify", "(method) JSON.stringify(value: any, replacer?: null, space?: number): string", "The value as JSON text.", "string"),
    ],
  },
};

/** The members of the built-in types. */
const STRING: Builtin[] = [
  field("length", "(property) String.length: number", "The number of UTF-16 code units.", "number"),
  method("includes", "(method) String.includes(search: string): boolean", "Whether `search` is in the string.", "boolean"),
  method("padStart", "(method) String.padStart(length: number, fill?: string): string", "The string padded at its start to `length`.", "string"),
  method("split", "(method) String.split(separator: string): string[]", "The parts between the separators.", "string[]"),
  method("toLowerCase", "(method) String.toLowerCase(): string", "The string in lower case.", "string"),
  method("toUpperCase", "(method) String.toUpperCase(): string", "The string in upper case.", "string"),
  method("trim", "(method) String.trim(): string", "The string without the whitespace around it.", "string"),
];
const NUMBER: Builtin[] = [
  method("toFixed", "(method) Number.toFixed(digits?: number): string", "The number with `digits` digits after the point.", "string"),
  method("toString", "(method) Number.toString(radix?: number): string", "The number as text.", "string"),
];
const array = (item: string): Builtin[] => [
  field("length", "(property) Array<T>.length: number", "The number of elements.", "number"),
  method("filter", `(method) Array<${item}>.filter(predicate: (value: ${item}) => boolean): ${item}[]`, "The elements the predicate keeps.", `${item}[]`),
  method("find", `(method) Array<${item}>.find(predicate: (value: ${item}) => boolean): ${item} | undefined`, "The first element the predicate takes.", item),
  method("forEach", `(method) Array<${item}>.forEach(callback: (value: ${item}) => void): void`, "Calls `callback` for each element."),
  method("includes", `(method) Array<${item}>.includes(value: ${item}): boolean`, "Whether `value` is an element.", "boolean"),
  method("join", `(method) Array<${item}>.join(separator?: string): string`, "The elements as text, between separators.", "string"),
  method("map", `(method) Array<${item}>.map<U>(callback: (value: ${item}) => U): U[]`, "The callback's results, in order."),
  method("push", `(method) Array<${item}>.push(...items: ${item}[]): number`, "Adds the items at the end; the new length.", "number"),
  method("reduce", `(method) Array<${item}>.reduce<U>(callback: (sum: U, value: ${item}) => U, initial: U): U`, "Folds the elements into one value."),
];

/** A snippet of the completion list. */
const SNIPPETS: EditorCompletionItem[] = [
  { label: "forof", kind: "snippet", detail: "for … of loop", insertText: "for (const item of items) {\n  \n}", documentation: "Loops over the elements of an array." },
  { label: "log", kind: "snippet", detail: "console.log()", insertText: "console.log();", documentation: "Prints to the console." },
  { label: "fn", kind: "snippet", detail: "function declaration", insertText: "function name() {\n  \n}", documentation: "Declares a function." },
  { label: "iife", kind: "snippet", detail: "immediately invoked function", insertText: "(() => {\n  \n})();", documentation: "Runs a function in place." },
];

/** The word around `column` of `line`. */
export function wordAt(line: string, column: number): { word: string; start: number; end: number } | null {
  let start = column;
  while (start > 0 && /[\w$]/.test(line[start - 1])) start--;
  let end = column;
  while (end < line.length && /[\w$]/.test(line[end])) end++;
  if (start === end || /\d/.test(line[start])) return null;
  return { word: line.slice(start, end), start, end };
}

/**
 * The text with string literals and comments blanked out (their
 * characters as spaces, the line breaks kept), so the rules below look at
 * code only.
 */
function mask(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") (out += " "), i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
    } else if (c === '"' || c === "'" || c === "`") {
      out += " ";
      i++;
      while (i < text.length && text[i] !== c && (c === "`" || text[i] !== "\n")) {
        if (text[i] === "\\") (out += " "), i++;
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < text.length && text[i] === c) (out += " "), i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The line of the `}` closing the block opened on line `start`. */
function blockEnd(code: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let line = start; line < code.length; line++) {
    for (const c of code[line]) {
      if (c === "{") (depth++, (opened = true));
      else if (c === "}") depth--;
    }
    if (opened && depth <= 0) return line;
  }
  return code.length - 1;
}

/** A function's parameters: `name: type` pairs. */
function parameters(list: string): { name: string; type: string; column: number }[] {
  const out: { name: string; type: string; column: number }[] = [];
  let column = 0;
  for (const part of list.split(",")) {
    const m = /^(\s*)([A-Za-z_$][\w$]*)\??\s*(?::\s*(.+?))?\s*$/.exec(part);
    if (m) out.push({ name: m[2], type: m[3] ?? "any", column: column + m[1].length });
    column += part.length + 1;
  }
  return out;
}

/** What the server knows of the file. */
interface Model {
  lines: string[];
  /** `lines` with strings and comments blanked out. */
  code: string[];
  symbols: SymbolInfo[];
  /** The file's classes and interfaces, by name: their members. */
  types: Map<string, { symbol: SymbolInfo; members: SymbolInfo[]; start: number; end: number }>;
  /** Lines that declare a method (whose names are no calls). */
  declarations: Set<number>;
}

/** Reads the file's declarations. */
function analyze(text: string): Model {
  const lines = text.split("\n");
  const code = mask(text).split("\n");
  const symbols: SymbolInfo[] = [];
  const types: Model["types"] = new Map();
  const declarations = new Set<number>();
  const functions: { start: number; end: number }[] = [];
  // The JSDoc comment right above line `line`.
  const docAbove = (line: number) => {
    const m = /^\s*\/\*\*\s*(.*?)\s*\*\/\s*$/.exec(lines[line - 1] ?? "");
    return m ? m[1] : undefined;
  };

  for (let line = 0; line < lines.length; line++) {
    const source = lines[line];
    let m: RegExpExecArray | null;
    if ((m = /^(\s*(?:export\s+)?)(interface|class)\s+([A-Za-z_$][\w$]*)/.exec(code[line]))) {
      const kind = m[2] as "interface" | "class";
      const name = m[3];
      const column = m[1].length + kind.length + 1;
      const end = blockEnd(code, line);
      const signature = kind === "interface" ? lines.slice(line, end + 1).join("\n").replace(/^export\s+/, "") : `class ${name}`;
      const symbol: SymbolInfo = { name, kind, signature, doc: docAbove(line), range: span(line, column, column + name.length) };
      symbols.push(symbol);
      const members: SymbolInfo[] = [];
      for (let inner = line + 1; inner < end; inner++) {
        const doc = docAbove(inner);
        let f: RegExpExecArray | null;
        if ((f = /^(\s+)([A-Za-z_$][\w$]*)\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/.exec(code[inner]))) {
          const ret = f[4] ?? "void";
          const params = lines[inner].slice(f[1].length + f[2].length + 1, f[1].length + f[2].length + 1 + f[3].length);
          const start = f[1].length;
          const methodEnd = blockEnd(code, inner);
          members.push({ name: f[2], kind: "method", signature: `(method) ${name}.${f[2]}(${params}): ${ret}`, doc, range: span(inner, start, start + f[2].length), type: ret, body: { start: inner, end: methodEnd } });
          declarations.add(inner);
          functions.push({ start: inner, end: methodEnd });
          for (const p of parameters(params)) {
            const at = start + f[2].length + 1 + p.column;
            symbols.push({ name: p.name, kind: "parameter", signature: `(parameter) ${p.name}: ${p.type}`, range: span(inner, at, at + p.name.length), scope: { start: inner, end: methodEnd }, type: p.type });
          }
        } else if ((f = /^(\s+)([A-Za-z_$][\w$]*)(\??)\s*:\s*([^=;]+?)\s*(?:=.*)?;/.exec(lines[inner]))) {
          const start = f[1].length;
          members.push({ name: f[2], kind: "field", signature: `(property) ${name}.${f[2]}${f[3]}: ${f[4]}`, doc, range: span(inner, start, start + f[2].length), type: f[4] });
        }
      }
      types.set(name, { symbol, members, start: line, end });
    } else if ((m = /^(\s*(?:export\s+)?(?:async\s+)?function\s+)([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/.exec(code[line]))) {
      const name = m[2];
      const column = m[1].length;
      const ret = m[4] ?? "void";
      const open = column + name.length + 1;
      const params = source.slice(open, open + m[3].length);
      const end = blockEnd(code, line);
      functions.push({ start: line, end });
      symbols.push({ name, kind: "function", signature: `function ${name}(${params}): ${ret}`, doc: docAbove(line), range: span(line, column, column + name.length), type: ret, body: { start: line, end } });
      for (const p of parameters(params)) {
        const at = open + p.column;
        symbols.push({ name: p.name, kind: "parameter", signature: `(parameter) ${p.name}: ${p.type}`, range: span(line, at, at + p.name.length), scope: { start: line, end }, type: p.type });
      }
    }
  }

  // Variables, once the functions (their scopes) are known.
  const returns = (name: string) => symbols.find((s) => s.kind === "function" && s.name === name)?.type;
  for (let line = 0; line < lines.length; line++) {
    const re = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([\w$[\]<>|]+))?\s*=\s*(.*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code[line]))) {
      const [, keyword, name, annotation] = m;
      const value = lines[line].slice(m.index + m[0].length - m[4].length).trim();
      let type: string | undefined = annotation;
      let shown: string | undefined;
      let call: RegExpExecArray | null;
      if (!type) {
        if ((call = /^new\s+([A-Za-z_$][\w$]*)/.exec(value))) type = call[1];
        else if (/^["'`]/.test(value)) {
          type = "string";
          if (keyword === "const") shown = value.replace(/;$/, "");
        } else if (/^-?\d/.test(value)) type = "number";
        else if (/^(true|false)\b/.test(value)) type = "boolean";
        else if ((call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(value))) type = returns(call[1]);
      }
      const column = m.index + m[0].indexOf(name, keyword.length);
      const scope = functions.filter((f) => f.start <= line && line <= f.end).sort((a, b) => b.start - a.start)[0];
      symbols.push({
        name,
        kind: keyword === "const" && /^[A-Z][A-Z0-9_]+$/.test(name) ? "constant" : "variable",
        signature: `${keyword} ${name}: ${shown ?? type ?? "any"}`,
        doc: docAbove(line),
        range: span(line, column, column + name.length),
        scope,
        type,
      });
    }
  }
  return { lines, code, symbols, types, declarations };
}

/** The symbol `name` means on line `line`: the innermost one visible there. */
function lookup(model: Model, name: string, line: number): SymbolInfo | undefined {
  let found: SymbolInfo | undefined;
  for (const s of model.symbols) {
    if (s.name !== name) continue;
    if (s.scope && (line < s.scope.start || line > s.scope.end)) continue;
    if (!found || (s.scope && (!found.scope || s.scope.start >= found.scope.start))) found = s;
  }
  return found;
}

/** The members after a `.` on a value of `type`. */
function membersOf(model: Model, type: string | undefined): (SymbolInfo | Builtin)[] {
  if (!type) return [];
  const t = type.trim();
  if (t.endsWith("[]")) return array(t.slice(0, -2));
  if (t === "string" || /^["'`]/.test(t)) return STRING;
  if (t === "number") return NUMBER;
  if (t.startsWith("global:")) return GLOBALS[t.slice(7)]?.members ?? [];
  return model.types.get(t)?.members ?? [];
}

/** The type of the expression before the `.` at `dot` on `line`: `this`, a
 * name and members after it (`this.lines`, `order.items`). */
function receiverType(model: Model, line: number, dot: number): string | undefined {
  const before = (model.code[line] ?? "").slice(0, dot);
  const m = /((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*$/.exec(before);
  if (!m) return undefined;
  const [first, ...rest] = m[1].split(".").map((w) => w.trim());
  let type: string | undefined;
  if (first === "this") {
    for (const [name, t] of model.types) if (t.symbol.kind === "class" && t.start <= line && line <= t.end) type = name;
  } else if (lookup(model, first, line)) type = lookup(model, first, line)?.type;
  else if (GLOBALS[first]) type = `global:${first}`;
  for (const word of rest) type = membersOf(model, type).find((member) => member.name === word)?.type;
  return type;
}

/** The type name `receiverType` found, as messages say it. */
const typeName = (type: string) => (type.startsWith("global:") ? type.slice(7) : type);

/** The name in `names` closest to `word`, if it is close enough to be a typo. */
function closest(word: string, names: Iterable<string>): string | undefined {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  };
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(word.length / 3)) + 1;
  for (const name of names) {
    const d = distance(word.toLowerCase(), name.toLowerCase());
    if (d < bestDistance) (best = name), (bestDistance = d);
  }
  return best;
}

/** The linter: the problems of the file and their fixes. */
function lint(model: Model): Problem[] {
  const { lines, code } = model;
  const problems: Problem[] = [];
  const text = lines.join("\n");
  const problem = (
    range: EditorRange,
    severity: EditorDiagnostic["severity"],
    message: string,
    source: string,
    code: string | undefined,
    fixes: CodeAction[] = [],
    tags?: EditorDiagnostic["tags"],
  ) => {
    const diagnostic: EditorDiagnostic = { range, severity, message, source, code };
    // ESLint's rules each have a page.
    if (source === "eslint" && code) diagnostic.codeDescription = { href: `https://eslint.org/docs/latest/rules/${code}` };
    if (tags) diagnostic.tags = tags;
    problems.push({ diagnostic, fixes });
  };
  const replace = (title: string, range: EditorRange, by: string): CodeAction => ({ title, kind: "quickfix", edits: [{ range, text: by }] });

  for (let line = 0; line < lines.length; line++) {
    let m: RegExpExecArray | null;
    // A TODO left in a comment.
    if ((m = /\/\/\s*((?:TODO|FIXME)\b:?\s*(.*))$/.exec(lines[line])) && code[line].slice(m.index).trim() === "") {
      const start = m.index + m[0].length - m[1].length;
      problem(span(line, start, lines[line].length), "info", m[1], "todo", undefined, [
        { title: "Remove the TODO comment", kind: "quickfix", edits: [{ range: span(line, lines[line].slice(0, m.index).trimEnd().length, lines[line].length), text: "" }] },
      ]);
    }
    // `var` instead of `let` or `const`.
    const vars = /\bvar\b/g;
    while ((m = vars.exec(code[line]))) {
      const range = span(line, m.index, m.index + 3);
      problem(range, "warning", "Unexpected var, use let or const instead.", "eslint", "no-var", [replace("Replace 'var' with 'let'", range, "let"), replace("Replace 'var' with 'const'", range, "const")]);
    }
    // `==` and `!=`, which convert their operands.
    const loose = /(?<![=!<>])(==|!=)(?!=)/g;
    while ((m = loose.exec(code[line]))) {
      const range = span(line, m.index, m.index + 2);
      const strict = `${m[1]}=`;
      problem(range, "warning", `Expected '${strict}' and instead saw '${m[1]}'.`, "eslint", "eqeqeq", [replace(`Replace '${m[1]}' with '${strict}'`, range, strict)]);
    }
    // Members that are not there, after `this`, a name of a known type or
    // a global.
    const access = /\.\s*([A-Za-z_$][\w$]*)/g;
    while ((m = access.exec(code[line]))) {
      const type = receiverType(model, line, m.index);
      const members = membersOf(model, type);
      if (!type || members.length === 0 || members.some((member) => member.name === m![1])) continue;
      const start = m.index + m[0].length - m[1].length;
      const range = span(line, start, start + m[1].length);
      const guess = closest(m[1], members.map((member) => member.name));
      const message = `Property '${m[1]}' does not exist on type '${typeName(type)}'.${guess ? ` Did you mean '${guess}'?` : ""}`;
      problem(range, "error", message, "ts", guess ? "2551" : "2339", guess ? [replace(`Change spelling to '${guess}'`, range, guess)] : []);
    }
    // Calls of names declared nowhere.
    if (!model.declarations.has(line)) {
      const calls = /(?<![\w$.]\s*)\b([A-Za-z_$][\w$]*)\s*\(/g;
      while ((m = calls.exec(code[line]))) {
        const name = m[1];
        if (KEYWORD_SET.has(name) || GLOBALS[name] || lookup(model, name, line) || /\bfunction\s+$/.test(code[line].slice(0, m.index))) continue;
        if (["String", "Number", "Boolean", "Array", "Object", "Date", "Promise", "setTimeout", "parseInt", "parseFloat"].includes(name)) continue;
        const start = m.index + m[0].indexOf(name);
        const range = span(line, start, start + name.length);
        const guess = closest(name, model.symbols.filter((s) => s.kind === "function").map((s) => s.name));
        problem(range, "error", `Cannot find name '${name}'.${guess ? ` Did you mean '${guess}'?` : ""}`, "ts", "2304", guess ? [replace(`Change spelling to '${guess}'`, range, guess)] : []);
      }
    }
  }

  // Variables declared and never read.
  for (const s of model.symbols) {
    if (s.kind !== "variable" && s.kind !== "constant") continue;
    const uses = text.match(new RegExp(`(?<![\\w$.])${s.name.replace(/\$/g, "\\$")}(?![\\w$])`, "g"))?.length ?? 0;
    if (uses > 1) continue;
    const line = s.range.start.line;
    const next = line + 1 < lines.length ? pos(line + 1, 0) : pos(line, lines[line].length);
    problem(s.range, "warning", `'${s.name}' is declared but its value is never read.`, "ts", "6133", [
      { title: `Remove unused declaration '${s.name}'`, kind: "quickfix", edits: [{ range: { start: pos(line, 0), end: next }, text: "" }] },
    ], ["unnecessary"]);
  }
  return problems.sort((a, b) => a.diagnostic.range.start.line - b.diagnostic.range.start.line || a.diagnostic.range.start.column - b.diagnostic.range.start.column);
}

const kindOf = (kind: SymbolKind | Builtin["kind"]): EditorCompletionItem["kind"] => (kind === "parameter" ? "variable" : kind);

/** The simulated server: one file, kept up to date by `change`. */
export class LanguageServer {
  private text = "";
  private cached: Model | undefined;

  private get model(): Model {
    return (this.cached ??= analyze(this.text));
  }

  /** The file's new text (`textDocument/didChange`). */
  change(text: string) {
    if (text === this.text) return;
    this.text = text;
    this.cached = undefined;
  }

  /** The file's problems (`textDocument/publishDiagnostics`). */
  diagnostics(): Promise<Problem[]> {
    return later(40, lint(this.model));
  }

  /** The hex color literals of the file (`textDocument/documentColor`). */
  colors(): Promise<DocumentColor[]> {
    const out: DocumentColor[] = [];
    this.model.lines.forEach((text, line) => {
      const re = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w$])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        let hex = m[0].slice(1).toLowerCase();
        if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
        out.push({ range: span(line, m.index, m.index + m[0].length), color: `#${hex}` });
      }
    });
    return later(30, out);
  }

  /** The symbol at `position`, and the range of its word. */
  private symbolAt(position: EditorPosition): { symbol?: SymbolInfo | Builtin; global?: string; range: EditorRange } | null {
    const model = this.model;
    const lineText = model.code[position.line] ?? "";
    const w = wordAt(lineText, position.column);
    if (!w || KEYWORD_SET.has(w.word)) return null;
    const range = span(position.line, w.start, w.end);
    const before = lineText.slice(0, w.start).trimEnd();
    if (before.endsWith(".")) {
      const type = receiverType(model, position.line, before.length - 1);
      return { symbol: membersOf(model, type).find((member) => member.name === w.word), range };
    }
    // A member's own declaration.
    for (const t of model.types.values()) {
      const member = t.members.find((s) => s.range.start.line === position.line && s.range.start.column === w.start);
      if (member) return { symbol: member, range };
    }
    const symbol = lookup(model, w.word, position.line);
    if (symbol) return { symbol, range };
    if (GLOBALS[w.word]) return { global: w.word, range };
    return null;
  }

  /** What hover shows at `position` (`textDocument/hover`). */
  hover(position: EditorPosition): Promise<Hover | null> {
    const found = this.symbolAt(position);
    let hover: Hover | null = null;
    if (found?.global) {
      const g = GLOBALS[found.global];
      hover = { markdown: `\`\`\`typescript\n${g.signature}\n\`\`\`\n\n${g.doc}`, range: found.range };
    } else if (found?.symbol) {
      const s = found.symbol;
      hover = { markdown: `\`\`\`typescript\n${s.signature}\n\`\`\`${s.doc ? `\n\n${s.doc}` : ""}`, range: found.range };
    }
    return later(25, hover);
  }

  /** Where the symbol at `position` is declared (`textDocument/definition`):
   * `null` for what the file does not declare. */
  definition(position: EditorPosition): Promise<{ name: string; range: EditorRange } | null> {
    const found = this.symbolAt(position);
    const s = found?.symbol;
    return later(30, s && "range" in s ? { name: s.name, range: s.range } : null);
  }

  /** The completion items at `position` (`textDocument/completion`). */
  completion(request: CompletionQuery): Promise<{ items: EditorCompletionItem[]; incomplete: boolean }> {
    const model = this.model;
    const { line, column } = request.position;
    const queryStart = column - request.query.length;
    const code = model.code[line] ?? "";
    const before = code.slice(0, queryStart);
    const none = later(30, { items: [] as EditorCompletionItem[], incomplete: false });
    // Nothing in strings and comments: their characters are blanked out.
    if (queryStart > 0 && code[queryStart - 1] === " " && (model.lines[line] ?? "")[queryStart - 1] !== " ") return none;

    let items: EditorCompletionItem[];
    const member = request.character === "." || before.trimEnd().endsWith(".");
    if (member) {
      const dot = before.trimEnd().length - 1;
      items = membersOf(model, receiverType(model, line, dot)).map((m) => ({
        label: m.name,
        kind: kindOf(m.kind),
        detail: m.signature,
        documentation: m.doc,
        sortText: `0${m.name}`,
      }));
    } else if (/(?::|\bas|\bextends|\bimplements)\s*$/.test(before)) {
      // A type is expected.
      items = [
        ...[...model.types.values()].map(({ symbol }) => ({ label: symbol.name, kind: kindOf(symbol.kind), detail: symbol.kind === "class" ? symbol.signature : `interface ${symbol.name}`, documentation: symbol.doc, sortText: `0${symbol.name}` })),
        ...PRIMITIVES.map((p) => ({ label: p, kind: "keyword" as const, sortText: `1${p}` })),
      ];
    } else if (/\bnew\s+$/.test(before)) {
      items = [...model.types.values()].filter((t) => t.symbol.kind === "class").map(({ symbol }) => ({ label: symbol.name, kind: "class", detail: symbol.signature, documentation: symbol.doc }));
    } else {
      // The names visible here, the globals, the keywords and the snippets.
      const seen = new Map<string, EditorCompletionItem>();
      for (const s of model.symbols) {
        if (s.scope && (line < s.scope.start || line > s.scope.end)) continue;
        if (s.range.start.line === line && s.range.start.column === queryStart) continue;
        const visible = lookup(model, s.name, line) === s;
        if (!visible) continue;
        seen.set(s.name, { label: s.name, kind: kindOf(s.kind), detail: s.signature, documentation: s.doc, sortText: `${s.scope ? 0 : 1}${s.name}` });
      }
      items = [
        ...seen.values(),
        ...Object.entries(GLOBALS).map(([name, g]) => ({ label: name, kind: "module" as const, detail: g.signature, documentation: g.doc, sortText: `2${name}` })),
        ...KEYWORDS.map((k) => ({ label: k, kind: "keyword" as const, sortText: `3${k}` })),
        ...SNIPPETS.map((s) => ({ ...s, sortText: `4${s.label}` })),
      ];
    }
    // A first cut, as servers make; the editor ranks and filters the rest
    // as the query grows.
    const query = request.query.toLowerCase();
    if (query) items = items.filter((item) => (item.filterText ?? item.label).toLowerCase().startsWith(query[0]));
    return later(member ? 30 : 60, { items, incomplete: false });
  }

  /** The rest of the line to suggest after `position`, shown as ghost text
   * (`textDocument/inlineCompletion`). */
  inlineCompletion(position: EditorPosition): Promise<string | null> {
    const model = this.model;
    const text = model.lines[position.line] ?? "";
    const before = text.slice(0, position.column);
    let suggestion: string | null = null;
    if (text.slice(position.column).trim() === "") {
      // The function or method the caret is in: what it returns.
      const inside = (s: SymbolInfo) => s.body !== undefined && s.body.start <= position.line && position.line <= s.body.end;
      const enclosing = [...model.symbols, ...[...model.types.values()].flatMap((t) => t.members)].filter(inside).sort((a, b) => b.body!.start - a.body!.start)[0];
      const rules: [RegExp, () => string | null][] = [
        [/^\s*function\s+[A-Za-z_$][\w$]*$/, () => "(order: Order): number {\n  return 0;\n}"],
        [/^\s*for\s?$/, () => `${before.endsWith(" ") ? "" : " "}(const item of order.items) {`],
        [/^\s*if\s?$/, () => `${before.endsWith(" ") ? "" : " "}(order.coupon === "SAVE10") {`],
        [/\bconsole\.$/, () => "log(label);"],
        [/^\s*receipt\.$/, () => "add(label);"],
        [/^\s*\/\/\s*TODO$/, () => ": "],
        [/^\s*const total = $/, () => "subtotal(order);"],
        [/^\s*return\s?$/, () => {
          const type = enclosing?.type;
          const value = type === "number" ? "0" : type === "string" ? "`#${order.id}`" : type === "boolean" ? "false" : null;
          return value === null ? null : `${before.endsWith(" ") ? "" : " "}${value};`;
        }],
      ];
      for (const [re, make] of rules) if (re.test(before)) {
        suggestion = make();
        break;
      }
    }
    return later(50, suggestion);
  }

  /**
   * The code actions at `range` (`textDocument/codeAction`): the fixes of
   * the problems there (at the caret, else on its line), and the editor's
   * own refactorings of the selection and the lines.
   */
  codeActions(range: EditorRange, problems: Problem[]): Promise<CodeAction[]> {
    const before = (a: EditorPosition, b: EditorPosition) => a.line < b.line || (a.line === b.line && a.column <= b.column);
    const at = problems.filter((p) => before(p.diagnostic.range.start, range.end) && before(range.start, p.diagnostic.range.end));
    const onLine = at.length > 0 ? at : problems.filter((p) => p.diagnostic.range.start.line <= range.start.line && range.start.line <= p.diagnostic.range.end.line);
    const actions: CodeAction[] = onLine.flatMap((p) => p.fixes);
    const selected = range.start.line !== range.end.line || range.start.column !== range.end.column;
    if (selected) {
      actions.push(
        { title: "Convert to Uppercase", kind: "refactor", command: "transformToUppercase" },
        { title: "Convert to Lowercase", kind: "refactor", command: "transformToLowercase" },
        { title: "Convert to Title Case", kind: "refactor", command: "transformToTitleCase" },
      );
    }
    if (range.start.line !== range.end.line) {
      actions.push({ title: "Sort Lines Ascending", kind: "refactor", command: "sortLinesAscending" }, { title: "Sort Lines Descending", kind: "refactor", command: "sortLinesDescending" });
    }
    actions.push({ title: "Toggle Line Comment", kind: "source", command: "toggleComment" }, { title: "Trim Trailing Whitespace", kind: "source", command: "trimTrailingWhitespace" });
    return later(20, actions);
  }
}
