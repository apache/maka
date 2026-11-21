// 轻量汇编 DSL（15.2）：只包一层字符串发射
export class Asm {
  lines: string[] = [];

  _globl(n: string) {
    this.lines.push(`\t.globl\t${n}`);
  }
  _text() {
    this.lines.push("\t.text");
  }
  _rodata() {
    this.lines.push("\t.section\t.rodata");
  }
  label(n: string) {
    this.lines.push(`${n}:`);
  }
  instr(op: string, ...ops: string[]) {
    this.lines.push(`\t${op}${ops.length ? "\t" + ops.join(", ") : ""}`);
  }
  raw(line: string) {
    this.lines.push(line);
  }
  toString(): string {
    return this.lines.join("\n") + "\n";
  }
}
