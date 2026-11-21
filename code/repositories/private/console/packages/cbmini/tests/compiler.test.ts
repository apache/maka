import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("多函数分支与返回标签不重名，CLI 产出的汇编可组装", (t) => {
  if (process.platform === "win32" || spawnSync("clang", ["--version"]).status !== 0) {
    t.skip("本检查使用 Clang 组装 ELF；完整编译链接运行使用 check.sh/WSL");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cbmini-asm-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const wrapper = join(bin, "wsl.exe");
  writeFileSync(
    wrapper,
    '#!/bin/sh\ncd "$2" || exit 1\nshift 3\nclang -target i386-unknown-linux-gnu -c "$6" -o "$5.o"\n',
  );
  chmodSync(wrapper, 0o700);
  const source = join(dir, "branches.cb");
  writeFileSync(
    source,
    "int ret(int n) { if (n > 0) return 1; return 0; }\nint then0(int n) { if (n > 0) return 2; return 0; }\nint main(void) { print_int(ret(1)); print_int(then0(1)); return 0; }\n",
  );
  const result = spawnSync(
    process.execPath,
    [join(root, "src/main.ts"), "-o", join(dir, "branches"), source],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([...readFileSync(join(dir, "branches.o")).subarray(0, 5)], [127, 69, 76, 70, 1]);
});

test("输出匹配但程序非零退出时 check.sh 失败", () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "cbmini-exit-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "tests/cases"), { recursive: true });
  mkdirSync(join(dir, "tests/expected"));
  cpSync(join(root, "check.sh"), join(dir, "check.sh"));
  symlinkSync(join(root, "src"), join(dir, "src"));
  writeFileSync(join(dir, "tests/cases/one.cb"), "int main(void) { print_int(7); return 0; }\n");
  writeFileSync(join(dir, "tests/expected/one.txt"), "7\n");
  writeFileSync(
    join(dir, "bin/wsl.exe"),
    '#!/bin/sh\ncase "$*" in *gcc*) exit 0;; esac\nprintf "7\\n"\nprintf "fixture exit 7\\n" >&2\nexit 7\n',
    { mode: 0o700 },
  );
  const result = spawnSync("sh", [join(dir, "check.sh")], {
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout + result.stderr, /fixture exit 7/);
});
