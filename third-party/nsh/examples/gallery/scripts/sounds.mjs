// Writes the gallery's sounds: cuelume's cues (https://github.com/danielwh2/cuelume,
// MIT, Daniel Belyi; its notice is sounds/LICENSE), its default theme rendered
// offline by its own scripts/sound.mjs into 48 kHz mono WAVs that NSH's `Sound`
// plays on every platform.
//
//   git clone https://github.com/danielwh2/cuelume && (cd cuelume && npm ci && npm run build)
//   bun scripts/sounds.mjs <cuelume> sounds tap select toggle open close success warning error ready attention
//
// Each cue plays at its normal emphasis, without the room's tail below -70 dB.
// One gain for every cue keeps cuelume's matched levels: the loudest peaks near
// -6 dBFS, and a play's volume brings it down from there.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [root, dir, ...cues] = process.argv.slice(2);
const { stereo, SR } = await import(pathToFileURL(resolve(root, "scripts/sound.mjs")).href);
const GAIN = 3.4;
mkdirSync(dir, { recursive: true });
for (const cue of cues) {
  const [l, r] = stereo("default", cue, { emphasis: "normal", part: "press" });
  let n = l.length;
  while (n > 0 && Math.abs(l[n - 1]) < 3e-4 && Math.abs(r[n - 1]) < 3e-4) n--;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, ((l[i] + r[i]) / 2) * GAIN)) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(`${dir}/${cue}.wav`, Buffer.concat([head, data]));
}
