// 代码生成：15 章对照表直译（值恒在 %eax 不变量）+ 16 章栈帧三区 + 18 章目标文件伪指令
import { Asm } from "./asm.ts";
import type { Expr, BinOp } from "./ast.ts";
import type { IRProgram, IRFunc, IRStmt } from "./ir.ts";

// StackFrame（16 章三区公式）：frameSize = saveRegsSize + lvarSize + tempSize
// ponytail: 本子集值恒在 %eax、Bin 用 push/pop，无临时量 → saveRegs/temp 恒 0，
// 16.4 的两遍 measure→fixOffset 合一；引入临时量（如短路求值）时恢复两遍法
class StackFrame {
  private offsets = new Map<string, number>();
  frameSize: number;

  constructor(params: string[], lvars: string[]) {
    let off = 8; // saved ebp 在 0，返回地址在 4
    for (const p of params) {
      this.offsets.set(p, off);
      off += 4;
    }
    off = -4;
    for (const v of lvars) {
      this.offsets.set(v, off);
      off -= 4;
    }
    const lvarSize = lvars.length * 4;
    this.frameSize = (lvarSize + 15) & ~15;
  }

  offset(name: string): number {
    const o = this.offsets.get(name);
    if (o === undefined) throw new Error(`未声明变量: ${name}`);
    return o;
  }
}

// 15 章对照表：Bin 五段式（右→push→左→pop %ecx→opl %ecx,%eax），除法前置 cltd，比较结尾 setcc+movzbl
const BIN_INSTR: Record<BinOp, string[]> = {
  "+": ["addl %ecx, %eax"],
  "-": ["subl %ecx, %eax"],
  "*": ["imull %ecx, %eax"],
  "/": ["cltd", "idivl %ecx"],
  "%": ["cltd", "idivl %ecx", "movl %edx, %eax"],
  "==": ["cmpl %ecx, %eax", "sete %al", "movzbl %al, %eax"],
  "!=": ["cmpl %ecx, %eax", "setne %al", "movzbl %al, %eax"],
  "<": ["cmpl %ecx, %eax", "setl %al", "movzbl %al, %eax"],
  "<=": ["cmpl %ecx, %eax", "setle %al", "movzbl %al, %eax"],
  ">": ["cmpl %ecx, %eax", "setg %al", "movzbl %al, %eax"],
  ">=": ["cmpl %ecx, %eax", "setge %al", "movzbl %al, %eax"],
};

function escapeAsm(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

export function generate(prog: IRProgram): string {
  const a = new Asm();
  const strPool = new Map<string, string>();
  let lc = 0;
  const strLabel = (s: string): string => {
    let l = strPool.get(s);
    if (!l) {
      l = `.LC${lc++}`;
      strPool.set(s, l);
    }
    return l;
  };
  for (const f of prog.funcs) genFunc(a, f, strLabel);
  if (strPool.size) {
    a._rodata();
    for (const [s, l] of strPool) {
      a.label(l);
      a.raw(`\t.string\t"${escapeAsm(s)}"`);
    }
  }
  return a.toString();
}

function genFunc(a: Asm, f: IRFunc, strLabel: (s: string) => string): void {
  const frame = new StackFrame(f.params, f.lvars);
  a._text();
  a._globl(f.name);
  a.label(f.name);
  // 序言（16.5）
  a.instr("pushl", "%ebp");
  a.instr("movl", "%esp, %ebp");
  a.instr("subl", `$${frame.frameSize}, %esp`);
  const retL = `.Lret_${f.name}`;
  for (const s of f.body) genStmt(a, s, frame, strLabel, retL);
  // 尾声
  a.label(retL);
  a.instr("leave");
  a.instr("ret");
  a.raw(`\t.size\t${f.name}, .-${f.name}`); // 18 章
}

function genStmt(
  a: Asm,
  s: IRStmt,
  frame: StackFrame,
  strLabel: (s: string) => string,
  retL: string,
): void {
  switch (s.kind) {
    case "Assign":
      genExpr(a, s.src, frame, strLabel);
      a.instr("movl", `%eax, ${frame.offset(s.dst)}(%ebp)`);
      break;
    case "ExprStmt":
      genExpr(a, s.expr, frame, strLabel); // 结果丢弃，值恒在 %eax 不变量允许
      break;
    case "Return":
      if (s.value) genExpr(a, s.value, frame, strLabel);
      a.instr("jmp", retL);
      break;
    case "LabelStmt":
      a.label(`.L${s.label}`);
      break;
    case "Jump":
      a.instr("jmp", `.L${s.label}`);
      break;
    case "CJump":
      genExpr(a, s.cond, frame, strLabel);
      a.instr("testl", "%eax, %eax");
      a.instr("jne", `.L${s.then}`);
      a.instr("jmp", `.L${s.els}`);
      break;
  }
}

function genExpr(a: Asm, e: Expr, frame: StackFrame, strLabel: (s: string) => string): void {
  switch (e.kind) {
    case "Int":
      a.instr("movl", `$${e.value}, %eax`);
      break;
    case "Str":
      a.instr("movl", `$${strLabel(e.value)}, %eax`);
      break;
    case "Var":
      a.instr("movl", `${frame.offset(e.name)}(%ebp), %eax`);
      break;
    case "Uni":
      genExpr(a, e.operand, frame, strLabel);
      a.instr("negl", "%eax");
      break;
    case "Bin": {
      // 五段式：右先求值（11.4"先转右边"的求值序）→ push → 左 → pop %ecx → opl
      genExpr(a, e.right, frame, strLabel);
      a.instr("pushl", "%eax");
      genExpr(a, e.left, frame, strLabel);
      a.instr("popl", "%ecx");
      for (const line of BIN_INSTR[e.op]) a.raw(`\t${line}`);
      break;
    }
    case "Call": {
      // builtin：printf 变参调用，cdecl 逆序压参、调用方清栈（14.2）
      if (e.name === "print_int") {
        genExpr(a, e.args[0]!, frame, strLabel);
        a.instr("pushl", "%eax");
        a.instr("pushl", `$${strLabel("%d\n")}`);
        a.instr("call", "printf");
        a.instr("addl", "$8, %esp");
        break;
      }
      if (e.name === "print") {
        genExpr(a, e.args[0]!, frame, strLabel);
        a.instr("pushl", "%eax");
        a.instr("call", "printf");
        a.instr("addl", "$4, %esp");
        break;
      }
      // 用户函数：实参逆序压栈
      for (let i = e.args.length - 1; i >= 0; i--) {
        genExpr(a, e.args[i]!, frame, strLabel);
        a.instr("pushl", "%eax");
      }
      a.instr("call", e.name);
      if (e.args.length) a.instr("addl", `$${4 * e.args.length}, %esp`);
      break;
    }
  }
}
