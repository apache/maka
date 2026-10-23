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

import { createText, errorText } from './text';
import {
  cleanup,
  computed,
  effect,
  Input,
  inputAction,
  Scroll,
  signal,
  Text,
  View,
  type GestureResponderEvent,
  type YNode,
} from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { Clipboard } from 'nsh/clipboard';
import { keymap } from 'nsh/keymap';
import type {
  RawAction,
  TerminalModifiers,
  TerminalSize,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { TerminalModel } from './terminalState';
import { terminalStatus } from './terminalState';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  codeTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

type Color = { named: number } | { indexed: number } | { rgb: number[] };
type Run = {
  text: string;
  lengths?: number[];
  style: { foreground: Color; background: Color; flags: number; underline?: Color | null };
};
type Frame = {
  metadata: {
    size: TerminalSize;
    cursor: { x: number; y: number; visible: boolean };
    cursorShape: string;
    input: { mouseTrackingMode: string };
    palette: [number, number[]][];
  };
  rows: Run[][];
  offset: number;
  totalRows: number;
  scrollbackRows: number;
  firstLine: number;
};
const CELL = 8;
const LINE = 16;
const ANSI = [
  '#2c2c2e',
  '#f48a8a',
  '#a3d7a5',
  '#e7b86b',
  '#7aaaff',
  '#cf9ee8',
  '#8dd7d2',
  '#cfd3d6',
  '#6d737c',
  '#ff9999',
  '#b3e5b0',
  '#f2cf86',
  '#9cbdff',
  '#dfb6f4',
  '#a6e8e3',
  '#f9fafb',
];
function color(value: Color, palette: [number, number[]][], foreground: boolean): string {
  let rgb: number[] | undefined;
  if ('rgb' in value) rgb = value.rgb;
  else {
    const index = 'named' in value ? value.named : value.indexed;
    rgb = palette.find(([slot]) => slot === index)?.[1];
    if (!rgb) {
      if (index < 16) return ANSI[index]!;
      if (index < 232) {
        const n = index - 16;
        const levels = [0, 95, 135, 175, 215, 255];
        rgb = [levels[Math.floor(n / 36)]!, levels[Math.floor(n / 6) % 6]!, levels[n % 6]!];
      } else if (index < 256) rgb = Array(3).fill(8 + (index - 232) * 10);
      else return foreground ? C.text : '#151517';
    }
  }
  return '#' + rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}
// Cell spans stay aligned even for combining characters and wide spacer cells.
function cells(run: Run): { text: string; columns: number } {
  const columns = run.lengths?.length || [...run.text].length;
  if (run.style.flags & 64) return { text: '', columns: 0 };
  const width = run.style.flags & 32 ? columns * 2 : columns;
  return { text: run.style.flags & (256 | 1024) ? ' '.repeat(width) : run.text, columns: width };
}

export function Terminal(props: { model: TerminalModel }) {
  const model = props.model;
  const dimensions = signal({ width: 0, height: LINE * 24 });
  const offset = signal(0);
  const inputValue = signal('');
  const confirmation = signal(false);
  const copyStatus = createText();
  const copied = signal(false);
  let input: YNode | null = null;
  let scroll: YNode | null = null;
  let body: YNode | null = null;
  let fallback: YNode | null = null;
  let mounted = true;
  let reset: ReturnType<typeof setTimeout> | null = null;
  let unbind = () => {};
  let typed = '';
  const typedKey = (event: { key: string }) => {
    if (!['Enter', 'Backspace', 'Delete', 'Escape'].includes(event.key)) typed += event.key;
  };
  const rows = () => Math.max(1, Math.min(1024, Math.floor(dimensions().height / LINE)));
  const frame = computed(() => {
    model.version();
    return model.grid.display(offset(), rows()) as unknown as Frame;
  });
  const pointerInput = () =>
    model.controllable() &&
    model.control() === 'held' &&
    offset() === 0 &&
    frame().metadata.input.mouseTrackingMode !== 'none';
  const key = (name: string, modifiers: TerminalModifiers = []) =>
    model.input([{ type: 'key', key: name, modifiers }]);
  const copy = async () => {
    try {
      await Clipboard.writeText(
        frame()
          .rows.map((row) =>
            row
              .map((run) => cells(run).text)
              .join('')
              .trimEnd(),
          )
          .join('\n'),
      );
      if (mounted) {
        copied.set(true);
        copyStatus.set('');
      }
    } catch (reason) {
      if (mounted) {
        copied.set(false);
        copyStatus.set(errorText(reason));
      }
    }
  };
  const attach = (node: YNode) => {
    input = node;
    unbind();
    const bindings: Record<string, () => void> = {};
    const names: Record<string, string> = {
      enter: 'enter',
      escape: 'escape',
      tab: 'tab',
      backspace: 'backspace',
      delete: 'delete',
      insert: 'insert',
      up: 'arrow_up',
      down: 'arrow_down',
      left: 'arrow_left',
      right: 'arrow_right',
      home: 'home',
      end: 'end',
      pageup: 'page_up',
      pagedown: 'page_down',
    };
    for (let index = 1; index <= 12; index++) if (index !== 11) names[`f${index}`] = `f${index}`;
    const variants: TerminalModifiers[] = [
      [],
      ['shift'],
      ['ctrl'],
      ['alt'],
      ['ctrl', 'shift'],
      ['alt', 'shift'],
    ];
    for (const [stroke, name] of Object.entries(names))
      for (const modifiers of variants) {
        if (stroke === 'f4' && modifiers.some((modifier) => modifier === 'alt')) continue;
        if (stroke === 'tab' && modifiers.some((modifier) => modifier !== 'shift')) continue;
        bindings[[...modifiers, stroke].join('+')] = () => {
          if (['enter', 'escape', 'backspace'].includes(stroke)) {
            if (modifiers.some((modifier) => modifier === 'alt'))
              model.input([
                { type: 'key', key: 'escape' },
                { type: 'key', key: name },
              ]);
            else if (stroke === 'backspace' && modifiers.some((modifier) => modifier === 'ctrl'))
              key('h', ['ctrl']);
            else key(name);
          } else key(name, modifiers);
        };
      }
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
      if (letter !== 'q' && letter !== 'v')
        bindings[`ctrl+${letter}`] = () => key(letter, ['ctrl']);
      bindings[`alt+${letter}`] = () => key(letter, ['alt']);
    }
    const controlCharacters: Record<string, string> = {
      '2': '@',
      '3': '[',
      '4': '\\',
      '5': ']',
      '6': '^',
      '7': '_',
      '8': '?',
      minus: '_',
      '/': '_',
      '[': '[',
      ']': ']',
      '\\': '\\',
      space: ' ',
    };
    for (const [stroke, character] of Object.entries(controlCharacters))
      bindings[`ctrl+${stroke}`] = () => key(character, ['ctrl']);
    for (const digit of '0123456789') bindings[`alt+${digit}`] = () => key(digit, ['alt']);
    bindings['ctrl+shift+c'] = () => void copy();
    bindings['ctrl+shift+space'] = () => {
      model.release();
      fallback?.focus();
    };
    bindings['shift+pageup'] = () => {
      model.atBottom = false;
      scroll?.scrollTo({ y: Math.max(0, model.position.y - rows() * LINE) });
    };
    bindings['shift+pagedown'] = () => scroll?.scrollTo({ y: model.position.y + rows() * LINE });
    unbind = keymap.bind(bindings, { when: 'always', repeat: true, within: node });
  };
  const text = (value: string) => {
    const previous = inputValue();
    let shared = 0;
    while (shared < previous.length && shared < value.length && previous[shared] === value[shared])
      shared++;
    const removed = [...previous.slice(shared)].length;
    const added = value.slice(shared);
    const actions: RawAction[] = Array.from({ length: removed }, () => ({
      type: 'key',
      key: 'backspace',
    }));
    const inserted = added.replace(
      typed === added ? /[\x00-\x1f\x7f-\x9f]/g : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,
      '',
    );
    if (inserted)
      actions.push(
        typed === added ? { type: 'text', text: inserted } : { type: 'paste', text: inserted },
      );
    typed = '';
    if (actions.length) model.input(actions);
    inputValue.set(value);
    // Normal input state owns IME and paste; release its completed transport buffer
    // on a later turn, after its latest controlled value reached the native editor.
    if (value.length > 4096 && !reset)
      reset = setTimeout(() => {
        reset = null;
        if (mounted) inputValue.set('');
      }, 0);
  };
  const mouse = async (event: GestureResponderEvent, kind: 'press' | 'release' | 'move') => {
    if (!pointerInput() || !body) return;
    const x = event.pageX,
      y = event.pageY;
    const original = body;
    const version = model.version();
    const geometry = dimensions();
    const current = frame();
    const bounds = await original.measure();
    if (
      !mounted ||
      body !== original ||
      !bounds ||
      !pointerInput() ||
      version !== model.version() ||
      geometry !== dimensions()
    )
      return;
    const column = Math.floor((x - bounds.pagePosition.x + model.position.x) / CELL);
    const row = current.firstLine + Math.floor((y - bounds.pagePosition.y) / LINE);
    if (
      column < 0 ||
      row < 0 ||
      column >= current.metadata.size.cols ||
      row >= current.metadata.size.rows
    )
      return;
    model.input([{ type: 'mouse', event: kind, x: column, y: row, button: 'left' }]);
  };
  effect(() => {
    const size = dimensions();
    model.resize({
      cols: Math.max(2, Math.min(1024, Math.floor(size.width / CELL))),
      rows: Math.max(1, Math.min(1024, Math.floor(size.height / LINE))),
    });
  });
  effect(() => {
    model.version();
    dimensions();
    if (model.atBottom) {
      offset.set(0);
      scroll?.scrollToEnd({ animated: false });
    }
  });
  cleanup(() => {
    mounted = false;
    unbind();
    model.release();
    if (reset) clearTimeout(reset);
  });
  const pipes = () => {
    const output = model.entry().result.output;
    return output?.mode === 'pipes' ? output.stdout + output.stderr : '';
  };
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        <Button
          ref={(node) => {
            fallback = node;
          }}
          disabled={!model.local() || !model.running() || model.state() !== 'live'}
          onPress={() => {
            model.takeControl();
            input?.focus();
          }}
          accessibilityLabel={tr('Focus terminal input')}
          tooltip={
            model.control() === 'held' ? tr('Terminal input is active') : tr('Focus terminal input')
          }
          selected={model.control() === 'held'}
          style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
          selectedStyle={{ backgroundColor: C.raised }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="terminal" color={C.secondary} />
          <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Input')}</Text>
        </Button>
        <If when={model.control() === 'held'}>
          <Button
            onPress={inputAction(model.release, null)}
            tooltip={tr('Release terminal input · Ctrl+Shift+Space')}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Release input')}</Text>
          </Button>
        </If>
        <View style={{ flex: 1 }} />
        <Button
          onPress={() => void copy()}
          accessibilityLabel={tr('Copy visible terminal')}
          tooltip={tr('Copy visible terminal · Ctrl+Shift+C')}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
        >
          <Icon name="copy" color={C.secondary} />
        </Button>
        <If when={model.local() && model.running()}>
          <Button
            disabled={model.stopping()}
            onPress={() => confirmation.set(true)}
            accessibilityLabel={tr('Stop terminal process')}
            tooltip={model.stopping() ? tr('Stopping process…') : tr('Stop terminal process')}
            style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="stop" color={C.warning} />
          </Button>
        </If>
      </View>
      <Text
        tooltip={tr('Terminal history · Shift+PageUp / Shift+PageDown')}
        style={{ ...captionTextStyle, color: C.muted }}
      >
        {terminalStatus(model.entry().result.status)} ·{' '}
        {model.control() === 'held'
          ? tr('input held')
          : model.local()
            ? tr('viewing')
            : tr('shared · view only')}
      </Text>
      <If when={model.error()}>
        <Text selectable style={{ ...bodyTextStyle, color: C.danger }}>
          {model.error()}
        </Text>
      </If>
      <If when={model.state() === 'failed' || model.control() === 'refused'}>
        <Button
          onPress={inputAction(model.retry, null)}
          style={{
            ...controlStyle,
            alignSelf: 'flex-start',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
        >
          <Icon name="refresh" color={C.secondary} />
          <Text style={{ ...captionTextStyle, color: C.secondary }}>
            {tr('Retry terminal observation')}
          </Text>
        </Button>
      </If>
      <If when={copied() || copyStatus()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {copied() ? tr('Visible terminal copied.') : copyStatus()}
        </Text>
      </If>
      <If when={model.state() === 'unavailable'}>
        <Text style={{ ...bodyTextStyle, color: C.warning }}>
          {tr(
            'Live output is no longer retained. Input is released; the final display will appear after the process settles.',
          )}
        </Text>
      </If>
      <View
        ref={(node) => {
          body = node;
        }}
        onLayout={(event) => dimensions.set(event.size)}
        onPress={() => {
          input?.focus();
          if (!model.agentOwned()) model.takeControl();
        }}
        onStartShouldSetResponder={() => pointerInput()}
        onResponderGrant={(event) => {
          void mouse(event, 'press');
          return true;
        }}
        onResponderMove={(event) => void mouse(event, 'move')}
        onResponderRelease={(event) => void mouse(event, 'release')}
        onResponderTerminate={() => model.release()}
        accessibilityLabel={tr('Terminal output')}
        style={{ flex: 1, minHeight: LINE, backgroundColor: '#151517', overflow: 'hidden' }}
      >
        <If when={model.entry().result.mode === 'pty'}>
          <Scroll
            horizontal
            onScroll={(event) => {
              model.position.x = event.offset.x;
            }}
            style={{ flex: 1 }}
          >
            <Scroll
              ref={(node) => {
                scroll = node;
              }}
              contentOffset={model.position}
              onScroll={(event) => {
                model.position.y = event.offset.y;
                const current = frame();
                const distance = Math.max(
                  0,
                  current.totalRows - rows() - Math.floor(event.offset.y / LINE),
                );
                model.atBottom = distance <= 1;
                offset.set(model.atBottom ? 0 : distance);
              }}
              style={{
                width: Math.max(dimensions().width, frame().metadata.size.cols * CELL),
                height: dimensions().height,
              }}
            >
              <View
                style={{
                  height: Math.max(rows(), frame().totalRows) * LINE,
                  width: frame().metadata.size.cols * CELL,
                }}
              >
                <View
                  style={{
                    position: 'absolute',
                    top: Math.max(0, frame().scrollbackRows + frame().firstLine) * LINE,
                    left: 0,
                  }}
                >
                  <Each of={frame().rows} key={(_, index) => index}>
                    {(row, index) => (
                      <View style={{ flexDirection: 'row', height: LINE }}>
                        <Each of={row()} key={(_, index) => index}>
                          {(run) => {
                            const foreground = () =>
                              color(run().style.foreground, frame().metadata.palette, true);
                            const background = () =>
                              color(run().style.background, frame().metadata.palette, false);
                            return (
                              <Text
                                numberOfLines={1}
                                selectable={false}
                                style={{
                                  fontFamily: 'monospace',
                                  fontSize: 16,
                                  lineHeight: LINE,
                                  width: cells(run()).columns * CELL,
                                  flexShrink: 0,
                                  color: run().style.flags & 1 ? background() : foreground(),
                                  backgroundColor:
                                    run().style.flags & 1 ? foreground() : background(),
                                  fontWeight: run().style.flags & 2 ? '700' : '400',
                                  fontStyle: run().style.flags & 4 ? 'italic' : 'normal',
                                  textDecorationLine:
                                    run().style.flags & 512
                                      ? 'line-through'
                                      : run().style.flags & (8 | 2048 | 4096 | 8192 | 16384)
                                        ? 'underline'
                                        : 'none',
                                  opacity: run().style.flags & 128 ? 0.6 : 1,
                                }}
                              >
                                {cells(run()).text}
                              </Text>
                            );
                          }}
                        </Each>
                        <If
                          when={
                            model.control() === 'held' &&
                            frame().metadata.cursor.visible &&
                            frame().metadata.cursor.y === frame().firstLine + index()
                          }
                        >
                          <View
                            style={{
                              position: 'absolute',
                              left: frame().metadata.cursor.x * CELL,
                              top: 0,
                              width: CELL,
                              height: LINE,
                              borderBottomWidth: 2,
                              borderBottomColor: C.text,
                            }}
                          />
                        </If>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            </Scroll>
          </Scroll>
        </If>
        <If when={model.entry().result.mode === 'pipes'}>
          <Scroll style={{ flex: 1 }}>
            <Text selectable style={{ ...codeTextStyle, color: C.text }}>
              {pipes()}
            </Text>
          </Scroll>
        </If>
        <If when={model.entry().result.mode === 'pty' && model.local() && model.state() === 'live'}>
          <Input
            ref={attach}
            value={inputValue()}
            onChange={text}
            onKeyPress={typedKey}
            onFocus={() => {
              if (!model.agentOwned()) model.takeControl();
            }}
            onBlur={() => model.release()}
            autoCapitalize="none"
            autoCorrect={false}
            caret={false}
            multiline
            submitBehavior="newline"
            accessibilityLabel={tr('Terminal keyboard input')}
            style={{
              position: 'absolute',
              width: CELL,
              height: LINE,
              left: 0,
              bottom: 0,
              opacity: 0.01,
            }}
          />
        </If>
      </View>
      <If when={confirmation()}>
        <Dialog
          animation="none"
          onOpenChange={() => confirmation.set(false)}
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: '#000000cc',
          }}
        >
          <View
            style={{
              padding: 24,
              width: '90%',
              maxWidth: 480,
              gap: 24,
              borderRadius: 16,
              backgroundColor: C.surface,
            }}
          >
            <Text style={{ ...bodyTextStyle, color: C.text }}>
              {model.agentOwned()
                ? tr('Stop the agent’s running terminal? This interrupts its command.')
                : tr('Stop this terminal and its running process?')}
            </Text>
            <View
              style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}
            >
              <Button
                onPress={() => confirmation.set(false)}
                style={{ ...controlStyle, backgroundColor: C.raised }}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
              >
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('Keep running')}
                </Text>
              </Button>
              <Button
                accessibilityLabel={tr('Confirm stop terminal process')}
                onPress={() => {
                  confirmation.set(false);
                  void model.stop();
                }}
                style={controlStyle}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
              >
                <Text style={{ ...captionTextStyle, color: C.danger }}>{tr('Stop process')}</Text>
              </Button>
            </View>
          </View>
        </Dialog>
      </If>
    </View>
  );
}
