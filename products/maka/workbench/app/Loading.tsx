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

import {
  cleanup,
  computed,
  createAnimatedValue,
  effect,
  platform,
  reduceMotion,
  signal,
  Text,
  untracked,
  View,
  type JSX,
  type ViewRef,
} from 'nsh';
import { appearance } from './appearance';
import { delayed } from './delayed';
import { tr } from './locale';
import {
  MARK_CYCLE,
  MARK_SAMPLES,
  MARK_STROKE,
  MARK_STROKES,
  freshWords,
  markPhase,
  strokeAt,
  thoughtTail,
} from './thinkingMark';
import { C, captionTextStyle } from './ui';
import { Icon } from './Icon';

export function LoadingIndicator(props: { label?: string; size?: number; color?: string }) {
  const size = props.size ?? 16;
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label ?? tr('Loading…')}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <If when={platform.idiom === 'terminal'}>
        <Text
          accessibilityElementsHidden
          style={{ color: props.color ?? C.muted, lineHeight: size }}
        >
          ◌
        </Text>
      </If>
      <If when={platform.idiom !== 'terminal'}>
        <View
          accessibilityElementsHidden
          style={{
            width: size,
            height: size,
            animationName: reduceMotion() ? 'none' : 'spin',
            animationDuration: 800,
            animationTimingFunction: 'linear',
            animationIterationCount: 'infinite',
            animationFrameRate: 30,
          }}
        >
          <Icon name="loader" size={size} color={props.color ?? C.muted} />
        </View>
      </If>
    </View>
  );
}

export const LOADING_DELAY_MS = 200;

function useDelayedVisibility(delay: number | undefined): () => boolean {
  const ms = delay ?? LOADING_DELAY_MS;
  if (ms <= 0) return () => true;
  return delayed(() => true, ms);
}

export function LoadingState(props: { label?: string; delay?: number }) {
  const shown = useDelayedVisibility(props.delay);
  return (
    <View
      style={{
        flex: 1,
        minHeight: 48,
        paddingVertical: 16,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <If when={shown()}>
        <LoadingIndicator size={24} label={props.label} />
        <If when={platform.idiom === 'terminal'}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {props.label ?? tr('Loading…')}
          </Text>
        </If>
      </If>
    </View>
  );
}

/**
 * Shared pulse container for skeleton placeholders: one native `glow` loop on
 * the root animates every nested block together without layout measurement.
 */
export function SkeletonGroup(props: {
  children: JSX.Element;
  label?: string;
  delay?: number;
  style?: object;
}) {
  const shown = useDelayedVisibility(props.delay);
  const terminal = platform.idiom === 'terminal';
  return (
    <If
      when={!terminal}
      else={
        <If when={shown()}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {props.label ?? tr('Loading…')}
          </Text>
        </If>
      }
    >
      <If when={shown()}>
        <View
          role="progressbar"
          accessibilityLabel={props.label ?? tr('Loading…')}
          style={[
            {
              animationName: reduceMotion() ? 'none' : 'pulse',
              animationDuration: 2000,
              animationTimingFunction: 'ease-in-out',
              animationIterationCount: 'infinite',
              animationFrameRate: 24,
            },
            props.style,
          ]}
        >
          {props.children}
        </View>
      </If>
    </If>
  );
}

export function SkeletonBlock(props: {
  width?: number | string;
  height: number;
  radius?: number;
  flex?: number;
  style?: object;
}) {
  return (
    <View
      accessibilityElementsHidden
      style={[
        {
          width: props.width,
          height: props.height,
          flex: props.flex,
          borderRadius: props.radius ?? 4,
          backgroundColor: C.line,
        },
        props.style,
      ]}
    />
  );
}

/** Compact single-line placeholder rendered immediately to keep row height steady. */
export function InlineSkeletonLine(props: {
  width?: number | string;
  height?: number;
  label?: string;
}) {
  const height = props.height ?? 12;
  return (
    <SkeletonGroup
      delay={0}
      label={props.label}
      style={{ paddingVertical: 2, alignSelf: 'flex-start' }}
    >
      <SkeletonBlock width={props.width ?? 148} height={height} radius={4} />
    </SkeletonGroup>
  );
}

const SIDEBAR_TITLE_WIDTHS = ['74%', '58%', '82%', '64%', '70%'] as const;
const SIDEBAR_META_WIDTHS = ['42%', '36%', '48%', '38%', '44%'] as const;

export function SidebarListSkeleton(props?: { rows?: number; delay?: number; label?: string }) {
  const count = props?.rows ?? 5;
  const rows = Array.from({ length: count }, (_, index) => index);
  return (
    <SkeletonGroup
      delay={props?.delay}
      label={props?.label ?? tr('Loading…')}
      style={{ flex: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 14 }}
    >
      {rows.map((index) => (
        <View style={{ gap: 6, paddingVertical: 2 }}>
          <SkeletonBlock
            width={SIDEBAR_TITLE_WIDTHS[index % SIDEBAR_TITLE_WIDTHS.length]}
            height={12}
            radius={4}
          />
          <SkeletonBlock
            width={SIDEBAR_META_WIDTHS[index % SIDEBAR_META_WIDTHS.length]}
            height={10}
            radius={3}
          />
        </View>
      ))}
    </SkeletonGroup>
  );
}

export function ConversationSkeleton(props?: { delay?: number; label?: string }) {
  return (
    <SkeletonGroup
      delay={props?.delay}
      label={props?.label ?? tr('Loading session history…')}
      style={{
        flex: 1,
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingTop: 32,
      }}
    >
      <View style={{ width: '100%', maxWidth: 720, gap: 28 }}>
        <View style={{ alignItems: 'flex-end' }}>
          <SkeletonBlock width="38%" height={32} radius={12} />
        </View>
        <View style={{ gap: 10 }}>
          <SkeletonBlock width="90%" height={12} radius={4} />
          <SkeletonBlock width="82%" height={12} radius={4} />
          <SkeletonBlock width="54%" height={12} radius={4} />
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <SkeletonBlock width="28%" height={28} radius={12} />
        </View>
        <View style={{ gap: 10 }}>
          <SkeletonBlock width="86%" height={12} radius={4} />
          <SkeletonBlock width="66%" height={12} radius={4} />
        </View>
      </View>
    </SkeletonGroup>
  );
}

const SETTINGS_LABEL_WIDTHS = [132, 158, 118, 146] as const;
const SETTINGS_DESC_WIDTHS = ['58%', '46%', '64%', '50%'] as const;

export function SettingsSkeleton(props?: {
  rows?: number;
  sections?: number;
  delay?: number;
  padded?: boolean;
  label?: string;
}) {
  const sections = Array.from({ length: props?.sections ?? 1 }, (_, index) => index);
  const rows = Array.from({ length: props?.rows ?? 3 }, (_, index) => index);
  const padded = props?.padded ?? true;
  return (
    <SkeletonGroup
      delay={props?.delay}
      label={props?.label ?? tr('Loading settings…')}
      style={{
        gap: 24,
        paddingHorizontal: padded ? 24 : 0,
        paddingTop: padded ? 4 : 0,
        paddingBottom: padded ? 24 : 0,
      }}
    >
      {sections.map((sectionIndex) => (
        <View style={{ gap: 8 }}>
          <View style={{ paddingLeft: 12, minHeight: 20, justifyContent: 'center' }}>
            <SkeletonBlock width={sectionIndex === 0 ? 96 : 112} height={11} radius={3} />
          </View>
          <View
            style={{
              backgroundColor: C.surface,
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            {rows.map((rowIndex) => (
              <View
                style={{
                  minHeight: 44,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  borderTopWidth: rowIndex === 0 ? 0 : 1,
                  borderTopColor: C.line,
                }}
              >
                <SkeletonBlock width={28} height={28} radius={8} />
                <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                  <SkeletonBlock
                    width={
                      SETTINGS_LABEL_WIDTHS[
                        (sectionIndex * 2 + rowIndex) % SETTINGS_LABEL_WIDTHS.length
                      ]
                    }
                    height={13}
                    radius={4}
                  />
                  <SkeletonBlock
                    width={
                      SETTINGS_DESC_WIDTHS[
                        (sectionIndex * 2 + rowIndex) % SETTINGS_DESC_WIDTHS.length
                      ]
                    }
                    height={10}
                    radius={3}
                  />
                </View>
                <SkeletonBlock width={34} height={20} radius={10} />
              </View>
            ))}
          </View>
        </View>
      ))}
    </SkeletonGroup>
  );
}

/**
 * Matches the height of `UsageLimitsList` without an initial delay so cards do
 * not jump once usage limits resolve.
 */
export function UsageLimitsSkeleton(props?: { rows?: number; label?: string }) {
  const rows = Array.from({ length: props?.rows ?? 2 }, (_, index) => index);
  return (
    <SkeletonGroup
      delay={0}
      label={props?.label ?? tr('Loading usage limits…')}
      style={{ gap: 8, marginTop: 4 }}
    >
      {rows.map((index) => (
        <View style={{ gap: 5 }}>
          <SkeletonBlock width={index === 0 ? 156 : 132} height={11} radius={3} />
          <SkeletonBlock width="100%" height={3} radius={2} />
          <SkeletonBlock width={index === 0 ? 104 : 92} height={10} radius={3} />
        </View>
      ))}
    </SkeletonGroup>
  );
}

/**
 * What is happening right now, with a band of light passing over it. The
 * text is drawn bright and a dimming veil of the panel's color slides across
 * it with a clear gap, so only the content's background may sit behind it.
 */
export function ShimmerText(props: { text: string; style: object }) {
  const width = signal(0);
  const sweep = createAnimatedValue(0);
  const still = () => platform.idiom === 'terminal' || reduceMotion();
  effect(() => {
    const span = width();
    if (still() || span === 0) return;
    sweep.set(-2 * span);
    void sweep.keyframes([-2 * span, 0], {
      duration: 1400 + span * 2,
      easing: 'linear',
      iterations: 'infinite',
      frameRate: 30,
    });
    cleanup(() => sweep.stop());
  });
  const veil = () => `${C.panel}66`;
  return (
    <View
      style={{ flexShrink: 1, minWidth: 0, overflow: 'hidden' }}
      onLayout={({ bounds }) => width.set(Math.round(bounds.size.width))}
    >
      <Text
        style={[{ ...props.style, color: still() ? C.secondary : C.text }, { numberOfLines: 1 }]}
      >
        {props.text}
      </Text>
      <If when={!still() && width() > 0}>
        <View
          accessibilityElementsHidden
          style={[
            {
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: 3 * width(),
              backgroundImage: `linear-gradient(90deg, ${veil()} 0%, ${veil()} 38%, ${C.panel}00 50%, ${veil()} 62%, ${veil()} 100%)`,
              transform: [{ translateX: sweep }],
            },
            { pointerEvents: 'none' },
          ]}
        />
      </If>
    </View>
  );
}

/**
 * One line of text that changes: the text it had leaves upward as it fades and
 * the new one comes up into its place, so a row whose label follows the work
 * does not blink from one label to the next.
 */
export function FadingText(props: {
  text: string;
  style: object;
  color: string;
  shimmer?: boolean;
}) {
  const still = () => platform.idiom === 'terminal' || reduceMotion();
  const shown = signal(props.text);
  const leaving = signal<string | null>(null);
  const leavingWidth = signal<number | undefined>(undefined);
  const mix = createAnimatedValue(1);
  let change = 0;
  let width = 0;
  let root: ViewRef | undefined;
  effect(() => {
    const next = props.text;
    const current = untracked(shown);
    if (next === current) return;
    shown.set(next);
    if (still()) return;
    leavingWidth.set(width > 0 ? width : undefined);
    leaving.set(current);
    // What follows the title glides to where the new one ends. Only that: an
    // animation of the whole turn would also delay the list following its end.
    root?.animateLayout({ type: 'easeInEaseOut', duration: 200 });
    const mine = ++change;
    mix.set(0);
    void mix.timing(1, { duration: 240, easing: 'easeOut' }).then(() => {
      if (mine === change) leaving.set(null);
    });
  });
  cleanup(() => mix.stop());
  return (
    <View
      ref={(view) => {
        root = view;
      }}
      onLayout={({ bounds }) => {
        width = bounds.size.width;
      }}
      style={{ flexShrink: 1, minWidth: 0 }}
    >
      <View
        style={{
          opacity: mix,
          transform: [{ translateY: mix.interpolate({ inputRange: [0, 1], outputRange: [5, 0] }) }],
        }}
      >
        <If
          when={props.shimmer}
          else={
            <Text
              style={[
                { ...props.style, color: props.color },
                { numberOfLines: 1, textOverflow: 'ellipsis' },
              ]}
            >
              {shown()}
            </Text>
          }
        >
          <ShimmerText text={shown()} style={props.style} />
        </If>
      </View>
      <If when={leaving() !== null}>
        <View
          accessibilityElementsHidden
          style={[
            {
              position: 'absolute',
              left: 0,
              top: 0,
              // Its own measured width, not the width of the title that took its place.
              width: leavingWidth(),
              opacity: mix.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 0, 0] }),
              transform: [
                { translateY: mix.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }) },
              ],
            },
            { pointerEvents: 'none' },
          ]}
        >
          <Text
            style={[
              { ...props.style, color: props.color },
              { numberOfLines: 1, textOverflow: 'ellipsis' },
            ]}
          >
            {leaving() ?? ''}
          </Text>
        </View>
      </If>
    </View>
  );
}

export function ThinkingMark(props: { size?: number }) {
  const size = () => props.size ?? 16;
  const cycle = createAnimatedValue(0);
  const still = () => platform.idiom === 'terminal' || reduceMotion();
  effect(() => {
    if (still()) return;
    void cycle.keyframes([0, 1], {
      duration: MARK_CYCLE,
      easing: 'linear',
      iterations: 'infinite',
      frameRate: 60,
    });
    cleanup(() => cycle.stop());
  });
  if (platform.idiom === 'terminal') return <Icon name="thinking" color={C.text} />;
  const unit = () => size() / 16;
  const inputRange = Array.from({ length: MARK_SAMPLES + 1 }, (_, at) => at / MARK_SAMPLES);
  const { phase, gone } = markPhase(Date.now());
  cleanup(() => gone(Date.now()));
  return (
    <View
      accessibilityElementsHidden
      style={[{ width: size(), height: size(), flexShrink: 0 }, { pointerEvents: 'none' }]}
    >
      <Each
        of={MARK_STROKES.map((stroke, index) => ({ stroke, index }))}
        key={(item) => item.index}
      >
        {(item) => {
          const [x1, y1, x2, y2] = item().stroke;
          const length = Math.hypot(x2 - x1, y2 - y1) + MARK_STROKE;
          const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
          const cx = (x1 + x2) / 2;
          const cy = (y1 + y2) / 2;
          const samples = inputRange.map((t) => strokeAt(item().index, t, phase));
          const along = (output: (at: (typeof samples)[number]) => number | string) =>
            cycle.interpolate({ inputRange, outputRange: samples.map(output) as number[] });
          return (
            <View
              style={{
                position: 'absolute',
                left: (cx - length / 2) * unit(),
                top: (cy - MARK_STROKE / 2) * unit(),
                width: length * unit(),
                height: MARK_STROKE * unit(),
                borderRadius: (MARK_STROKE / 2) * unit(),
                backgroundColor: C.text,
                opacity: still() ? 1 : along((at) => at.opacity),
                transform: still()
                  ? [{ rotate: `${angle}deg` }]
                  : [
                      { translateX: along((at) => at.x * unit()) },
                      { translateY: along((at) => at.y * unit()) },
                      { rotate: along((at) => `${angle + at.turn}deg`) },
                      { scale: along((at) => at.scale) },
                    ],
              }}
            />
          );
        }}
      </Each>
    </View>
  );
}

const PEEK_LINE = 20;
const PEEK_LINES = 3;

/**
 * The last lines of what a model is thinking, while it thinks: a window of
 * three lines that the text passes through, fading out at its top and bottom.
 * Only the content's background may sit behind it.
 */
export function ThinkingPeek(props: { text(): string; inset?: number }) {
  const shown = createAnimatedValue(reduceMotion() ? 1 : 0);
  if (!reduceMotion()) void shown.timing(1, { duration: 220 });
  // New lines push the text up; it slides there instead of jumping.
  const pushed = createAnimatedValue(0);
  let height = 0;
  // The window grows with the text to three lines, the text starting under the
  // header; past that the text passes through it. It keeps the height it has
  // reached: a new, short thought does not shrink it.
  const reached = signal(0);
  const overflowing = signal(false);
  let frame: ViewRef | undefined;
  cleanup(() => {
    shown.stop();
    pushed.stop();
  });
  const words = computed(() => freshWords(thoughtTail(props.text())));
  // The newest words, counted back from the last, each fainter than the one before it.
  const fresh = (back: number) => words().fresh.at(-1 - back) ?? '';
  // Text grows with the window's text size, and the window with it.
  const line = () => PEEK_LINE * appearance.textSize();
  const fade = (from: string, to: string) => `linear-gradient(180deg, ${from} 0%, ${to} 100%)`;
  return (
    <View
      ref={(view) => {
        frame = view;
      }}
      style={{
        // The window is as high as the text has reached, up to three lines; the
        // text is measured apart from it, so the height can follow in a glide.
        height: reached() + 6,
        marginTop: 4,
        marginLeft: props.inset ?? 24,
        overflow: 'hidden',
        opacity: shown,
      }}
    >
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          // Past three lines the text passes through: its end stays in view.
          ...(overflowing() ? { bottom: 6 } : { top: 0 }),
          transform: [{ translateY: pushed }],
        }}
        onLayout={({ bounds }) => {
          const window = line() * PEEK_LINES;
          const before = Math.max(0, height - window);
          height = bounds.size.height;
          const over = Math.max(0, height - window);
          const reach = Math.max(reached(), Math.min(height, window));
          if (reach !== reached()) {
            // Only the window and what it pushes: the list keeps following at once.
            if (!reduceMotion()) frame?.animateLayout({ type: 'easeInEaseOut', duration: 200 });
            reached.set(reach);
          }
          overflowing.set(over > 0);
          if (over === 0) {
            if (before > 0) pushed.set(0);
            return;
          }
          // Only what is pushed out at the top moves the text in view.
          const moved = over - before;
          if (moved <= 0 || moved > window || reduceMotion()) return;
          pushed.set(moved);
          void pushed.timing(0, { duration: 260, easing: 'easeOut' });
        }}
      >
        <Text
          style={[
            { ...captionTextStyle, lineHeight: PEEK_LINE, color: C.muted },
            { userSelect: 'none' },
          ]}
        >
          {words().settled}
          <Text style={{ color: `${C.muted}e0` }}>{fresh(3)}</Text>
          <Text style={{ color: `${C.muted}c0` }}>{fresh(2)}</Text>
          <Text style={{ color: `${C.muted}9c` }}>{fresh(1)}</Text>
          <Text style={{ color: `${C.muted}78` }}>{fresh(0)}</Text>
        </Text>
      </View>
      <View
        accessibilityElementsHidden
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: line() * 1.5,
            opacity: overflowing() ? 1 : 0,
            backgroundImage: fade(C.panel, `${C.panel}00`),
          },
          { pointerEvents: 'none' },
        ]}
      />
      <View
        accessibilityElementsHidden
        style={[
          {
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 6,
            backgroundImage: fade(`${C.panel}00`, C.panel),
          },
          { pointerEvents: 'none' },
        ]}
      />
    </View>
  );
}
