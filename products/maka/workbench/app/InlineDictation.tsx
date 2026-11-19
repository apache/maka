/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { dictationPreferences } from './dictationPreferences';
import { host } from 'maka/host';
import { signal, View, Text } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import { currentLocale, tr } from './locale';
import { C, composerIconSlot, textTooltip } from './ui';
import type { ComposerEditor } from './ComposerEditor';
import { dictateIntoDraft } from './composerDictation';

type Attachment = {
  editor(): ComposerEditor | null;
  draft(): string;
  selection(): { start: number; end: number };
  active(): boolean;
  send(text: string, previous: string): void;
  error(reason: unknown): void;
};
type Phase = 'idle' | 'starting' | 'recording' | 'paused' | 'upload' | 'retry' | 'insert';
const sessions = new Map<string, ReturnType<typeof controller>>();

type Recording = Pick<
  ReturnType<typeof host.messageDictation>,
  'start' | 'level' | 'cancel' | 'finish'
>;
export function attachDictation(
  id: string,
  attachment: Attachment,
  open: () => Recording = () => {
    const native = host.messageDictation();
    return {
      start: async (chinese) =>
        native.start(chinese, await dictationPreferences.recordingConnection()),
      level: () => native.level(),
      cancel: () => native.cancel(),
      finish: () => native.finish(),
    };
  },
) {
  const state = sessions.get(id) ?? controller(id, open);
  state.attach(attachment);
  return state;
}

function controller(id: string, open: () => Recording) {
  const phase = signal<Phase>('idle');
  const levels = signal(Array<number>(28).fill(0));
  const seconds = signal(0);
  const error = signal('');
  let view: Attachment | null = null;
  let recorder: Recording | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sendOnFinish = false;
  let expected = '';
  let range = { start: 0, end: 0 };
  const pendingText = signal('');
  const stopTimer = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const cancel = () => {
    stopTimer();
    recorder?.cancel();
    recorder = null;
    pendingText.set('');
    error.set('');
    phase.set('idle');
    sessions.delete(id);
  };
  const api = {
    phase,
    levels,
    pendingText,
    seconds,
    error,
    cancel,
    attach(next: Attachment) {
      view = next;
    },
    detach() {
      view = null;
      if (!['upload', 'retry', 'insert'].includes(phase())) cancel();
    },
    async start() {
      if (!view || phase() !== 'idle' || view.editor()?.composing()) return;
      let native: Recording;
      try {
        native = open();
      } catch (reason) {
        view.error(reason);
        return;
      }
      recorder = native;
      sessions.set(id, api);
      sendOnFinish = false;
      expected = view.draft();
      range = { ...view.selection() };
      phase.set('starting');
      try {
        const started = await native.start(currentLocale().startsWith('zh'));
        if (recorder !== native) return;
        if (!started) {
          cancel();
          return;
        }
        const began = Date.now();
        seconds.set(0);
        levels.set(Array<number>(28).fill(0));
        phase.set('recording');
        let sampling = false;
        timer = setInterval(async () => {
          if (sampling) return;
          sampling = true;
          let level: number;
          try {
            level = await native.level();
          } catch (reason) {
            if (recorder === native && phase() === 'recording') {
              cancel();
              view?.error(reason);
            }
            return;
          } finally {
            sampling = false;
          }
          if (recorder !== native || phase() !== 'recording') return;
          seconds.set(Math.min(120, Math.floor((Date.now() - began) / 1000)));
          if (level < 0) {
            stopTimer();
            phase.set('paused');
          } else levels.set([...levels().slice(1), level]);
        }, 90);
      } catch (reason) {
        if (recorder === native) {
          cancel();
          view?.error(reason);
        }
      }
    },
    async finish(send = sendOnFinish) {
      const native = recorder;
      if (!native || !['recording', 'paused', 'retry'].includes(phase())) return;
      stopTimer();
      sendOnFinish = send;
      phase.set('upload');
      const original = view;
      try {
        const text = await native.finish();
        if (recorder !== native) return;
        if (!text.trim()) {
          cancel();
          view?.error(tr('No speech detected'));
          return;
        }
        pendingText.set(text);
        const editor = original?.editor();
        if (editor && original && original === view && original.active()) {
          const result = await dictateIntoDraft(
            editor,
            expected,
            range,
            async () => text,
            () => original === view && original.active() && recorder === native,
          );
          if (recorder !== native) return;
          if (!result && original === view && original.active()) {
            const message = expected.slice(0, range.start) + text + expected.slice(range.end);
            cancel();
            if (send) original.send(message, expected);
            return;
          }
        }
        phase.set('insert');
      } catch (reason) {
        if (recorder === native) {
          error.set(String(reason));
          phase.set('retry');
        }
      }
    },
    async insert() {
      if (!view?.active() || phase() !== 'insert') return;
      const editor = view.editor();
      if (!editor) return;
      const result = await dictateIntoDraft(
        editor,
        view.draft(),
        view.selection(),
        async () => pendingText(),
        () => !!view?.active(),
      );
      if (!result) cancel();
    },
  };
  return api;
}

export function DictationBar(props: { state: ReturnType<typeof attachDictation> }) {
  const s = props.state;
  const label = () => {
    switch (s.phase()) {
      case 'starting':
        return tr('Preparing microphone…');
      case 'upload':
        return tr('Transcribing…');
      case 'retry':
        return tr('Transcription failed');
      case 'insert':
        return tr('Transcript ready');
      case 'paused':
        return tr('Recording finished');
      default:
        return tr('Recording');
    }
  };
  const seconds = () =>
    Math.floor(s.seconds() / 60) + ':' + String(s.seconds() % 60).padStart(2, '0');
  const action = (name: 'close' | 'check' | 'refresh' | 'send', title: string, run: () => void) => (
    <Button
      accessibilityLabel={title}
      tooltip={textTooltip(() => title)}
      onPress={run}
      style={{
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: name === 'close' ? undefined : name === 'send' ? C.text : C.line,
      }}
    >
      <Icon name={name} color={name === 'send' ? C.surface : C.secondary} size={17} />
    </Button>
  );
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        height: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <View style={composerIconSlot}>
        <If when={s.phase() === 'recording'}>
          <View
            testID="recording-dot"
            style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#e66c68' }}
          />
        </If>
        <If when={s.phase() === 'upload' || s.phase() === 'starting'}>
          <LoadingIndicator size={14} label={label()} />
        </If>
      </View>
      <Text style={{ fontSize: 13, color: C.secondary }}>{label()}</Text>
      <If when={s.phase() === 'recording' || s.phase() === 'paused'}>
        <Text style={{ fontSize: 12, color: C.muted }}>{seconds()}</Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            height: 24,
            flexShrink: 1,
            overflow: 'hidden',
          }}
        >
          {Array.from({ length: 28 }, (_, i) => (
            <View
              style={{
                width: 2,
                borderRadius: 1,
                height: 2 + 20 * s.levels()[i],
                backgroundColor: C.secondary,
              }}
            />
          ))}
        </View>
      </If>
      <If
        when={s.phase() === 'insert' || s.phase() === 'retry'}
        else={<View style={{ flex: 1 }} />}
      >
        <Text
          style={{
            flex: 1,
            minWidth: 0,
            color: C.muted,
            fontSize: 12,
            numberOfLines: 1,
            textOverflow: 'ellipsis',
          }}
        >
          {s.phase() === 'retry' ? s.error() : s.pendingText()}
        </Text>
      </If>
      {action('close', tr('Cancel dictation'), s.cancel)}
      <If when={s.phase() === 'recording' || s.phase() === 'paused' || s.phase() === 'upload'}>
        <View
          style={{
            flexDirection: 'row',
            gap: 8,
            flexShrink: 0,
            visibility: s.phase() === 'upload' ? 'hidden' : 'visible',
          }}
        >
          {action('check', tr('Finish and transcribe'), () => void s.finish(false))}
          {action('send', tr('Transcribe and send'), () => void s.finish(true))}
        </View>
      </If>
      <If when={s.phase() === 'retry'}>
        {action('refresh', tr('Retry transcription'), () => void s.finish())}
      </If>
      <If when={s.phase() === 'insert'}>
        {action('check', tr('Insert transcript'), () => void s.insert())}
      </If>
    </View>
  );
}
