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

import { tr } from './locale';
import { platform, Scroll, signal, Text, View } from 'nsh';
import { Button, DiffView } from 'nsh/base';
import { ToolCopyButton as Copy, ToolFieldDivider, type ToolSource } from './ToolSource';
import { TokenCount } from './TokenCount';
import type { ToolChange, ToolProcess, ToolProjection, ToolRead, ToolSection } from './toolCards';
import { C, bodyTextStyle, captionTextStyle, codeTextStyle, isDark, quietFocusStyle } from './ui';
import { Icon } from './Icon';
import { codePieces, foldCodeLines } from './codePieces';

const desktop = platform.idiom !== 'terminal';

/** What a tool printed, or what a change added, removed or warns about. */
type Tone = 'added' | 'removed' | 'warning' | 'output';

function toneColor(tone?: Tone | 'error') {
  return tone === 'removed' || tone === 'error'
    ? C.danger
    : tone === 'added'
      ? C.success
      : tone === 'warning'
        ? C.warning
        : tone === 'output' && desktop
          ? C.secondary
          : C.text;
}

function ToolText(props: {
  label: string;
  text: string;
  copyText?: string;
  copyLabel: string;
  source: ToolSource;
  userScroll(): void;
  gutter?: string;
  tone?: Tone;
  wrap?: boolean;
  emptyText?: string;
}) {
  const fullText = () => props.copyText ?? props.text;
  return (
    <View style={{ minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text
          style={[
            { ...captionTextStyle, color: C.muted, flex: 1, minWidth: 0 },
            { numberOfLines: 1, textOverflow: 'ellipsis', userSelect: 'none' },
          ]}
        >
          {props.label}
        </Text>
        <If when={fullText() !== ''}>
          <Copy label={props.copyLabel} text={fullText} source={props.source} />
        </If>
      </View>
      <CodeText
        text={props.text}
        gutter={props.gutter}
        tone={props.tone}
        wrap={props.wrap}
        emptyText={props.emptyText}
        userScroll={props.userScroll}
      />
    </View>
  );
}

function CodeText(props: {
  text: string;
  userScroll(): void;
  gutter?: string;
  tone?: Tone;
  prompt?: boolean;
  emptyText?: string;
  /** Long lines wrap at the column instead of scrolling sideways. */
  wrap?: boolean;
}) {
  const color = () => toneColor(props.tone);
  const width = signal(0);
  const items = () =>
    desktop
      ? codePieces(props.text, props.gutter, props.wrap ? width() : undefined)
      : [{ index: 0, text: props.text, gutter: props.gutter }];
  const pieces = () => (
    <Each of={items()} key="index">
      {(piece) => (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <If when={piece().gutter !== undefined}>
            <Text
              accessibilityElementsHidden
              style={[
                { ...codeTextStyle, color: C.muted, textAlign: 'right' },
                { pointerEvents: 'none', userSelect: 'none' },
              ]}
            >
              {piece().gutter}
            </Text>
            <View
              style={[
                { width: 1, alignSelf: 'stretch', backgroundColor: C.line },
                { pointerEvents: 'none' },
              ]}
            />
          </If>
          <Text
            style={[
              {
                ...codeTextStyle,
                color: color(),
                ...(props.wrap ? { flex: 1, minWidth: 0 } : {}),
              },
              { userSelect: 'text' },
            ]}
          >
            <If when={props.prompt && piece().index === 0}>
              <Text style={[{ color: C.muted }, { userSelect: 'none' }]}>$ </Text>
            </If>
            {piece().text}
          </Text>
        </View>
      )}
    </Each>
  );
  return (
    <If
      when={props.text !== ''}
      else={
        <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'none' }]}>
          {props.emptyText ?? tr('Empty recorded text.')}
        </Text>
      }
    >
      {props.wrap ? (
        <View style={{ minWidth: 0 }} onLayout={({ bounds }) => width.set(bounds.size.width)}>
          <If when={width() > 0}>{pieces()}</If>
        </View>
      ) : (
        <Scroll horizontal onScrollIntent={props.userScroll}>
          <View style={{ minWidth: 0 }}>{pieces()}</View>
        </Scroll>
      )}
    </If>
  );
}

function Read(props: {
  value: ToolRead;
  path?(): string | undefined;
  source: ToolSource;
  userScroll(): void;
}) {
  const value = props.value;
  const lines = value.content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const gutter = lines.map((_, index) => String(value.offset + index + 1)).join('\n');
  const label = () =>
    value.partialLine
      ? tr('Read lines · partial line · {total} total', { total: value.totalLines })
      : tr('Read lines {first}–{last} / {total}', {
          first: String(value.returnedLines ? value.offset + 1 : value.offset),
          last: String(value.offset + value.returnedLines),
          total: value.totalLines,
        });
  return (
    <View style={{ gap: 8 }}>
      <View style={{ minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 }}>
            <If when={props.path?.()}>
              <Text
                style={[
                  { ...captionTextStyle, color: C.muted, flexShrink: 1, minWidth: 0 },
                  { numberOfLines: 1, textOverflow: 'ellipsis-start', userSelect: 'text' },
                ]}
              >
                {props.path?.()}
              </Text>
              <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'none' }]}>
                {' · '}
              </Text>
            </If>
            <Text
              style={[
                {
                  ...captionTextStyle,
                  color: C.muted,
                  flexShrink: props.path?.() ? 0 : 1,
                  minWidth: 0,
                },
                { numberOfLines: 1, textOverflow: 'ellipsis', userSelect: 'none' },
              ]}
            >
              {label()}
            </Text>
          </View>
          <Copy label={tr('Copy read contents')} text={() => value.content} source={props.source} />
        </View>
        <CodeText text={value.content} gutter={gutter} userScroll={props.userScroll} />
      </View>
      <If when={value.partialLine}>
        <Text style={[{ ...captionTextStyle, color: C.warning }, { userSelect: 'none' }]}>
          {tr('This original result contains part of a line.')}
        </Text>
      </If>
      <If when={value.hasMore}>
        <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'none' }]}>
          {tr('More lines are available.')}
        </Text>
      </If>
    </View>
  );
}

function Process(props: { value: ToolProcess; source: ToolSource; userScroll(): void }) {
  const value = props.value;
  const label = () =>
    ({
      starting: tr('Preparing at capture'),
      running: tr('Running at capture'),
      completed: tr('Completed'),
      failed: tr('Failed'),
      timed_out: tr('Timed out'),
      cancelled: tr('Stopped'),
      orphaned: tr('Outcome unknown'),
    })[value.status];
  const exited = value.exitCode !== null && value.exitCode !== 0;
  const failed =
    value.status !== 'cancelled' &&
    (['failed', 'timed_out', 'orphaned'].includes(value.status) || exited);
  const output = value.output;
  return (
    <View style={{ gap: desktop ? 12 : 8 }}>
      <View style={{ minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flexDirection: 'row', flex: 1, minWidth: 0 }}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Shell')} · </Text>
            <Text
              style={[
                { ...captionTextStyle, color: C.muted, flex: 1, minWidth: 0 },
                // A long working folder keeps its last folders in view.
                { numberOfLines: 1, textOverflow: 'ellipsis-start', userSelect: 'text' },
              ]}
            >
              {value.cwd}
            </Text>
          </View>
          <Copy
            label={tr('Copy recorded command')}
            text={() => value.command}
            source={props.source}
          />
        </View>
        <CodeText text={value.command} prompt wrap={desktop} userScroll={props.userScroll} />
      </View>
      <ToolFieldDivider />
      <If when={value.status !== 'completed' || exited}>
        <Text
          style={[
            {
              ...captionTextStyle,
              color: failed ? C.danger : value.status === 'cancelled' ? C.warning : C.muted,
            },
            { userSelect: 'none' },
          ]}
        >
          {label()}
          {exited ? ` · ${tr('Exit {code}', { code: String(value.exitCode) })}` : ''}
        </Text>
      </If>
      <If when={value.failure !== null}>
        <Text style={[{ ...bodyTextStyle, color: C.danger }, { userSelect: 'text' }]}>
          {value.failure}
        </Text>
      </If>
      <If when={output === null}>
        <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'none' }]}>
          {tr('No output recorded.')}
        </Text>
      </If>
      {output?.mode === 'pipes' ? (
        <View style={{ gap: 8 }}>
          <If when={output.stdout !== '' || output.stderr === ''}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <CodeText
                  text={output.stdout}
                  tone="output"
                  wrap={desktop}
                  userScroll={props.userScroll}
                />
              </View>
              <If when={output.stdout !== ''}>
                <Copy label={tr('Copy stdout')} text={() => output.stdout} source={props.source} />
              </If>
            </View>
          </If>
          <If when={output.stderr !== ''}>
            <ToolText
              label="stderr"
              text={output.stderr}
              copyLabel={tr('Copy stderr')}
              source={props.source}
              userScroll={props.userScroll}
              tone="warning"
              wrap={desktop}
            />
          </If>
          <If when={output.stdoutTruncated || output.stderrTruncated}>
            <Text style={[{ ...captionTextStyle, color: C.warning }, { userSelect: 'none' }]}>
              {tr('The recorded process output is truncated.')}
            </Text>
          </If>
        </View>
      ) : output?.mode === 'pty' ? (
        <View style={{ gap: 8 }}>
          <ToolText
            label={tr('Terminal scrollback')}
            text={output.scrollback}
            copyLabel={tr('Copy terminal scrollback')}
            source={props.source}
            userScroll={props.userScroll}
          />
          <ToolText
            label={tr('Terminal screen')}
            text={output.screen}
            copyLabel={tr('Copy terminal screen')}
            source={props.source}
            userScroll={props.userScroll}
          />
          <If when={output.lastAlternateScreen !== null}>
            <ToolText
              label={tr('Last alternate screen')}
              text={output.lastAlternateScreen!}
              copyLabel={tr('Copy last alternate screen')}
              source={props.source}
              userScroll={props.userScroll}
            />
          </If>
          <If when={output.truncated}>
            <Text style={[{ ...captionTextStyle, color: C.warning }, { userSelect: 'none' }]}>
              {tr('The recorded terminal output is truncated.')}
            </Text>
          </If>
        </View>
      ) : null}
      <If when={output?.redacted}>
        <Text style={[{ ...captionTextStyle, color: C.warning }, { userSelect: 'none' }]}>
          {tr('The Host redacted parts of this recorded output.')}
        </Text>
      </If>
    </View>
  );
}

function FileDiff(props: {
  path: string;
  before: string;
  after: string;
  lineNumbers?: boolean;
  userScroll(): void;
}) {
  const height = signal(72);
  let previousOffset = 0;
  return (
    <If
      when={props.before !== props.after}
      else={<Text style={{ ...captionTextStyle, color: C.muted }}>{tr('No text changes')}</Text>}
    >
      <View accessibilityLabel={tr('File changes')}>
        <DiffView
          language={props.path}
          oldValue={props.before}
          newValue={props.after}
          layout="unified"
          indicators="classic"
          lineNumbers={props.lineNumbers ?? false}
          fontSize={codeTextStyle.fontSize}
          lineHeight={codeTextStyle.lineHeight}
          softWrap
          style={{ height: height(), borderRadius: 6, overflow: 'hidden' }}
          onScroll={({ offset, contentSize }) => {
            if (contentSize.height > 0)
              height.set(Math.min(240, Math.max(codeTextStyle.lineHeight, contentSize.height)));
            if (offset.y !== previousOffset) {
              previousOffset = offset.y;
              props.userScroll();
            }
          }}
        />
      </View>
    </If>
  );
}

function FilePath(props: { path: string }) {
  return (
    <Text style={[{ ...captionTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
      {props.path}
    </Text>
  );
}

function Change(props: { value: ToolChange; source: ToolSource; userScroll(): void }) {
  const value = props.value;
  if (value.phase === 'requested') {
    if (value.operation === 'patch')
      return (
        <View style={{ gap: 12 }}>
          <Each of={value.files} key="index">
            {(file) => (
              <View style={{ gap: 6 }}>
                <FilePath path={file().path} />
                <If when={file().operation === 'delete'}>
                  <Text style={{ ...captionTextStyle, color: C.danger }}>{tr('Delete file')}</Text>
                </If>
                <If when={file().operation === 'create' && file().hunks.length === 0}>
                  <Text style={{ ...captionTextStyle, color: C.secondary }}>
                    {tr('Empty file.')}
                  </Text>
                </If>
                <Each of={file().hunks} key="index">
                  {(hunk) => (
                    <View style={{ gap: 4 }}>
                      <If when={hunk().context !== ''}>
                        <Text style={{ ...codeTextStyle, color: C.muted }}>{hunk().context}</Text>
                      </If>
                      <FileDiff
                        path={file().path}
                        before={hunk().before}
                        after={hunk().after}
                        userScroll={props.userScroll}
                      />
                    </View>
                  )}
                </Each>
              </View>
            )}
          </Each>
        </View>
      );
    return (
      <View style={{ gap: 6 }}>
        <FilePath path={value.path} />
        {value.operation === 'edit' ? (
          <FileDiff
            path={value.path}
            before={value.before}
            after={value.after}
            userScroll={props.userScroll}
          />
        ) : value.previous === undefined ? (
          <ToolText
            label={tr('Requested file contents')}
            text={value.content}
            copyLabel={tr('Copy requested file contents')}
            source={props.source}
            userScroll={props.userScroll}
          />
        ) : (
          <FileDiff
            path={value.path}
            before={value.previous}
            after={value.content}
            lineNumbers
            userScroll={props.userScroll}
          />
        )}
      </View>
    );
  }
  if (value.operation === 'patch')
    return (
      <Text style={[{ ...captionTextStyle, color: C.secondary }, { userSelect: 'none' }]}>
        {tr('Patch applied')}
      </Text>
    );
  const summary = () =>
    value.operation === 'write'
      ? [tr('Recorded write'), tr('{count} bytes', { count: value.bytes })]
      : [
          tr('Recorded edit'),
          tr('tool.replacements_count', { count: value.replacements }),
          value.startLine !== null && value.endLine !== null
            ? value.startLine === value.endLine
              ? tr('Recorded line {line}', { line: String(value.startLine) })
              : tr('Recorded lines {first}–{last}', {
                  first: String(value.startLine),
                  last: String(value.endLine),
                })
            : '',
        ];
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="check" color={C.accentText} />
        <Text style={[{ ...captionTextStyle, color: C.secondary }, { userSelect: 'none' }]}>
          {summary().filter(Boolean).join(' · ')}
        </Text>
      </View>
      <If when={value.operation === 'write' && value.previous === null}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Previous contents were not included in this original result.')}
        </Text>
      </If>
      <If
        when={
          value.operation === 'edit' && value.matchedVia !== null && value.matchedVia !== 'exact'
        }
      >
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('The editor matched a normalized version of the requested text.')}
        </Text>
      </If>
    </View>
  );
}

function Sections(props: {
  items: ToolSection[];
  field?: 'arguments' | 'result';
  source: ToolSource;
  userScroll(): void;
}) {
  return (
    <View style={{ gap: 12, minWidth: 0 }}>
      <Each of={props.items} key="index">
        {(section) => {
          const expanded = signal(false);
          const plainText = () => {
            const value = section().text;
            return typeof value === 'string' ? value : '';
          };
          const tokens = () => {
            const value = section().text;
            return typeof value === 'string' ? undefined : value;
          };
          const isCode = () => section().style === 'code' && tokens() === undefined;
          const folded = () =>
            desktop && isCode() && props.field === 'arguments' && plainText() !== ''
              ? foldCodeLines(plainText())
              : null;
          const shownCode = () => {
            const fold = folded();
            return fold && fold.hiddenLines > 0 && !expanded() ? fold.preview : plainText();
          };
          const codeTone = (): Tone | undefined =>
            section().tone === 'error' || section().tone === 'removed'
              ? 'removed'
              : section().tone === 'warning'
                ? 'warning'
                : section().tone === 'added'
                  ? 'added'
                  : props.field === 'result'
                    ? 'output'
                    : undefined;
          const foldLabel = () =>
            expanded()
              ? tr('Show fewer lines')
              : tr('tool.show_more_lines', { count: folded()?.hiddenLines ?? 0 });
          return (
            <View style={{ gap: isCode() ? 0 : 4, minWidth: 0 }}>
              <If
                when={isCode()}
                else={
                  <>
                    <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'none' }]}>
                      {section().label}
                    </Text>
                    <If
                      when={tokens()}
                      else={
                        <Text
                          style={[
                            { ...bodyTextStyle, color: toneColor(section().tone) },
                            { userSelect: 'text' },
                          ]}
                        >
                          {plainText() || tr('(empty)')}
                        </Text>
                      }
                    >
                      <View style={{ alignItems: 'flex-start' }}>
                        <TokenCount
                          label={section().label}
                          value={tokens()!.tokens}
                          prefix={tokens()!.prefix}
                        />
                      </View>
                    </If>
                  </>
                }
              >
                <ToolText
                  label={
                    folded() && folded()!.hiddenLines > 0
                      ? `${section().label} · ${tr('tool.code_lines_count', { count: folded()!.totalLines })}`
                      : section().label
                  }
                  text={shownCode()}
                  copyText={plainText()}
                  copyLabel={tr('Copy {label}', { label: section().label })}
                  tone={codeTone()}
                  wrap={desktop}
                  emptyText={tr('(empty)')}
                  source={props.source}
                  userScroll={props.userScroll}
                />
                <If when={folded() && folded()!.hiddenLines > 0}>
                  <Button
                    accessibilityLabel={foldLabel()}
                    onPress={() => expanded.set(!expanded())}
                    style={{
                      alignSelf: 'flex-start',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      minHeight: 28,
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      borderRadius: 8,
                      backgroundColor: C.cardRaised,
                      marginTop: 8,
                    }}
                    hoverStyle={isDark() ? { opacity: 0.82 } : { backgroundColor: C.line }}
                    activeStyle={{ opacity: 0.68 }}
                    focusStyle={quietFocusStyle()}
                  >
                    <Text
                      style={[
                        { ...captionTextStyle, color: C.secondary, fontWeight: '500' },
                        { userSelect: 'none' },
                      ]}
                    >
                      {foldLabel()}
                    </Text>
                    <Icon name={expanded() ? 'up' : 'down'} size={12} color={C.secondary} />
                  </Button>
                </If>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

export function ToolReader(props: {
  value: ToolProjection;
  field?: 'arguments' | 'result';
  readPath?(): string | undefined;
  source: ToolSource;
  userScroll(): void;
}) {
  const value = props.value;
  switch (value.kind) {
    case 'read':
      return (
        <Read
          value={value.value}
          path={props.readPath}
          source={props.source}
          userScroll={props.userScroll}
        />
      );
    case 'process':
      return <Process value={value.value} source={props.source} userScroll={props.userScroll} />;
    case 'change':
      return <Change value={value.value} source={props.source} userScroll={props.userScroll} />;
    case 'sections':
      return (
        <Sections
          items={(props.value as Extract<ToolProjection, { kind: 'sections' }>).sections}
          field={props.field}
          source={props.source}
          userScroll={props.userScroll}
        />
      );
    case 'failure':
      return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <Icon name="statusError" color={C.danger} />
          <Text
            style={[
              { ...bodyTextStyle, color: C.text, flex: 1, minWidth: 0 },
              { userSelect: 'text' },
            ]}
          >
            {(props.value as Extract<ToolProjection, { kind: 'failure' }>).message}
          </Text>
        </View>
      );
  }
}
