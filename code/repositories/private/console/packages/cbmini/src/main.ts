// 命令行入口：cbc 风格断点流水线，--dump-* 即停；默认跑完 词法→语法→IR→汇编→wsl 链接
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { lex, dumpTokens } from "./lexer.ts";
import { parse, dumpAST } from "./parser.ts";
import { lower, dumpIR } from "./ir.ts";
import { generate } from "./codegen.ts";

function usage(): never {
  console.error("用法: node src/main.ts [--dump-tokens|--dump-ast|--dump-ir] [-o 输出名] 文件.cb");
  process.exit(2);
}

const argv = process.argv.slice(2);
let dump = "";
let out = "";
let file = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--dump-tokens" || a === "--dump-ast" || a === "--dump-ir") dump = a;
  else if (a === "-o") out = argv[++i] ?? usage();
  else if (a.startsWith("-")) usage();
  else file = a;
}
if (!file || (out === "" && argv.includes("-o"))) usage();

try {
  const src = readFileSync(file, "utf8");
  const base = out || path.basename(file).replace(/\.cb$/, "");

  const toks = lex(src);
  if (dump === "--dump-tokens") {
    console.log(dumpTokens(toks));
    process.exit(0);
  }
  const ast = parse(toks);
  if (dump === "--dump-ast") {
    console.log(dumpAST(ast));
    process.exit(0);
  }
  const ir = lower(ast);
  if (dump === "--dump-ir") {
    console.log(dumpIR(ir));
    process.exit(0);
  }

  writeFileSync(path.resolve(base + ".s"), generate(ir));

  // 链接走 WSL：MSYS2 无 elf_i386 Linux 链路。gcc -m32 一并带上 crt/libc；
  // ponytail: 卡里"as --32 + ld -m elf_i386 -dynamic-linker … -lc"需手补 crt1.o，
  // gcc -m32 -no-pie 等价且产物同为 ELF 32-bit LSB executable
  const dir = path.dirname(path.resolve(base));
  const name = path.basename(base);
  const r = spawnSync("wsl.exe", ["--cd", dir, "--", "gcc", "-m32", "-no-pie", "-o", name, `${name}.s`], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
