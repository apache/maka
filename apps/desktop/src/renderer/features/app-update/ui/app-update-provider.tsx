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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import {
  SidebarUpdateProjectionProvider,
  useToast,
  useUiLocale,
  type SidebarUpdateProjection,
} from '@maka/ui';
import { useAppUpdateController } from '../controller/use-app-update-controller.js';
import {
  getAppUpdateCopy,
  localizedAppUpdateErrorMessage,
} from '../locales/app-update-copy.js';
import {
  isAppUpdateInstallFailure,
  requestDownloadedAppUpdate,
} from '../model/install-update.js';
import { updateReminderFromStatus } from '../model/update-reminder.js';
import {
  AppUpdateAboutProjectionProvider,
  type AppUpdateAboutProjection,
} from './app-update-projection-context.js';

/**
 * Owns App Update below AppShell and publishes only reader-local projections.
 *
 * Progress pushes update the About projection. The sidebar projection keeps
 * the same identity until a downloaded/error reminder actually changes, and
 * `children` is the element built by AppShell's parent render. React can
 * therefore retain the unrelated shell instead of widening updater state back
 * to the renderer root.
 */
export function AppUpdateProvider(props: { readonly children?: ReactNode }) {
  const controller = useAppUpdateController();
  const toast = useToast();
  const locale = useUiLocale();
  const copy = getAppUpdateCopy(locale);
  const installInFlightRef = useRef(false);
  const notifiedInstallErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAppUpdateInstallFailure(controller.status)) {
      notifiedInstallErrorRef.current = null;
      return;
    }
    if (notifiedInstallErrorRef.current === controller.status.message) return;
    notifiedInstallErrorRef.current = controller.status.message;
    toast.error(copy.installFailedTitle, copy.installManualFallback);
  }, [controller.status, copy, toast]);

  const nextReminder = updateReminderFromStatus(controller.status);
  const reminderState = nextReminder?.state;
  const reminderVersion = nextReminder?.latestVersion;
  const reminder = useMemo(
    () => reminderState === undefined || reminderVersion === undefined
      ? undefined
      : { state: reminderState, latestVersion: reminderVersion },
    [reminderState, reminderVersion],
  );

  const openUpdate = useCallback(() => {
    if (reminder?.state === 'downloaded') {
      if (installInFlightRef.current) return;
      installInFlightRef.current = true;
      void requestDownloadedAppUpdate({
        installUpdate: controller.commands.installUpdate,
        confirmActiveTasks: () => toast.confirm({
          title: copy.activeTasksTitle,
          description: copy.activeTasksDescription,
          confirmLabel: copy.activeTasksConfirm,
          cancelLabel: copy.activeTasksCancel,
          destructive: true,
        }),
      })
        .then((outcome) => {
          if (outcome.kind !== 'failed' || outcome.reason === 'install_failed') return;
          toast.error(copy.installFailedTitle, copy.installManualFallback);
        })
        .catch((error) => {
          toast.error(
            copy.installFailedTitle,
            localizedAppUpdateErrorMessage(error, copy.installFailedFallback, locale),
          );
        })
        .finally(() => {
          installInFlightRef.current = false;
        });
      return;
    }
    if (!reminder) return;
    void controller.commands
      .retryUpdateDownload()
      .then((next) => {
        if (next.state !== 'error') return;
        toast.error(copy.retryFailedTitle, copy.retryFailedFallback);
      })
      .catch((error) => {
        toast.error(
          copy.retryFailedTitle,
          localizedAppUpdateErrorMessage(error, copy.retryFailedFallback, locale),
        );
      });
  }, [controller.commands, copy, locale, reminder, toast]);

  const sidebar = useMemo<SidebarUpdateProjection>(
    () => ({ reminder, onOpenUpdate: reminder ? openUpdate : undefined }),
    [openUpdate, reminder],
  );
  const about = useMemo<AppUpdateAboutProjection>(
    () => ({
      status: controller.status,
      checking: controller.checking,
      checkForUpdates: controller.commands.checkForUpdates,
    }),
    [controller.checking, controller.commands.checkForUpdates, controller.status],
  );

  return (
    <SidebarUpdateProjectionProvider value={sidebar}>
      <AppUpdateAboutProjectionProvider value={about}>
        {props.children}
      </AppUpdateAboutProjectionProvider>
    </SidebarUpdateProjectionProvider>
  );
}
