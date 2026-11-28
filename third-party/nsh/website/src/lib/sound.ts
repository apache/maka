// The site's sounds, three of the gallery's (cuelume's cues, MIT: `public/sounds/LICENSE`):
// `select` for a choice (a tab, a theme, a filter), `success` for a copy, `tap` for the
// home page's press. Quiet, and only on what the reader does. Web Audio, decoded once
// at the first press anywhere on the page, so the first is on time. Each play gets its
// own output context and closes it when the sound ends: a live context holds the
// reader's audio output open, and on macOS an open device pulls AirPods over from
// whatever they were doing.
import { BASE } from './site';

/** The site's sounds. */
export type SoundName = 'select' | 'success' | 'tap';

// Decoding is offline: an `OfflineAudioContext` never opens the output device.
let decoder: OfflineAudioContext | undefined;
const buffers = new Map<SoundName, Promise<AudioBuffer | null>>();

function load(name: SoundName): Promise<AudioBuffer | null> {
  try {
    decoder ??= new OfflineAudioContext(1, 1, 44100);
  } catch {
    return Promise.resolve(null);
  }
  const audio = decoder;
  let buffer = buffers.get(name);
  if (!buffer) {
    buffer = fetch(`${BASE}sounds/${name}.wav`)
      .then((r) => r.arrayBuffer())
      .then((bytes) => audio.decodeAudioData(bytes))
      .catch(() => null);
    buffers.set(name, buffer);
  }
  return buffer;
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => (['select', 'success', 'tap'] as const).forEach((name) => void load(name)), {
    once: true,
    capture: true,
  });
}

/** Plays `name` at `volume` (0.6; 0.3 for a subtle one). */
export function playSound(name: SoundName, volume = 0.6) {
  let audio: AudioContext;
  try {
    audio = new AudioContext();
  } catch {
    return;
  }
  // Every caller runs in a reader gesture, but resume anyway if the context did
  // not start.
  if (audio.state === 'suspended') void audio.resume().catch(() => {});
  void load(name).then((buffer) => {
    if (!buffer) {
      void audio.close().catch(() => {});
      return;
    }
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain).connect(audio.destination);
    source.onended = () => void audio.close().catch(() => {});
    source.start();
  });
}

/** Plays `select`: a choice made. */
export function playSelect() {
  playSound('select');
}
