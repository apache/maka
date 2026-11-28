// Makes the link kit of the gnullvm release runner (#1644): the objects and
// libraries its link reads, rustc's metadata taken out of each rlib, and
// `link.rsp`, the `ld.lld` arguments with `${KIT}` for the kit's directory,
// so that `nsh package` links the runner again with `rust-lld -flavor gnu`
// alone (crates/nsh-cli/src/windows_link.rs).
//
//   cargo rustc --release -p nsh-windows-app --bin nsh-windows-app \
//     --target x86_64-pc-windows-gnullvm -- -C save-temps --print link-args > linkargs.txt
//   node link-kit.js linkargs.txt <kit-dir>
//
// clang (llvm-mingw) and llvm-ar must be on PATH: clang prints the `ld.lld`
// command it would run (`-###`), with the mingw runtime it adds.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const [cmdFile, kit] = process.argv.slice(2);
const quoted = line => [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'));

const line = fs.readFileSync(cmdFile, 'utf8').split('\n').find(l => l.includes('clang'));
const [clang, ...clangArgs] = quoted(line);
// Through a response file: the command line is too long for Windows.
fs.mkdirSync(kit, { recursive: true });
const rsp = path.join(kit, 'clang.rsp');
fs.writeFileSync(rsp, clangArgs.map(a => `"${a.replace(/\\/g, '/')}"`).join('\n'));
const hash = spawnSync(clang, ['-###', '@' + rsp], { encoding: 'utf8', maxBuffer: 1 << 28 });
const lldLine = hash.stderr.split('\n').find(l => /ld\.lld/.test(l));
if (!lldLine) { console.error(hash.stderr); process.exit(1); }
const args = quoted(lldLine).slice(1);

fs.rmSync(kit, { recursive: true, force: true });
const lib = path.join(kit, 'lib');
fs.mkdirSync(lib, { recursive: true });
const names = new Set();
let size = 0;
const take = src => {
  let name = path.win32.basename(src).replace(/\.rlib$/, '.a');
  for (let n = 1; names.has(name.toLowerCase()); n++) name = name.replace(/^(.*?)(-\d+)?(\.[^.]+)$/, `$1-${n}$3`);
  names.add(name.toLowerCase());
  const out = path.join(lib, name);
  fs.copyFileSync(src, out);
  if (src.endsWith('.rlib')) {
    const r = spawnSync('llvm-ar', ['d', out, 'lib.rmeta'], { encoding: 'utf8' });
    if (r.status) { console.error(src, r.stderr); process.exit(1); }
  }
  size += fs.statSync(out).size;
  return '${KIT}/lib/' + name;
};

const dirs = [];
const out = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') { i++; continue; }
  if (a.startsWith('-L')) { dirs.push(a.slice(2)); continue; }
  if (a.startsWith('-l')) {
    // A library found through -L: the kit has its own copy.
    const want = a.startsWith('-l:') ? [a.slice(3)] : [`lib${a.slice(2)}.a`, `lib${a.slice(2)}.dll.a`, `${a.slice(2)}.lib`];
    const found = dirs.flatMap(d => want.map(w => path.join(d, w))).find(f => fs.existsSync(f));
    if (!found) { console.error('not found:', a); process.exit(1); }
    out.push(take(found));
    continue;
  }
  if (/\.(o|a|rlib|lib)$/i.test(a) && !a.startsWith('-') && fs.existsSync(a)) { out.push(take(a)); continue; }
  out.push(a);
}
fs.writeFileSync(path.join(kit, 'link.rsp'), out.map(a => `"${a.replace(/\\/g, '/')}"`).join('\n') + '\n');
console.log(`${names.size} files, ${(size / 1048576).toFixed(1)} MB in ${kit}`);
