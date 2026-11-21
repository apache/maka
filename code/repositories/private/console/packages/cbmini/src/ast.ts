// AST 节点：TS 判别联合（卡【现代扩展】record+sealed 的 TS 形态）
export type BinOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=";

export type Expr =
  | { kind: "Int"; value: number }
  | { kind: "Str"; value: string }
  | { kind: "Var"; name: string }
  | { kind: "Uni"; op: "Neg"; operand: Expr }
  | { kind: "Bin"; op: BinOp; left: Expr; right: Expr }
  | { kind: "Call"; name: string; args: Expr[] };

export type Stmt =
  | { kind: "Decl"; name: string; init: Expr | null }
  | { kind: "Assign"; name: string; value: Expr }
  | { kind: "If"; cond: Expr; then: Stmt; els: Stmt | null }
  | { kind: "While"; cond: Expr; body: Stmt }
  | { kind: "Return"; value: Expr | null }
  | { kind: "ExprStmt"; expr: Expr }
  | { kind: "Block"; body: Stmt[] };

export interface FuncDef {
  name: string;
  params: string[];
  body: Stmt[];
}

export interface Program {
  funcs: FuncDef[];
}
