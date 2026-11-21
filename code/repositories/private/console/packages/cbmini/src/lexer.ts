// 词法分析（P04 卡步骤 2）：token 流，每阶段可 --dump-tokens
export type TokType = "kw" | "ident" | "int" | "str" | "punct" | "eof";

export interface Token {
  type: TokType;
  /** kw/ident/punct 为原文，int 为十进制文本，str 为解码后内容 */
  value: string;
  line: number;
}

const KEYWORDS = new Set(["int", "void", "if", "else", "while", "return"]);
// 长运算符在前保证最长匹配
const PUNCTS = ["==", "!=", "<=", ">=", "+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "{", "}", ";", ","];

export function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      toks.push({ type: KEYWORDS.has(word) ? "kw" : "ident", value: word, line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      toks.push({ type: "int", value: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          const e = src[j + 1];
          if (e === "n") s += "\n";
          else if (e === "t") s += "\t";
          else if (e === "\\") s += "\\";
          else if (e === '"') s += '"';
          else throw new Error(`词法错误 行${line}: 不支持的转义 \\${e}`);
          j += 2;
        } else {
          if (src[j] === "\n") break;
          s += src[j];
          j++;
        }
      }
      if (src[j] !== '"') throw new Error(`词法错误 行${line}: 字符串未闭合`);
      toks.push({ type: "str", value: s, line });
      i = j + 1;
      continue;
    }
    const p = PUNCTS.find((q) => src.startsWith(q, i));
    if (p) {
      toks.push({ type: "punct", value: p, line });
      i += p.length;
      continue;
    }
    throw new Error(`词法错误 行${line}: 意外字符 '${c}'`);
  }
  toks.push({ type: "eof", value: "", line });
  return toks;
}

export function dumpTokens(toks: Token[]): string {
  return toks.map((t) => `行${t.line}\t${t.type}\t${t.value}`).join("\n");
}
