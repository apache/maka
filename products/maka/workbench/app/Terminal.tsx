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

import { FloatingNoticeCapsule, RegionEmptyError } from './Feedback';
import { radius, textTooltip } from './ui';
import { errorText, renderText } from './text';
import { toast } from './toastStore';
import {
  Canvas,
  cleanup,
  computed,
  effect,
  inputAction,
  platform,
  Scroll,
  signal,
  Text,
  View,
  type GestureResponderEvent,
  type InputRef,
  type ScrollRef,
  type ViewRef,
} from 'nsh';
import { Input } from 'nsh/base';
import { Button } from 'nsh/base';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import { Clipboard } from 'nsh';
import { keymap } from 'nsh';
import type {
  RawAction,
  TerminalModifiers,
  TerminalSize,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { TerminalModel } from './terminalState';
import { terminalStatus } from './terminalState';
import { createTerminalFollow } from './terminalFollow';
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
  defaultColors,
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
// Output keeps the dark colors in every appearance, like the ANSI palette.
const SURFACE = defaultColors(true);
const FONT = 'monospace';
const textTerminal = platform.idiom === 'terminal';
const FONT_SIZE = textTerminal ? 16 : 13;
const LINE = textTerminal ? 16 : 19;
const TERMINAL_FONT = { fontFamily: FONT, fontSize: FONT_SIZE, lineHeight: LINE };
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
      else return foreground ? SURFACE.text : SURFACE.background;
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
  const cellWidth = signal(8);
  const inputValue = signal('');
  const confirmation = signal(false);
  const copied = signal(false);
  let input: InputRef | null = null;
  let scroll: ScrollRef | null = null;
  let body: ViewRef | null = null;
  let fallback: ViewRef | null = null;
  let mounted = true;
  let reset: ReturnType<typeof setTimeout> | null = null;
  let copyReset: ReturnType<typeof setTimeout> | null = null;
  let unbind = () => {};
  // One decision per mounted pane: a remount restores the reading state
  // the model survived suspend/activate cycles with.
  const follow = createTerminalFollow(LINE);
  // Scroll reports update plain model fields, so the frame computation
  // needs its own invalidation to move the rendered slice with the native
  // viewport while the user scrolls.
  const frameTick = signal(0);
  const repaint = () => frameTick.set(frameTick() + 1);
  let scrollHold: ReturnType<typeof setTimeout> | null = null;
  const extentRows = () => (model.grid.extent() as { totalRows: number }).totalRows;
  // The rows the Scroll clamps against: the content of the last frame this
  // pane rendered. The grid can run a batch ahead of it while output
  // streams, so a gesture is measured in the Scroll's own coordinates.
  let renderedTotal = 0;
  const contentRows = () => {
    const total = Math.max(rows(), frame().totalRows);
    renderedTotal = total;
    return total;
  };
  // Put the physical viewport on the bottom the reading state decided. The
  // follow effect pins on the next batch; a gesture that ended at the bottom
  // pins here so the rendered slice and the viewport move together at once.
  const pin = () => {
    model.position.y = follow.physicalY(renderedTotal, rows());
    scroll?.scrollToEnd({ animated: false });
  };
  // A wheel at a scroll edge emits an intent but never moves, reports or
  // ends; a notch glides for 150 ms reporting every frame. Close a pending
  // window that stays quiet for twice that so the follow effect may pin
  // again. Drags stay open until their end: a held thumb may report
  // nothing for a while.
  const holdScroll = () => {
    if (scrollHold) clearTimeout(scrollHold);
    scrollHold = setTimeout(() => {
      scrollHold = null;
      model.atBottom = follow.abandon(model.position.y, renderedTotal, rows()).atBottom;
      if (model.atBottom) pin();
      repaint();
    }, 300);
  };
  const releaseScroll = () => {
    if (scrollHold) clearTimeout(scrollHold);
    scrollHold = null;
  };
  const rows = () => Math.max(1, Math.min(1024, Math.floor(dimensions().height / LINE)));
  const frame = computed(() => {
    model.version();
    frameTick();
    // Derive the bottom-relative display offset from the top-anchored
    // reading position against the current grid, so new output and resize
    // keep the slice aligned with the viewport.
    const extent = model.grid.extent() as { totalRows: number };
    const reading = follow.displayOffset(extent.totalRows, rows());
    return model.grid.display(reading, rows()) as unknown as Frame;
  });
  const extent = model.grid.extent() as { totalRows: number };
  model.atBottom = follow.restore(
    model.atBottom,
    model.position.y,
    extent.totalRows,
    rows(),
  ).atBottom;
  const pointerInput = () =>
    model.controllable() &&
    model.control() === 'held' &&
    follow.state.atBottom &&
    frame().metadata.input.mouseTrackingMode !== 'none';
  const key = (name: string, modifiers: TerminalModifiers = []) =>
    model.input([{ type: 'key', key: name, modifiers }]);
  const copy = async () => {
    try {
      await Clipboard.writeText(
        model.entry().result.mode === 'pipes'
          ? pipes()
          : frame()
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
        if (copyReset) clearTimeout(copyReset);
        copyReset = setTimeout(() => {
          copyReset = null;
          if (mounted) copied.set(false);
        }, 1500);
      }
    } catch (reason) {
      if (mounted) {
        copied.set(false);
        toast.show({
          id: 'terminal.copy',
          tone: 'danger',
          message: renderText(errorText(reason, 'Could not copy to the clipboard.')),
        });
      }
    }
  };
  const focusShell = () => {
    if (!model.focusRequested() || !input) return;
    model.focusRequested.set(false);
    input.focus();
  };
  effect(focusShell);
  const attach = (node: InputRef) => {
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
      releaseScroll();
      const extent = model.grid.extent() as { totalRows: number };
      follow.pageUp(extent.totalRows, rows());
      model.atBottom = follow.state.atBottom;
      model.position.y = follow.physicalY(extent.totalRows, rows());
      scroll?.scrollTo({ y: model.position.y, animated: false });
      repaint();
    };
    bindings['shift+pagedown'] = () => {
      releaseScroll();
      const extent = model.grid.extent() as { totalRows: number };
      follow.pageDown(extent.totalRows, rows());
      model.atBottom = follow.state.atBottom;
      model.position.y = follow.physicalY(extent.totalRows, rows());
      scroll?.scrollTo({ y: model.position.y, animated: false });
      repaint();
    };
    unbind = keymap.bind(bindings, { when: 'always', repeat: true, within: node });
    focusShell();
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
    const inserted = added.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    if (inserted) actions.push({ type: 'text', text: inserted });
    if (actions.length) model.input(actions);
    inputValue.set(value);
    // The editor owns IME; release its completed transport buffer
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
    const column = Math.floor((x - bounds.pagePosition.x + model.position.x) / cellWidth());
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
    if (model.agentOwned()) return;
    const size = dimensions();
    model.resize({
      cols: Math.max(2, Math.min(1024, Math.floor(size.width / cellWidth()))),
      rows: Math.max(1, Math.min(1024, Math.floor(size.height / LINE))),
    });
  });
  effect(() => {
    model.version();
    dimensions();
    // A user gesture owns the viewport until it ends.
    if (follow.active()) return;
    if (follow.state.atBottom) {
      scroll?.scrollToEnd({ animated: false });
    } else {
      // Keep the physical viewport on the anchored reading position as
      // the grid grows or reflows; the rendered slice derives from it.
      const extent = model.grid.extent() as { totalRows: number };
      const y = follow.physicalY(extent.totalRows, rows());
      if (y !== model.position.y) {
        model.position.y = y;
        scroll?.scrollTo({ y, animated: false });
      }
    }
  });
  cleanup(() => {
    mounted = false;
    releaseScroll();
    unbind();
    model.release();
    if (reset) clearTimeout(reset);
    if (copyReset) clearTimeout(copyReset);
  });
  const pipes = () => {
    const output = model.entry().result.output;
    return output?.mode === 'pipes' ? output.stdout + output.stderr : '';
  };
  const hasOutput = () =>
    model.entry().result.mode === 'pipes' ? pipes().length > 0 : model.version() > 0;
  const needsRetry = () => model.state() === 'failed' || model.control() === 'refused';
  const unreadable = () =>
    !hasOutput() &&
    (model.state() === 'failed' || (Boolean(model.error()) && model.state() !== 'live'));
  const overlayMessage = () =>
    model.error() ||
    (model.state() === 'unavailable'
      ? tr('Waiting for retained output…')
      : needsRetry()
        ? tr('Terminal observation interrupted.')
        : '');
  const retry = () => {
    releaseScroll();
    follow.reset();
    model.atBottom = true;
    repaint();
    model.retry();
  };
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        <If when={!model.agentOwned()}>
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
            tooltip={textTooltip(() =>
              model.control() === 'held'
                ? tr('Terminal input is active')
                : tr('Focus terminal input'),
            )}
            selected={model.control() === 'held'}
            style={{ ...controlStyle(), flexDirection: 'row', alignItems: 'center', gap: 8 }}
            selectedStyle={{ backgroundColor: C.raised }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="terminal" color={C.secondary} />
          </Button>
        </If>
        <If when={model.control() === 'held'}>
          <Button
            onPress={inputAction(model.release, null)}
            tooltip={textTooltip(() => tr('Release terminal input · Ctrl+Shift+Space'))}
            style={controlStyle()}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Release input')}</Text>
          </Button>
        </If>
        <If when={model.agentOwned() || !model.local() || !model.running()}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {terminalStatus(model.entry().result.status)}
            {model.agentOwned()
              ? ` · ${tr('Read only')}`
              : !model.local()
                ? ` · ${tr('shared · view only')}`
                : ''}
          </Text>
        </If>
        <View style={{ flex: 1 }} />
        <Button
          onPress={() => void copy()}
          accessibilityLabel={tr('Copy visible terminal')}
          tooltip={textTooltip(() =>
            copied() ? tr('Copied') : tr('Copy visible terminal · Ctrl+Shift+C'),
          )}
          style={{ ...controlStyle(), width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Icon name={copied() ? 'check' : 'copy'} color={copied() ? C.accentText : C.secondary} />
        </Button>
        <If when={model.local() && model.running()}>
          <Button
            disabled={model.stopping()}
            onPress={() => confirmation.set(true)}
            accessibilityLabel={tr('Stop terminal process')}
            tooltip={textTooltip(() =>
              model.stopping() ? tr('Stopping process…') : tr('Stop terminal process'),
            )}
            style={{ ...controlStyle(), width: 32, paddingHorizontal: 8, alignItems: 'center' }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="stop" color={C.warning} />
          </Button>
        </If>
      </View>
      <View
        style={{
          flex: 1,
          minHeight: LINE,
          backgroundColor: SURFACE.background,
          padding: textTerminal ? 0 : 8,
          borderRadius: textTerminal ? 0 : radius(8),
          overflow: 'hidden',
        }}
      >
        <View
          ref={(node) => {
            body = node;
          }}
          onLayout={({ bounds: event }) => dimensions.set(event.size)}
          onPress={() => {
            input?.focus();
            model.takeControl();
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
          style={{
            flex: 1,
            minHeight: LINE,
            overflow: 'hidden',
          }}
        >
          <If when={!textTerminal && model.entry().result.mode === 'pty'}>
            <Canvas
              style={{ position: 'absolute', width: 1, height: 1, pointerEvents: 'none' }}
              draw={(context) => {
                context.font = `${FONT_SIZE}px ${FONT}`;
                const advance = context.measureText('0000000000').width / 10;
                if (advance > 0) cellWidth.set(Math.ceil(advance * 100) / 100);
              }}
            />
          </If>
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
                onScrollIntent={() => {
                  follow.intent(renderedTotal, rows());
                  holdScroll();
                }}
                onScrollDragStart={() => follow.dragStart(renderedTotal, rows())}
                onScrollEnd={({ offset }) => {
                  model.atBottom = follow.scrollEnd(offset.y, renderedTotal, rows()).atBottom;
                  releaseScroll();
                  if (model.atBottom) pin();
                  repaint();
                }}
                onScroll={(event) => {
                  model.position.y = event.offset.y;
                  // Reports coalesce per frame and a delayed one carries an
                  // old offset against the current geometry. Only a gesture
                  // opened by onScrollIntent/onScrollDragStart settles the
                  // reading state; everything while idle is the app's own
                  // scroll or a stale report. The extent is the Scroll's
                  // committed content, the coordinate its offsets are in.
                  if (!follow.active()) return;
                  model.atBottom = follow.scrolled(event.offset.y, renderedTotal, rows()).atBottom;
                  holdScroll();
                  repaint();
                }}
                style={{
                  width: Math.max(dimensions().width, frame().metadata.size.cols * cellWidth()),
                  height: dimensions().height,
                }}
              >
                <View
                  style={{
                    height: contentRows() * LINE,
                    width: frame().metadata.size.cols * cellWidth(),
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
                                  style={[
                                    {
                                      ...TERMINAL_FONT,
                                      width: cells(run()).columns * cellWidth(),
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
                                    },
                                    { numberOfLines: 1, textOverflow: 'clip', userSelect: 'none' },
                                  ]}
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
                                left: frame().metadata.cursor.x * cellWidth(),
                                top: 0,
                                width: cellWidth(),
                                height: LINE,
                                borderBottomWidth: 2,
                                borderBottomColor: SURFACE.text,
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
              <Text style={[{ ...codeTextStyle, color: SURFACE.text }, { userSelect: 'text' }]}>
                {pipes()}
              </Text>
            </Scroll>
          </If>
          <If
            when={
              !model.agentOwned() &&
              model.entry().result.mode === 'pty' &&
              model.local() &&
              model.state() === 'live'
            }
          >
            <Input
              ref={attach}
              value={inputValue()}
              onChange={({ value }) => text(value)}
              pasteBehavior="report"
              onPaste={({ text }) => {
                const pasted = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
                if (pasted) model.input([{ type: 'paste', text: pasted }]);
              }}
              onFocus={() => {
                model.takeControl();
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
                width: cellWidth(),
                height: LINE,
                left: 0,
                bottom: 0,
                opacity: 0.01,
              }}
            />
          </If>
        </View>
        <If when={unreadable()}>
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              backgroundColor: SURFACE.background,
            }}
          >
            <RegionEmptyError
              tone="danger"
              icon="terminal"
              title={model.error() || tr('Could not open terminal.')}
              retry={needsRetry() ? inputAction(retry, null) : undefined}
              retryLabel={tr('Retry terminal observation')}
            />
          </View>
        </If>
        <If when={!unreadable() && Boolean(overlayMessage())}>
          <View
            style={[
              {
                position: 'absolute',
                left: 12,
                right: 12,
                bottom: 12,
                alignItems: 'flex-end',
              },
              { pointerEvents: 'box-none' },
            ]}
          >
            <FloatingNoticeCapsule
              tone={model.error() ? 'danger' : 'warning'}
              message={overlayMessage()}
              action={
                needsRetry()
                  ? {
                      label: tr('Retry'),
                      primary: true,
                      onPress: inputAction(retry, null),
                    }
                  : undefined
              }
            />
          </View>
        </If>
      </View>
      <If when={confirmation()}>
        <ModalDialog size="alert" onCancel={() => confirmation.set(false)}>
          <If
            when={model.agentOwned()}
            else={<DialogHeader title={tr('Stop this terminal and its running process?')} />}
          >
            <DialogHeader
              title={tr('Stop this agent command?')}
              detail={`${model.entry().result.cmd}\n${tr('The agent sees it as stopped and may start it again.')}`}
            />
          </If>
          <DialogFooter>
            <SettingsButton
              label={tr('Cancel')}
              tone="quiet"
              autoFocus
              onPress={() => confirmation.set(false)}
            />
            <SettingsButton
              label={tr('Stop process')}
              accessibilityLabel={tr('Confirm stop terminal process')}
              tone="danger"
              onPress={() => {
                confirmation.set(false);
                void model.stop();
              }}
            />
          </DialogFooter>
        </ModalDialog>
      </If>
    </View>
  );
}
