// 语法分析（P04 卡步骤 2）：手写递归下降，优先级分层（书 3.1 的 LL 思想）
import type { Expr, FuncDef, Program, Stmt, BinOp } from "./ast.ts";
import type { Token } from "./lexer.ts";

// 优先级从低到高：equality → relational → additive → multiplicative
const BIN_LEVELS: string[][] = [["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];

class Parser {
  private i = 0;
  private toks: Token[];
  constructor(toks: Token[]) {
    this.toks = toks;
  }
  private peek(k = 0): Token {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)]!;
  }
  private next(): Token {
    return this.toks[this.i++]!;
  }
  private at(type: string, value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  private eat(type: string, value?: string): Token {
    if (!this.at(type, value)) this.fail(`期望 ${value ?? type}`);
    return this.next();
  }
  private eatIf(value: string): boolean {
    if (this.at("punct", value)) {
      this.i++;
      return true;
    }
    return false;
  }
  private fail(msg: string): never {
    const t = this.peek();
    throw new Error(`语法错误 行${t.line}: ${msg}，实际是 '${t.value || "<EOF>"}'`);
  }

  parseProgram(): Program {
    const funcs: FuncDef[] = [];
    while (!this.at("eof")) {
      this.eat("kw", "int");
      const name = this.eat("ident").value;
      this.eat("punct", "(");
      const params: string[] = [];
      if (this.at("kw", "void")) {
        this.next();
      } else if (!this.at("punct", ")")) {
        do {
          this.eat("kw", "int");
          params.push(this.eat("ident").value);
        } while (this.eatIf(","));
      }
      this.eat("punct", ")");
      funcs.push({ name, params, body: this.parseBlockBody() });
    }
    return { funcs };
  }

  private parseBlockBody(): Stmt[] {
    this.eat("punct", "{");
    const body: Stmt[] = [];
    while (!this.at("punct", "}")) body.push(this.parseStmt());
    this.eat("punct", "}");
    return body;
  }

  private parseStmt(): Stmt {
    if (this.at("kw", "int")) {
      this.next();
      const name = this.eat("ident").value;
      let init: Expr | null = null;
      if (this.eatIf("=")) init = this.parseExpr();
      this.eat("punct", ";");
      return { kind: "Decl", name, init };
    }
    if (this.at("kw", "if")) {
      this.next();
      this.eat("punct", "(");
      const cond = this.parseExpr();
      this.eat("punct", ")");
      const then = this.parseStmt();
      let els: Stmt | null = null;
      if (this.at("kw", "else")) {
        this.next();
        els = this.parseStmt();
      }
      return { kind: "If", cond, then, els };
    }
    if (this.at("kw", "while")) {
      this.next();
      this.eat("punct", "(");
      const cond = this.parseExpr();
      this.eat("punct", ")");
      return { kind: "While", cond, body: this.parseStmt() };
    }
    if (this.at("kw", "return")) {
      this.next();
      const value = this.at("punct", ";") ? null : this.parseExpr();
      this.eat("punct", ";");
      return { kind: "Return", value };
    }
    if (this.at("punct", "{")) return { kind: "Block", body: this.parseBlockBody() };
    if (this.eatIf(";")) return { kind: "Block", body: [] };
    // 赋值与表达式语句共用 ident 开头，IDENT "=" 分流
    if (this.at("ident") && this.peek(1).type === "punct" && this.peek(1).value === "=") {
      const name = this.next().value;
      this.next(); // '='
      const value = this.parseExpr();
      this.eat("punct", ";");
      return { kind: "Assign", name, value };
    }
    const expr = this.parseExpr();
    this.eat("punct", ";");
    return { kind: "ExprStmt", expr };
  }

  private parseExpr(): Expr {
    return this.parseBin(0);
  }
  private parseBin(level: number): Expr {
    if (level >= BIN_LEVELS.length) return this.parseUnary();
    let left = this.parseBin(level + 1);
    while (this.at("punct") && BIN_LEVELS[level]!.includes(this.peek().value)) {
      const op = this.next().value as BinOp;
      const right = this.parseBin(level + 1);
      left = { kind: "Bin", op, left, right };
    }
    return left;
  }
  private parseUnary(): Expr {
    if (this.at("punct", "-")) {
      this.next();
      return { kind: "Uni", op: "Neg", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Expr {
    if (this.at("int")) return { kind: "Int", value: Number(this.next().value) };
    if (this.at("str")) return { kind: "Str", value: this.next().value };
    if (this.eatIf("(")) {
      const e = this.parseExpr();
      this.eat("punct", ")");
      return e;
    }
    if (this.at("ident")) {
      const name = this.next().value;
      if (this.eatIf("(")) {
        const args: Expr[] = [];
        if (!this.at("punct", ")")) {
          do {
            args.push(this.parseExpr());
          } while (this.eatIf(","));
        }
        this.eat("punct", ")");
        return { kind: "Call", name, args };
      }
      return { kind: "Var", name };
    }
    this.fail("期望表达式");
  }
}

export function parse(toks: Token[]): Program {
  return new Parser(toks).parseProgram();
}

export function dumpAST(prog: Program): string {
  const out: string[] = [];
  const p = (ind: number, line: string) => out.push("  ".repeat(ind) + line);
  const expr = (e: Expr, ind: number) => {
    switch (e.kind) {
      case "Int":
        p(ind, `Int ${e.value}`);
        break;
      case "Str":
        p(ind, `Str "${e.value}"`);
        break;
      case "Var":
        p(ind, `Var ${e.name}`);
        break;
      case "Uni":
        p(ind, `Uni ${e.op}`);
        expr(e.operand, ind + 1);
        break;
      case "Bin":
        p(ind, `Bin ${e.op}`);
        expr(e.left, ind + 1);
        expr(e.right, ind + 1);
        break;
      case "Call":
        p(ind, `Call ${e.name}`);
        for (const a of e.args) expr(a, ind + 1);
        break;
    }
  };
  const stmt = (s: Stmt, ind: number) => {
    switch (s.kind) {
      case "Decl":
        p(ind, `Decl ${s.name}${s.init ? " =" : ""}`);
        if (s.init) expr(s.init, ind + 1);
        break;
      case "Assign":
        p(ind, `Assign ${s.name}`);
        expr(s.value, ind + 1);
        break;
      case "If":
        p(ind, "If");
        expr(s.cond, ind + 1);
        stmt(s.then, ind + 1);
        if (s.els) {
          p(ind, "Else");
          stmt(s.els, ind + 1);
        }
        break;
      case "While":
        p(ind, "While");
        expr(s.cond, ind + 1);
        stmt(s.body, ind + 1);
        break;
      case "Return":
        p(ind, `Return${s.value ? "" : " void"}`);
        if (s.value) expr(s.value, ind + 1);
        break;
      case "ExprStmt":
        p(ind, "ExprStmt");
        expr(s.expr, ind + 1);
        break;
      case "Block":
        p(ind, "Block");
        for (const b of s.body) stmt(b, ind + 1);
        break;
    }
  };
  for (const f of prog.funcs) {
    p(0, `FuncDef ${f.name}(${f.params.join(", ")})`);
    for (const s of f.body) stmt(s, 1);
  }
  return out.join("\n");
}
