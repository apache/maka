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

import type { ReactNode } from 'react';
import { ConnectionSettingsServicesProvider } from '../features/connection-settings';
import { GoalServicesProvider } from '../features/goals';
import { ModuleHubServicesProvider } from '../features/module-hub';
import { RuntimeHostManagementServicesProvider } from '../features/runtime-host-management';
import { SessionCollaborationServicesProvider } from '../features/session-collaboration';
import { SessionNavigationServicesProvider } from '../features/session-navigation';
import { SessionSettingsServicesProvider } from '../features/session-settings';
import { TaskEntryServicesProvider } from '../features/task-entry';
import { WorkbarServicesProvider } from '../features/workbar';
import { createDesktopGoalServices } from '../platform/desktop/create-goal-services';
import { createDesktopConnectionSettingsServices } from '../platform/desktop/create-connection-settings-services';
import { createDesktopModuleHubServices } from '../platform/desktop/create-module-hub-services';
import { createDesktopRuntimeHostManagementServices } from '../platform/desktop/create-runtime-host-management-services';
import { createDesktopSessionCollaborationServices } from '../platform/desktop/create-session-collaboration-services';
import { createDesktopSessionNavigationServices } from '../platform/desktop/create-session-navigation-services';
import { createDesktopSessionSettingsServices } from '../platform/desktop/create-session-settings-services';
import { createDesktopTaskEntryServices } from '../platform/desktop/create-task-entry-services';
import { createDesktopWorkbarServices } from '../platform/desktop/create-workbar-services';

export function createDesktopFeatureServices() {
  return {
    connectionSettings: createDesktopConnectionSettingsServices(),
    goal: createDesktopGoalServices(),
    moduleHub: createDesktopModuleHubServices(),
    runtimeHostManagement: createDesktopRuntimeHostManagementServices(),
    sessionCollaboration: createDesktopSessionCollaborationServices(),
    sessionNavigation: createDesktopSessionNavigationServices(),
    sessionSettings: createDesktopSessionSettingsServices(),
    taskEntry: createDesktopTaskEntryServices(),
    workbar: createDesktopWorkbarServices(),
  };
}

export function DesktopFeatureServicesProvider(props: {
  readonly services: ReturnType<typeof createDesktopFeatureServices>;
  readonly children?: ReactNode;
}) {
  return (
    <ConnectionSettingsServicesProvider services={props.services.connectionSettings}>
      <RuntimeHostManagementServicesProvider services={props.services.runtimeHostManagement}>
        <SessionCollaborationServicesProvider services={props.services.sessionCollaboration}>
        <SessionNavigationServicesProvider services={props.services.sessionNavigation}>
          <SessionSettingsServicesProvider services={props.services.sessionSettings}>
            <TaskEntryServicesProvider services={props.services.taskEntry}>
              <ModuleHubServicesProvider services={props.services.moduleHub}>
                <GoalServicesProvider services={props.services.goal}>
                  <WorkbarServicesProvider services={props.services.workbar}>
                    {props.children}
                  </WorkbarServicesProvider>
                </GoalServicesProvider>
              </ModuleHubServicesProvider>
            </TaskEntryServicesProvider>
          </SessionSettingsServicesProvider>
        </SessionNavigationServicesProvider>
        </SessionCollaborationServicesProvider>
      </RuntimeHostManagementServicesProvider>
    </ConnectionSettingsServicesProvider>
  );
}
