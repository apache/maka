/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { Canvas, Path2D, platform, Text, View, type JSX } from 'nsh';
import { C, IconButton } from './ui';
import { currentLocale } from './locale';
import { qt as translate } from '../../../../plugins/application/quick-tools/shared/i18n';

export function quickToolsLabel(text: string, ...values: unknown[]) {
  currentLocale();
  return translate(text, ...values);
}
export const quickFieldText = { fontSize: 14, lineHeight: 20 };
export const quickFieldHeight = 40;
export const quickFieldPadding = 8;
// The native multiline editor lays its first line out from the top.
export const quickEditorInset = (quickFieldHeight - quickFieldText.lineHeight) / 2;
export const quickFieldStyle = () => ({
  ...quickFieldText,
  minHeight: quickFieldHeight,
  paddingVertical: quickFieldPadding,
  paddingHorizontal: 0,
  color: C.text,
  placeholderColor: C.muted,
  backgroundColor: 'transparent',
});

const makaMark = new Path2D('M6.1 1.3h3.8 M1.35 14.35 8 3.55l6.65 10.8 M4.95 8.5 8 13.6l3.05-5.1');
export function QuickToolsMark() {
  const color = '#47A3E2';
  if (platform.idiom === 'terminal')
    return (
      <Text accessibilityElementsHidden style={{ color }}>
        M
      </Text>
    );
  return (
    <Canvas
      accessibilityElementsHidden
      style={[{ width: 16, height: 16, flexShrink: 0 }, { pointerEvents: 'none' }]}
      draw={(cx) => {
        cx.strokeStyle = color;
        cx.lineWidth = 1.45;
        cx.lineCap = 'round';
        cx.lineJoin = 'round';
        cx.stroke(makaMark);
      }}
    />
  );
}

export function QuickToolsBar(props: {
  children: JSX.Element;
  showSettings?: boolean;
  expanding?: boolean;
  openSettings(): void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: props.expanding ? 'flex-start' : 'center',
        minHeight: 60,
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 8,
        backgroundColor: C.surface,
        borderBottomWidth: 1,
        borderColor: C.line,
      }}
    >
      {props.children}
      <If when={props.showSettings !== false}>
        <View style={props.expanding ? { height: quickFieldHeight, justifyContent: 'center' } : {}}>
          <IconButton
            label={quickToolsLabel('快捷工具设置')}
            icon="settings"
            onPress={props.openSettings}
          />
        </View>
      </If>
    </View>
  );
}
