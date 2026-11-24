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

import { Overlay, Text, View, safeArea, type JSX } from 'nsh';
import { AlertDialog, Button, MenuItem, Sheet, Toast, ToastStack } from 'nsh/base';

export const glass = {
  borderRadius: 24,
  borderCurve: 'continuous',
  glassEffect: 'regular',
  backdropFilter: 'blur(20px)',
} as const;

export function Action(props: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Button
      accessibilityLabel={props.title}
      disabled={props.disabled}
      onPress={props.onPress}
      class={
        props.primary
          ? 'min-h-11 justify-center rounded-xl bg-primary px-4 active:opacity-75 transition-opacity duration-150 disabled:opacity-50'
          : 'min-h-11 justify-center rounded-xl bg-muted px-4 active:opacity-75 transition-opacity duration-150 disabled:opacity-50'
      }
    >
      <Text class={props.primary ? 'text-primary-foreground font-semibold' : 'text-foreground'}>
        {props.title}
      </Text>
    </Button>
  );
}

export function Panel(props: { open: boolean; close: () => void; children?: JSX.Element }) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={({ open }) => {
        if (!open) props.close();
      }}
      closeOnSwipe
      detents={['large']}
      popupClass="bg-background rounded-t-2xl pb-[env(safe-area-inset-bottom)] overflow-hidden"
      backdropClass="bg-scrim"
    >
      {props.children}
    </Sheet>
  );
}

export function Command(props: { title: string; select: () => void; destructive?: boolean }) {
  return (
    <MenuItem
      onSelect={props.select}
      class="min-h-11 justify-center rounded-lg px-3 focus:bg-muted"
    >
      <Text class={props.destructive ? 'text-destructive' : 'text-foreground'}>{props.title}</Text>
    </MenuItem>
  );
}

export async function confirmDestructive(title: string, label: string): Promise<boolean> {
  const { action } = await AlertDialog.show({
    title,
    actions: [
      { id: 'cancel', label: '取消', role: 'cancel' },
      { id: 'confirm', label, role: 'destructive' },
    ],
  });
  return action === 'confirm';
}

export function Feedback(props: { message: string | null; dismiss: () => void }) {
  return (
    <Overlay class="inset-x-0 top-0 items-center" style={{ paddingTop: safeArea().top + 8 }}>
      <ToastStack placement="topCenter" class="w-80">
        <If when={props.message}>
          <Toast class="rounded-xl bg-card px-4 py-3" onDismissRequest={props.dismiss}>
            <View onPress={props.dismiss}>
              <Text class="text-foreground">{props.message}</Text>
            </View>
          </Toast>
        </If>
      </ToastStack>
    </Overlay>
  );
}
