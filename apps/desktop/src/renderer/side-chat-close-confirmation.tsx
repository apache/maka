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

import { useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy';

export const SKIP_SIDE_CHAT_CLOSE_CONFIRMATION_KEY =
  'maka-skip-side-chat-close-confirmation-v1';

export function SideChatCloseConfirmation(props: {
  open: boolean;
  sideChatCount: number;
  onCancel(): void;
  onConfirm(skipFutureConfirmations: boolean): void;
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).quoteCompanion.closeConfirmation;
  const [skipFutureConfirmations, setSkipFutureConfirmations] = useState(false);

  return (
    <Dialog
      isOpen={props.open}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
      purpose="form"
      width={420}
    >
      <Layout
        header={<DialogHeader title={copy.title(props.sideChatCount)} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text type="body" color="secondary">
                {copy.description(props.sideChatCount)}
              </Text>
              <CheckboxInput
                label={copy.dontAskAgain}
                value={skipFutureConfirmations}
                onChange={setSkipFutureConfirmations}
              />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button variant="ghost" label={copy.cancel} onClick={props.onCancel} />
              <Button
                variant="destructive"
                label={copy.confirm}
                onClick={() => props.onConfirm(skipFutureConfirmations)}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
