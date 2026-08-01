import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { startVoiceCapture } from '../../renderer/voice-audio-capture.js';

const originalNavigator = globalThis.navigator;
const originalMediaRecorder = globalThis.MediaRecorder;
const originalWindow = globalThis.window;

afterEach(() => {
  defineGlobal('navigator', originalNavigator);
  defineGlobal('MediaRecorder', originalMediaRecorder);
  defineGlobal('window', originalWindow);
});

describe('voice audio capture lifecycle', () => {
  it('releases the microphone and reports a fatal recorder error immediately', async () => {
    let trackStops = 0;
    let activeRecorder: FakeMediaRecorder | undefined;
    const track = { stop: () => { trackStops += 1; } };
    const stream = { getTracks: () => [track] };

    class CapturingMediaRecorder extends FakeMediaRecorder {
      constructor(input: MediaStream) {
        super(input);
        activeRecorder = this;
      }
    }

    installBrowserFakes(stream as unknown as MediaStream, CapturingMediaRecorder);
    let reported: Error | undefined;
    const capture = await startVoiceCapture({
      onError: (error) => {
        reported = error;
      },
    });

    activeRecorder?.dispatchEvent(new Event('error'));

    assert.equal(reported?.message, 'voice_recording_failed');
    assert.equal(trackStops, 1);
    assert.equal(activeRecorder?.state, 'inactive');
    await assert.rejects(() => capture.stop(), /voice_capture_already_finished/);
  });

  it('releases the microphone when recorder construction fails', async () => {
    let trackStops = 0;
    const stream = {
      getTracks: () => [{ stop: () => { trackStops += 1; } }],
    };
    class FailingMediaRecorder extends FakeMediaRecorder {
      constructor(input: MediaStream) {
        super(input);
        throw new Error('recorder_construction_failed');
      }
    }
    installBrowserFakes(stream as unknown as MediaStream, FailingMediaRecorder);

    await assert.rejects(() => startVoiceCapture(), /recorder_construction_failed/);
    assert.equal(trackStops, 1);
  });
});

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(): boolean {
    return true;
  }

  readonly mimeType = 'audio/webm';
  state: RecordingState = 'inactive';

  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
    super();
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.dispatchEvent(new Event('stop'));
  }
}

function installBrowserFakes(
  stream: MediaStream,
  Recorder: typeof FakeMediaRecorder,
): void {
  defineGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => stream },
  });
  defineGlobal('MediaRecorder', Recorder);
  defineGlobal('window', {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}
