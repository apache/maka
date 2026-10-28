// A case of the API's test suite (docs/dev/compatibility.md): `fs/promises`
// in an app that declares `fs` capabilities, read and write in its own data
// directory (`${dataDir}`, which the fixture runs with, new and empty).
// Each call runs in the granted root and shows what it did; paths outside
// the root, and the other capabilities the app did not declare (sockets,
// processes), are still refused. Its script
// checks each.
import { Text, View, signal } from "nsh";
import fs, { exists, lstat, mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "fs/promises";
import { connect } from "net";
import process, { run } from "process";

const lines = signal<string[]>([]);
const show = (line: string) => lines.set([...lines(), line]);

function refused(call: () => unknown): string {
  try {
    call();
    return "allowed";
  } catch (error) {
    return error instanceof TypeError ? "refused" : `threw ${error}`;
  }
}

async function main() {
  const root = "${dataDir}";
  show(`Data dir: ${typeof process.dataDir === "string" && process.dataDir.length > 0}`);
  await mkdir(`${root}/notes/drafts`, { recursive: true });
  show(`Made: ${await exists(`${root}/notes/drafts`)}`);
  await writeFile(`${root}/notes/a.txt`, "hello files");
  show(`Read: ${await readFile(`${root}/notes/a.txt`, "utf8")}`);
  const bytes = await fs.readFile(`${root}/notes/a.txt`);
  show(`Bytes: ${bytes instanceof Uint8Array} ${bytes.length}`);
  const info = await stat(`${root}/notes/a.txt`);
  show(`Stat: file ${info.isFile()} dir ${info.isDirectory()} size ${info.size}`);
  const own = await lstat(`${root}/notes`);
  show(`Lstat: dir ${own.isDirectory()} link ${own.isSymbolicLink()}`);
  show(`Listed: ${(await readdir(`${root}/notes`)).join(",")}`);
  const entries = await readdir(`${root}/notes`, { withFileTypes: true });
  show(`Entries: ${entries.map((e) => `${e.name}:${e.isDirectory() ? "dir" : "file"}`).join(",")}`);
  await rename(`${root}/notes/a.txt`, `${root}/notes/b.txt`);
  show(`Renamed: ${await exists(`${root}/notes/a.txt`)} ${await exists(`${root}/notes/b.txt`)}`);
  await unlink(`${root}/notes/b.txt`);
  await rmdir(`${root}/notes/drafts`);
  show(`Removed: ${(await readdir(`${root}/notes`)).length}`);
  const missing = await readFile(`${root}/missing.txt`, "utf8").then(
    () => "read",
    (error) => error.code,
  );
  show(`Missing: ${missing}`);
  show(`Outside: ${refused(() => readFile("/nsh-compat-outside/file"))}`);
  show(`Escape: ${refused(() => writeFile(`${root}/../escape.txt`, "x"))}`);
  show(`Socket: ${refused(() => connect({ host: "compat.invalid", port: 80 }))}`);
  show(`Process: ${refused(() => run("nsh-compat-ungranted", []))}`);
}

main().catch((error) => show(`Failed: ${error}`));

export default () => (
  <View style={{ flex: 1, paddingTop: 64 }}>
    <Each of={lines()}>{(line) => <Text>{line()}</Text>}</Each>
  </View>
);
