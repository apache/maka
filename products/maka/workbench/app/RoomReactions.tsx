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
  Canvas,
  cleanup,
  createAnimatedValue,
  Easing,
  effect,
  platform,
  signal,
  Storage,
  Text,
  View,
  type JSX,
} from 'nsh';
import {
  Button,
  ContextMenu,
  EmojiPicker,
  HoverCard,
  MenuItem,
  Popover,
  type EmojiAnnotation,
  type EmojiEntry,
  type EmojiGroup,
  type EmojiGroupId,
  type EmojiPickerRef,
  type EmojiSkinTone,
} from 'nsh/base';
import type {
  AgentRoomActor,
  AgentRoomReaction,
} from '../../../../packages/plugin-sdk/src/index.js';
import { Icon } from './Icon';
import { ProfileAvatar } from './ProfileAvatar';
import { tr } from './locale';
import { roomAvatarColor, roomAvatarInitial } from './roomMessage';
import { motionEnabled, popupMotionProps, ROOM_SPRING } from './roomMotion';
import {
  C,
  captionTextStyle,
  controlFocusStyle,
  floatingStyle,
  lineWidth,
  menuRowHoverStyle,
  menuRowStyle,
  radius,
  textTooltip,
} from './ui';

const RECENT_KEY = 'maka.room.reactions.recent';
const DEFAULT_REACT_KEY = 'maka.room.reactions.default';
const CURATED_REACTIONS = ['👍', '❤️', '🔥', '👀', '✅', '🤔'] as const;
const MAX_RECENT = 16;

const recentEmojis = signal<string[]>([]);
const defaultReactionSignal = signal<string>('👍');
let storageLoaded = false;

function ensureReactionPrefsLoaded() {
  if (storageLoaded) return;
  storageLoaded = true;
  void Storage.getItem(RECENT_KEY)
    .then((raw) => {
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        recentEmojis.set(
          parsed
            .filter((v): v is string => typeof v === 'string' && v.length > 0)
            .slice(0, MAX_RECENT),
        );
      }
    })
    .catch(() => {});
  void Storage.getItem(DEFAULT_REACT_KEY)
    .then((raw) => {
      if (raw && raw.trim().length > 0) defaultReactionSignal.set(raw.trim());
    })
    .catch(() => {});
}

export function defaultDoubleClickReaction(): string {
  ensureReactionPrefsLoaded();
  return defaultReactionSignal();
}

export function setDefaultDoubleClickReaction(emoji: string) {
  const clean = emoji.trim();
  if (!clean) return;
  defaultReactionSignal.set(clean);
  void Storage.setItem(DEFAULT_REACT_KEY, clean).catch(() => {});
}

export function recordRecentReaction(emoji: string) {
  const clean = emoji.trim();
  if (!clean) return;
  const next = [clean, ...recentEmojis().filter((e) => e !== clean)].slice(0, MAX_RECENT);
  recentEmojis.set(next);
  void Storage.setItem(RECENT_KEY, JSON.stringify(next)).catch(() => {});
}

/** Curated 6-slot quick bar: promotes the most recent non-curated emoji into slot 6 when present. */
export function quickReactionChoices(): string[] {
  ensureReactionPrefsLoaded();
  const base: string[] = [...CURATED_REACTIONS];
  const custom = recentEmojis().find((e) => !base.includes(e));
  if (custom) base[base.length - 1] = custom;
  return base;
}

const SPARK_ANGLES = [18, 76, 142, 204, 268, 326].map((deg) => (deg * Math.PI) / 180);
const SPARK_REACH = [22, 24, 21, 25, 22, 23];

function reactionBurstColor(emoji: string): string {
  if (
    emoji.startsWith('❤') ||
    emoji.startsWith('🔥') ||
    emoji.startsWith('🫶') ||
    emoji.startsWith('🎉')
  ) {
    return '#E87A64';
  }
  if (emoji.startsWith('✅') || emoji.startsWith('🌿') || emoji.startsWith('🍀')) {
    return C.success;
  }
  return C.accent;
}

/**
 * Ephemeral 56x56 native UI-thread Canvas burst (1 expanding ring + 6 soft sparks)
 * mounted only on reaction add/toggle-on and unmounted after 420ms.
 */
export function RoomReactionBurst(props: { emoji: string; onDone(): void }) {
  const p = createAnimatedValue(0);
  const color = reactionBurstColor(props.emoji);
  const ringRadius = p.interpolate({ inputRange: [0, 1], outputRange: [6, 22] });
  const ringAlpha = p.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 0.36, 0] });
  const sparkAlpha = p.interpolate({
    inputRange: [0, 0.15, 0.75, 1],
    outputRange: [0, 0.88, 0.5, 0],
  });
  const sparkSize = p.interpolate({ inputRange: [0, 1], outputRange: [2.0, 0.45] });
  const sparks = SPARK_ANGLES.map((angle, i) => ({
    x: p.interpolate({
      inputRange: [0, 1],
      outputRange: [28 + Math.cos(angle) * 8, 28 + Math.cos(angle) * SPARK_REACH[i]!],
    }),
    y: p.interpolate({
      inputRange: [0, 1],
      outputRange: [28 + Math.sin(angle) * 8, 28 + Math.sin(angle) * SPARK_REACH[i]!],
    }),
  }));

  effect(() => {
    let alive = true;
    void p.timing(1, { duration: 420, easing: Easing.out(Easing.cubic) }).then(() => {
      if (alive) props.onDone();
    });
    cleanup(() => {
      alive = false;
      p.stop();
    });
  });

  return (
    <Canvas
      accessibilityElementsHidden
      style={[
        {
          position: 'absolute',
          width: 56,
          height: 56,
          left: '50%',
          top: '50%',
          marginLeft: -28,
          marginTop: -28,
        },
        { pointerEvents: 'none' },
      ]}
      draw={(cx) => {
        cx.save();
        cx.globalAlpha = ringAlpha as unknown as number;
        cx.strokeStyle = color;
        cx.lineWidth = 1.25;
        cx.beginPath();
        cx.arc(28, 28, ringRadius as unknown as number, 0, Math.PI * 2);
        cx.stroke();
        cx.restore();

        cx.save();
        cx.globalAlpha = sparkAlpha as unknown as number;
        cx.fillStyle = color;
        for (const s of sparks) {
          cx.beginPath();
          cx.arc(
            s.x as unknown as number,
            s.y as unknown as number,
            sparkSize as unknown as number,
            0,
            Math.PI * 2,
          );
          cx.fill();
        }
        cx.restore();
      }}
    />
  );
}

/** Curated Chinese + collaboration search annotations augmenting EmojiPicker's built-in CLDR data. */
const EMOJI_ANNOTATION_SPECS = [
  {
    emoji: '👍',
    key: 'reaction.thumbs_up',
    keywords: ['赞', '讚', '顶', '好', '同意', 'ok', 'like', 'thumbs up'],
  },
  {
    emoji: '❤️',
    key: 'reaction.heart',
    keywords: ['爱', '愛', '喜欢', '喜歡', '赞同', 'heart', 'love'],
  },
  { emoji: '🔥', key: 'reaction.fire', keywords: ['火', '燃', '棒', '强', '牛', 'fire', 'hot'] },
  {
    emoji: '👀',
    key: 'reaction.eyes',
    keywords: ['看', '已看', '已阅', '在查', '关注', '圍觀', 'eyes', 'looking'],
  },
  {
    emoji: '✅',
    key: 'reaction.check',
    keywords: ['完成', '搞定', '通过', '确认', '对', 'done', 'check'],
  },
  {
    emoji: '🤔',
    key: 'reaction.thinking',
    keywords: ['思考', '疑问', '想想', '待商榷', 'thinking', 'hmm'],
  },
  {
    emoji: '🎉',
    key: 'reaction.party',
    keywords: ['庆祝', '慶祝', '撒花', '恭喜', '发布', 'party', 'tada'],
  },
  {
    emoji: '🚀',
    key: 'reaction.rocket',
    keywords: ['火箭', '上线', '起飞', '发布', 'rocket', 'ship'],
  },
  { emoji: '👏', key: 'reaction.clap', keywords: ['鼓掌', '厉害', '赞叹', 'clap'] },
  {
    emoji: '🙌',
    key: 'reaction.raised_hands',
    keywords: ['欢呼', '歡呼', '太棒了', '感谢', 'hooray'],
  },
  { emoji: '🫶', key: 'reaction.heart_hands', keywords: ['比心', '感谢', '喜欢', 'heart hands'] },
  {
    emoji: '💯',
    key: 'reaction.hundred',
    keywords: ['满分', '滿分', '完全同意', '100', 'perfect'],
  },
  { emoji: '😂', key: 'reaction.joy', keywords: ['笑哭', '哈哈', '搞笑', 'laugh', 'lol'] },
  { emoji: '🥹', key: 'reaction.touched', keywords: ['感动', '感動', '泪目', '暖心', 'touched'] },
  { emoji: '😮', key: 'reaction.astonished', keywords: ['惊讶', '驚訝', '哇', '震惊', 'wow'] },
  { emoji: '😅', key: 'reaction.sweat_smile', keywords: ['汗', '尴尬', '尷尬', '勉强', 'sweat'] },
  {
    emoji: '🙏',
    key: 'reaction.pray',
    keywords: ['感谢', '感謝', '拜托', '辛苦', 'thanks', 'please'],
  },
  {
    emoji: '🫡',
    key: 'reaction.salute',
    keywords: ['敬礼', '敬禮', '收到', '明白', 'salute', 'roger'],
  },
  { emoji: '⚡', key: 'reaction.zap', keywords: ['快', '闪电', '閃電', '高效', 'fast', 'zap'] },
  { emoji: '💡', key: 'reaction.bulb', keywords: ['灵感', '靈感', '主意', '想法', 'idea', 'bulb'] },
  { emoji: '🐛', key: 'reaction.bug', keywords: ['bug', '虫子', '问题', '缺陷'] },
  { emoji: '🛠️', key: 'reaction.tools', keywords: ['修', '工具', '重构', '修復', 'fix', 'tools'] },
  { emoji: '📌', key: 'reaction.pin', keywords: ['置顶', '置頂', '重点', '钉住', 'pin'] },
  { emoji: '🍉', key: 'reaction.watermelon', keywords: ['吃瓜', '围观', 'watermelon'] },
  { emoji: '☕', key: 'reaction.coffee', keywords: ['咖啡', '休息', '提神', 'coffee'] },
  { emoji: '🎯', key: 'reaction.target', keywords: ['目标', '精准', '命中', 'target', 'bullseye'] },
  { emoji: '🧠', key: 'reaction.brain', keywords: ['聪明', '思考', '架构', '大腦', 'brain'] },
  { emoji: '🤝', key: 'reaction.handshake', keywords: ['合作', '达成一致', '成交', 'handshake'] },
  { emoji: '👎', key: 'reaction.thumbs_down', keywords: ['踩', '反对', '不赞同', 'thumbs down'] },
  {
    emoji: '❓',
    key: 'reaction.question',
    keywords: ['问号', '問號', '疑问', '不确定', 'question'],
  },
] as const;

const reactionAnnotations = (): EmojiAnnotation[] =>
  EMOJI_ANNOTATION_SPECS.map((item) => ({
    emoji: item.emoji,
    label: tr(item.key),
    keywords: [tr(item.key), ...item.keywords],
  }));

const PICKER_GROUPS: { id: EmojiGroupId; glyph: string }[] = [
  { id: 'recent', glyph: '🕒' },
  { id: 'smileysEmotion', glyph: '😀' },
  { id: 'peopleBody', glyph: '👋' },
  { id: 'animalsNature', glyph: '🌿' },
  { id: 'foodDrink', glyph: '☕' },
  { id: 'travelPlaces', glyph: '🚀' },
  { id: 'activities', glyph: '🎉' },
  { id: 'objects', glyph: '💡' },
  { id: 'symbols', glyph: '❤️' },
  { id: 'flags', glyph: '🏁' },
];

const SKIN_TONES: { tone: EmojiSkinTone; hand: string }[] = [
  { tone: 'none', hand: '✋' },
  { tone: 'light', hand: '✋🏻' },
  { tone: 'mediumLight', hand: '✋🏼' },
  { tone: 'medium', hand: '✋🏽' },
  { tone: 'mediumDark', hand: '✋🏾' },
  { tone: 'dark', hand: '✋🏿' },
];

/** Full Telegram-style EmojiPicker inside a Popover (built natively on nsh/base EmojiPicker). */
export function RoomEmojiPickerPopover(props: {
  open(): boolean;
  setOpen(open: boolean): void;
  onPick(emoji: string): void;
  align?: 'start' | 'end';
  trigger: JSX.Element;
}) {
  ensureReactionPrefsLoaded();
  const tone = signal<EmojiSkinTone>('none');
  const activeGroup = signal<EmojiGroupId>('smileysEmotion');
  const hovered = signal<EmojiEntry | null>(null);
  let pickerRef: EmojiPickerRef | undefined;

  const visibleGroups = () =>
    PICKER_GROUPS.filter((g) => g.id !== 'recent' || recentEmojis().length > 0);

  const cycleTone = () => {
    const idx = SKIN_TONES.findIndex((t) => t.tone === tone());
    const next = SKIN_TONES[(idx + 1) % SKIN_TONES.length]!;
    tone.set(next.tone);
  };

  return (
    <Popover
      open={props.open()}
      onOpenChange={({ open }) => props.setOpen(open)}
      placement="top"
      align={props.align ?? 'end'}
      offset={6}
      margin={10}
      popupClass={
        motionEnabled()
          ? 'transition-all duration-150 ease-[cubic-bezier(0.18,0.82,0.24,1)]'
          : undefined
      }
      {...popupMotionProps('up')}
      popupStyle={{
        ...floatingStyle(),
        padding: 0,
      }}
      trigger={props.trigger}
    >
      <EmojiPicker
        ref={(r) => {
          pickerRef = r;
        }}
        style={{
          width: 316,
          height: 344,
          borderRadius: radius(12),
          overflow: 'hidden',
          backgroundColor: C.floating,
        }}
        recent={recentEmojis()}
        annotations={reactionAnnotations()}
        skinTone={tone()}
        columns={8}
        emojiVersion="15.1"
        autoFocus={platform.idiom !== 'terminal'}
        placeholder={tr('Search emoji')}
        accessibilityLabel={tr('Add reaction')}
        searchAccessibilityLabel={tr('Search emoji')}
        onSelect={({ emoji, base }) => {
          recordRecentReaction(base || emoji);
          props.setOpen(false);
          props.onPick(emoji);
        }}
        onCancel={() => props.setOpen(false)}
        onGroupChange={({ group }) => activeGroup.set(group)}
        onHighlightChange={({ highlighted }) => hovered.set(highlighted)}
        searchBarStyle={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginHorizontal: 10,
          marginTop: 8,
          height: 30,
          paddingLeft: 9,
          paddingRight: 4,
          borderRadius: radius(8),
          backgroundColor: C.surface,
        }}
        searchStyle={{ flex: 1, fontSize: 13, color: C.text }}
        listStyle={{ flex: 1, marginTop: 4 }}
        rowStyle={{ paddingHorizontal: 8 }}
        groupStyle={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 3 }}
        itemClass={`size-9 items-center justify-center rounded-md text-[20px] transition-colors duration-100 motion-reduce:transition-none hover:bg-[${C.raised}] focus:bg-[${C.raised}] active:scale-90`}
        searchPrefix={<Icon name="search" size={13} color={C.muted} />}
        searchSuffix={
          <Button
            accessibilityLabel={SKIN_TONES.find((t) => t.tone === tone())?.hand ?? '✋'}
            onPress={cycleTone}
            style={{
              width: 24,
              height: 24,
              borderRadius: radius(6),
              alignItems: 'center',
              justifyContent: 'center',
            }}
            hoverStyle={{ backgroundColor: C.raised }}
          >
            <Text style={{ fontSize: 14 }}>
              {SKIN_TONES.find((t) => t.tone === tone())?.hand ?? '✋'}
            </Text>
          </Button>
        }
        header={
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 8,
              paddingTop: 6,
              paddingBottom: 2,
              borderBottomWidth: 1,
              borderBottomColor: C.line,
            }}
          >
            <Each of={visibleGroups()} key={(g) => g.id}>
              {(g) => (
                <Button
                  accessibilityLabel={g().id}
                  onPress={() => {
                    activeGroup.set(g().id);
                    pickerRef?.scrollToGroup(g().id);
                  }}
                  style={{
                    width: 28,
                    height: 26,
                    borderRadius: radius(6),
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: activeGroup() === g().id ? C.surface : 'transparent',
                  }}
                  hoverStyle={{ backgroundColor: C.surface }}
                >
                  <Text style={{ fontSize: 14 }}>{g().glyph}</Text>
                </Button>
              )}
            </Each>
          </View>
        }
        footer={
          <View
            style={{
              height: 36,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 12,
              borderTopWidth: 1,
              borderTopColor: C.line,
            }}
          >
            <If
              when={hovered()}
              else={
                <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Pick an emoji…')}</Text>
              }
            >
              {(entry) => (
                <>
                  <Text style={{ fontSize: 18 }}>{entry().emoji}</Text>
                  <Text
                    style={[
                      { ...captionTextStyle, color: C.secondary, flex: 1 },
                      { numberOfLines: 1 },
                    ]}
                  >
                    {entry().label}
                  </Text>
                </>
              )}
            </If>
          </View>
        }
        empty={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('No emoji found')}</Text>
          </View>
        }
        renderGroup={(g: EmojiGroup) => (
          <Text style={{ fontSize: 11, fontWeight: '600', color: C.muted }}>{g.label}</Text>
        )}
      />
    </Popover>
  );
}

/** Compact floating hover capsule anchored at top of a Room message. */
export function RoomQuickReactBar(props: {
  pickerOpen(): boolean;
  setPickerOpen(open: boolean): void;
  onReact(emoji: string): void;
  onReply(): void;
  align?: 'left' | 'right';
}) {
  if (platform.idiom === 'terminal') return null;
  const choices = () => quickReactionChoices();
  return (
    <View
      class={
        props.pickerOpen()
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
      }
      style={{
        position: 'absolute',
        top: -12,
        ...(props.align === 'left' ? { left: 8 } : { right: 8 }),
        zIndex: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 1,
        paddingHorizontal: 5,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: C.floating,
        borderWidth: lineWidth(),
        borderColor: C.line,
      }}
    >
      <Each of={choices()} key={(emoji) => emoji}>
        {(emoji) => (
          <ContextMenu
            offset={4}
            margin={8}
            popupStyle={floatingStyle()}
            trigger={
              <Button
                accessibilityLabel={emoji()}
                onPress={() => {
                  recordRecentReaction(emoji());
                  props.onReact(emoji());
                }}
                class={motionEnabled() ? 'transition-transform duration-120 ease-out' : undefined}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                hoverStyle={
                  motionEnabled()
                    ? {
                        backgroundColor: C.surface,
                        transform: [{ scale: 1.24 }, { translateY: -2 }],
                      }
                    : { backgroundColor: C.surface }
                }
                activeStyle={motionEnabled() ? { transform: [{ scale: 0.9 }] } : undefined}
                focusStyle={controlFocusStyle()}
              >
                <Text style={{ fontSize: 13 }}>{emoji()}</Text>
              </Button>
            }
          >
            <MenuItem
              accessibilityLabel={tr('Set as double-click reaction') + ' (' + emoji() + ')'}
              onSelect={() => setDefaultDoubleClickReaction(emoji())}
              style={{ ...menuRowStyle(), minWidth: 180 }}
              hoverStyle={menuRowHoverStyle()}
              focusStyle={menuRowHoverStyle()}
            >
              <Text style={{ ...captionTextStyle, color: C.text }}>
                {tr('Set as double-click reaction') + ' (' + emoji() + ')'}
              </Text>
            </MenuItem>
          </ContextMenu>
        )}
      </Each>

      <View style={{ width: 1, height: 14, backgroundColor: C.line, marginHorizontal: 3 }} />

      <RoomEmojiPickerPopover
        open={props.pickerOpen}
        setOpen={props.setPickerOpen}
        onPick={props.onReact}
        align={props.align === 'left' ? 'start' : 'end'}
        trigger={
          <Button
            accessibilityLabel={tr('Add reaction')}
            tooltip={textTooltip(() => tr('Add reaction'))}
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            hoverStyle={{ backgroundColor: C.surface }}
            focusStyle={controlFocusStyle()}
          >
            <Icon name="smilePlus" size={13} color={C.secondary} />
          </Button>
        }
      />

      <Button
        accessibilityLabel={tr('Reply to message')}
        tooltip={textTooltip(() => tr('Reply to message'))}
        onPress={props.onReply}
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        hoverStyle={{ backgroundColor: C.surface }}
        focusStyle={controlFocusStyle()}
      >
        <Icon name="reply" size={13} color={C.secondary} />
      </Button>
    </View>
  );
}

/** Mini 14px actor avatar used inside borderless Telegram-style reaction pills (for 1-2 reactors). */
function MiniActorAvatar(props: {
  actor: AgentRoomActor;
  name(id: string): string;
  size?: number;
  overlap?: boolean;
}) {
  const size = props.size ?? 14;
  const wrapStyle = props.overlap
    ? {
        marginLeft: -4,
        borderRadius: size / 2 + 1,
        borderWidth: 1,
        borderColor: C.surface,
      }
    : undefined;
  if (props.actor.kind === 'human') {
    return (
      <View style={wrapStyle}>
        <ProfileAvatar name={tr('You')} size={size} />
      </View>
    );
  }
  const id = props.actor.sessionId;
  return (
    <View
      style={{
        ...wrapStyle,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: roomAvatarColor(id),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          fontSize: Math.max(8, Math.round(size * 0.6)),
          fontWeight: '600',
          color: '#FFFFFF',
        }}
      >
        {roomAvatarInitial(props.name(id))}
      </Text>
    </View>
  );
}

/**
 * Single borderless reaction pill:
 * - 1-2 reactors show mini 14px avatars (who reacted > redundant '1')
 * - 3+ reactors show a subtly sliding count
 * - Spring bounce + tilt + ephemeral 56px Canvas burst on add / toggle-on
 * - HoverCard reveals full reactor list with direct Agent jump
 */
function RoomReactionPill(props: {
  reaction(): AgentRoomReaction;
  burstTick(): number;
  onBurstDone?(): void;
  name(id: string): string;
  onToggle(emoji: string): void;
  onOpenAgent(id: string): void;
}) {
  const mine = () => props.reaction().actors.some((a) => a.kind === 'human');
  const count = () => props.reaction().actors.length;
  const scale = createAnimatedValue(1);
  const tilt = createAnimatedValue(0);
  const countSlide = createAnimatedValue(0);
  const burstId = signal(0);
  let prevMine = mine();
  let prevCount = count();
  // Initialize at 0 so a brand-new 0->1 reaction triggered by this client plays its pop + burst on mount.
  let prevBurstTick = 0;

  const playPop = (withBurst: boolean) => {
    if (!motionEnabled()) return;
    scale.stop();
    tilt.stop();
    scale.set(0.74);
    tilt.set(-10);
    void scale.spring(1, ROOM_SPRING.pillBounce);
    void tilt.spring(0, ROOM_SPRING.pillTilt);
    if (withBurst) burstId.set(burstId() + 1);
  };

  effect(() => {
    const tick = props.burstTick();
    if (tick > prevBurstTick) {
      prevBurstTick = tick;
      playPop(true);
    } else if (tick === 0) {
      prevBurstTick = 0;
    }
  });

  effect(() => {
    const nextMine = mine();
    const nextCount = count();
    if (!nextMine && prevMine) {
      if (motionEnabled()) {
        scale.stop();
        scale.set(0.92);
        void scale.timing(1, { duration: 110, easing: Easing.out(Easing.quad) });
      }
    } else if (nextCount > prevCount && nextMine === prevMine) {
      // Passive remote reaction from an Agent or another client: gentle spring pop without particle burst.
      playPop(false);
    }
    if (nextCount !== prevCount && nextCount >= 3 && motionEnabled()) {
      countSlide.stop();
      countSlide.set(nextCount > prevCount ? 6 : -6);
      void countSlide.timing(0, { duration: 140, easing: Easing.out(Easing.quad) });
    }
    prevMine = nextMine;
    prevCount = nextCount;
  });

  cleanup(() => {
    scale.stop();
    tilt.stop();
    countSlide.stop();
  });

  const actorLabel = (actor: AgentRoomActor) =>
    actor.kind === 'human' ? tr('You') : props.name(actor.sessionId);

  const pillButton = (
    <View style={{ position: 'relative' }}>
      <If when={burstId() > 0 && motionEnabled()}>
        <Each of={[burstId()]} key={(id) => id}>
          {() => (
            <RoomReactionBurst
              emoji={props.reaction().emoji}
              onDone={() => {
                burstId.set(0);
                props.onBurstDone?.();
              }}
            />
          )}
        </Each>
      </If>
      <Button
        accessibilityLabel={props.reaction().emoji + ' ' + String(count())}
        onPress={() => {
          recordRecentReaction(props.reaction().emoji);
          props.onToggle(props.reaction().emoji);
        }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 999,
          backgroundColor: mine() ? C.accent + '22' : C.surface,
          transform: [{ scale }],
        }}
        hoverStyle={{ backgroundColor: mine() ? C.accent + '30' : C.raised }}
        focusStyle={controlFocusStyle()}
      >
        <Text
          style={{
            fontSize: 13,
            transform: [
              {
                rotate: tilt.interpolate({
                  inputRange: [-15, 15],
                  outputRange: ['-15deg', '15deg'],
                }),
              },
            ],
          }}
        >
          {props.reaction().emoji}
        </Text>
        <If
          when={count() <= 2}
          else={
            <View style={{ overflow: 'hidden', height: 15, justifyContent: 'center' }}>
              <Text
                style={{
                  fontSize: 11.5,
                  fontWeight: mine() ? '600' : '500',
                  color: mine() ? C.accentText : C.secondary,
                  transform: [{ translateY: countSlide }],
                }}
              >
                {String(count())}
              </Text>
            </View>
          }
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Each
              of={props.reaction().actors}
              key={(a) => (a.kind === 'human' ? 'human' : a.sessionId)}
            >
              {(actor, idx) => (
                <MiniActorAvatar actor={actor()} name={props.name} overlap={idx() > 0} />
              )}
            </Each>
          </View>
        </If>
      </Button>
    </View>
  );

  if (platform.idiom === 'terminal') return pillButton;

  return (
    <HoverCard
      openDelay={240}
      closeDelay={120}
      placement="top"
      align="start"
      offset={6}
      margin={8}
      popupClass={
        motionEnabled()
          ? 'transition-all duration-150 ease-[cubic-bezier(0.18,0.82,0.24,1)]'
          : undefined
      }
      {...popupMotionProps('up')}
      popupStyle={{
        ...floatingStyle(),
        padding: 10,
        gap: 6,
        minWidth: 140,
        maxWidth: 230,
      }}
      trigger={pillButton}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ fontSize: 18 }}>{props.reaction().emoji}</Text>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{String(count())}</Text>
      </View>
      <View style={{ gap: 4 }}>
        <Each
          of={props.reaction().actors}
          key={(a) => (a.kind === 'human' ? 'human' : a.sessionId)}
        >
          {(actor) =>
            actor().kind === 'session' ? (
              <Button
                accessibilityLabel={actorLabel(actor())}
                onPress={() => {
                  const a = actor();
                  if (a.kind === 'session') props.onOpenAgent(a.sessionId);
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingHorizontal: 4,
                  paddingVertical: 2,
                  borderRadius: radius(6),
                }}
                hoverStyle={{ backgroundColor: C.surface }}
              >
                <MiniActorAvatar actor={actor()} name={props.name} size={16} />
                <Text
                  style={[{ ...captionTextStyle, color: C.text, flex: 1 }, { numberOfLines: 1 }]}
                >
                  {actorLabel(actor())}
                </Text>
              </Button>
            ) : (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingHorizontal: 4,
                  paddingVertical: 2,
                }}
              >
                <MiniActorAvatar actor={actor()} name={props.name} size={16} />
                <Text
                  style={[{ ...captionTextStyle, color: C.text, flex: 1 }, { numberOfLines: 1 }]}
                >
                  {actorLabel(actor())}
                </Text>
              </View>
            )
          }
        </Each>
      </View>
    </HoverCard>
  );
}

/** Row of reaction pills on a message, plus a quiet trailing '+' pill to add more. */
export function RoomReactionStrip(props: {
  reactions(): readonly AgentRoomReaction[];
  burstFor(emoji: string): number;
  onBurstDone?(emoji: string): void;
  name(id: string): string;
  align?: 'left' | 'right';
  onToggle(emoji: string): void;
  onOpenAgent(id: string): void;
}) {
  const pickerOpen = signal(false);
  return (
    <If when={props.reactions().length > 0}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: props.align === 'right' ? 'flex-end' : 'flex-start',
          gap: 5,
          marginTop: 4,
        }}
      >
        <Each of={props.reactions()} key={(r) => r.emoji}>
          {(reaction) => (
            <RoomReactionPill
              reaction={reaction}
              burstTick={() => props.burstFor(reaction().emoji)}
              onBurstDone={() => props.onBurstDone?.(reaction().emoji)}
              name={props.name}
              onToggle={props.onToggle}
              onOpenAgent={props.onOpenAgent}
            />
          )}
        </Each>
        <RoomEmojiPickerPopover
          open={pickerOpen}
          setOpen={(v) => pickerOpen.set(v)}
          onPick={props.onToggle}
          align={props.align === 'right' ? 'end' : 'start'}
          trigger={
            <Button
              accessibilityLabel={tr('Add reaction')}
              tooltip={textTooltip(() => tr('Add reaction'))}
              class={
                pickerOpen() || platform.idiom === 'terminal'
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
              }
              style={{
                width: 24,
                height: 22,
                borderRadius: 999,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: C.surface,
              }}
              hoverStyle={{ backgroundColor: C.raised }}
              focusStyle={controlFocusStyle()}
            >
              <Icon name="smilePlus" size={12} color={C.secondary} />
            </Button>
          }
        />
      </View>
    </If>
  );
}
