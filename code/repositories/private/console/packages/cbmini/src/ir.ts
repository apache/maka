// 线性 IR（书 11.1 节点子集）：Stmt = Assign/CJump/Jump/LabelStmt/Return/ExprStmt
// Expr 层保持 AST 同构（本子集无需临时量），语句层线性化
import type { Expr, Program, Stmt } from "./ast.ts";

export const BUILTIN_FUNCS = new Set(["print_int", "print"]);

export type IRStmt =
  | { kind: "Assign"; dst: string; src: Expr }
  | { kind: "ExprStmt"; expr: Expr }
  | { kind: "CJump"; cond: Expr; then: string; els: string }
  | { kind: "Jump"; label: string }
  | { kind: "LabelStmt"; label: string }
  | { kind: "Return"; value: Expr | null };

export interface IRFunc {
  name: string;
  params: string[];
  lvars: string[];
  body: IRStmt[];
}

export interface IRProgram {
  funcs: IRFunc[];
}

class FuncLower {
  body: IRStmt[] = [];
  lvars: string[] = [];
  private vars = new Set<string>();
  private seq = 0;
  private defined: Set<string>;
  private name: string;

  constructor(defined: Set<string>, params: string[], name: string) {
    this.defined = defined;
    this.name = name;
    for (const p of params) this.vars.add(p);
  }

  private label(base: string): string {
    return `cf_${this.name}_${base}${this.seq++}`;
  }

  stmt(s: Stmt): void {
    switch (s.kind) {
      case "Decl": {
        if (this.vars.has(s.name)) throw new Error(`变量重复声明: ${s.name}`);
        this.vars.add(s.name);
        this.lvars.push(s.name);
        if (s.init) this.body.push({ kind: "Assign", dst: s.name, src: this.expr(s.init) });
        break;
      }
      case "Assign": {
        if (!this.vars.has(s.name)) throw new Error(`未声明变量: ${s.name}`);
        this.body.push({ kind: "Assign", dst: s.name, src: this.expr(s.value) });
        break;
      }
      case "If": {
        // 11.3：if→CJump+LabelStmt，有 else 补尾 Jump
        const thenL = this.label("then");
        const endL = this.label("end");
        const elsL = s.els ? this.label("els") : endL;
        this.body.push({ kind: "CJump", cond: this.expr(s.cond), then: thenL, els: elsL });
        this.body.push({ kind: "LabelStmt", label: thenL });
        this.stmt(s.then);
        if (s.els) {
          this.body.push({ kind: "Jump", label: endL });
          this.body.push({ kind: "LabelStmt", label: elsL });
          this.stmt(s.els);
        }
        this.body.push({ kind: "LabelStmt", label: endL });
        break;
      }
      case "While": {
        // 11.3：label(beg); CJump; body; jump(beg); label(end)
        const begL = this.label("beg");
        const bodyL = this.label("body");
        const endL = this.label("end");
        this.body.push({ kind: "LabelStmt", label: begL });
        this.body.push({ kind: "CJump", cond: this.expr(s.cond), then: bodyL, els: endL });
        this.body.push({ kind: "LabelStmt", label: bodyL });
        this.stmt(s.body);
        this.body.push({ kind: "Jump", label: begL });
        this.body.push({ kind: "LabelStmt", label: endL });
        break;
      }
      case "Return":
        this.body.push({ kind: "Return", value: s.value ? this.expr(s.value) : null });
        break;
      case "ExprStmt":
        this.body.push({ kind: "ExprStmt", expr: this.expr(s.expr) });
        break;
      case "Block":
        for (const b of s.body) this.stmt(b);
        break;
    }
  }

  expr(e: Expr): Expr {
    switch (e.kind) {
      case "Call": {
        if (!BUILTIN_FUNCS.has(e.name) && !this.defined.has(e.name))
          throw new Error(`未定义的函数: ${e.name}`);
        return { kind: "Call", name: e.name, args: e.args.map((a) => this.expr(a)) };
      }
      case "Bin": {
        // 11.4 陷阱对应的求值序约束在代码生成侧落实（右先求值压栈）
        return { kind: "Bin", op: e.op, left: this.expr(e.left), right: this.expr(e.right) };
      }
      case "Uni":
        return { kind: "Uni", op: e.op, operand: this.expr(e.operand) };
      case "Var": {
        if (!this.vars.has(e.name)) throw new Error(`未声明变量: ${e.name}`);
        return e;
      }
      default:
        return e; // Int/Str 原样
    }
  }
}

export function lower(prog: Program): IRProgram {
  const defined = new Set(prog.funcs.map((f) => f.name));
  const funcs: IRFunc[] = [];
  for (const f of prog.funcs) {
    const l = new FuncLower(defined, f.params, f.name);
    for (const s of f.body) l.stmt(s);
    funcs.push({ name: f.name, params: f.params, lvars: l.lvars, body: l.body });
  }
  return { funcs };
}

function exprStr(e: Expr): string {
  switch (e.kind) {
    case "Int":
      return `Int ${e.value}`;
    case "Str":
      return JSON.stringify(e.value);
    case "Var":
      return `Var ${e.name}`;
    case "Uni":
      return `Uni Neg (${exprStr(e.operand)})`;
    case "Bin":
      return `Bin ${e.op} (${exprStr(e.left)}, ${exprStr(e.right)})`;
    case "Call":
      return `Call ${e.name}(${e.args.map(exprStr).join(", ")})`;
  }
}

export function dumpIR(prog: IRProgram): string {
  const out: string[] = [];
  for (const f of prog.funcs) {
    out.push(`func ${f.name} params=[${f.params.join(", ")}] lvars=[${f.lvars.join(", ")}]`);
    for (const s of f.body) {
      switch (s.kind) {
        case "Assign":
          out.push(`  Assign ${s.dst} <- ${exprStr(s.src)}`);
          break;
        case "ExprStmt":
          out.push(`  ExprStmt ${exprStr(s.expr)}`);
          break;
        case "CJump":
          out.push(`  CJump cond=${exprStr(s.cond)} then=${s.then} els=${s.els}`);
          break;
        case "Jump":
          out.push(`  Jump ${s.label}`);
          break;
        case "LabelStmt":
          out.push(`  LabelStmt ${s.label}`);
          break;
        case "Return":
          out.push(`  Return${s.value ? " " + exprStr(s.value) : " void"}`);
          break;
      }
    }
  }
  return out.join("\n");
}
