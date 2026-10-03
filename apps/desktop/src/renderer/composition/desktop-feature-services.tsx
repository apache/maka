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
import { WorkHubServicesProvider } from '../features/workhub';
import { createDesktopWorkHubServices } from '../platform/desktop/create-workhub-services';
import {
  ComposerStagingServicesProvider,
  ComposerSubmissionServicesProvider,
  ConversationServicesProvider,
  PlanServicesProvider,
  TaskReadinessServicesProvider,
} from '../features/conversation';
import { createDesktopComposerStagingServices } from '../platform/desktop/create-composer-staging-services.js';
import { createDesktopTaskReadinessServices } from '../platform/desktop/create-task-readiness-services.js';
import { createDesktopComposerSubmissionServices } from '../platform/desktop/create-composer-submission-services.js';
import { createDesktopConversationPlanServices } from '../platform/desktop/create-conversation-plan-services.js';
import { createDesktopConversationServices } from '../platform/desktop/create-conversation-services';
import { AppUpdateServicesProvider } from '../features/app-update/index.js';
import {
  ClientPluginRoot,
  ClientPluginServicesProvider,
} from '../features/client-plugins/index.js';
import { ExternalAgentSettingsServicesProvider } from '../features/external-agent-settings/index.js';
import { createDesktopExternalAgentSettingsServices } from '../platform/desktop/create-external-agent-settings-services.js';
import { ConnectionSettingsServicesProvider } from '../features/connection-settings';
import { GoalServicesProvider } from '../features/goals';
import { ModuleHubServicesProvider } from '../features/module-hub';
import { RuntimeHostManagementServicesProvider } from '../features/runtime-host-management';
import { SessionCollaborationServicesProvider } from '../features/session-collaboration';
import { SessionNavigationServicesProvider } from '../features/session-navigation';
import { SessionSettingsServicesProvider } from '../features/session-settings';
import { TaskEntryServicesProvider } from '../features/task-entry';
import { WorkbarServicesProvider } from '../features/workbar';
import { OverlaysServicesProvider } from '../features/overlays/index.js';
import { createDesktopAppUpdateServices } from '../platform/desktop/create-app-update-services';
import { DiagnosticsServicesProvider } from '../features/diagnostics/index.js';
import { createDesktopDiagnosticsServices } from '../platform/desktop/create-diagnostics-services.js';
import { createDesktopClientPluginServices } from '../platform/desktop/create-client-plugin-services.js';
import { createDesktopGoalServices } from '../platform/desktop/create-goal-services';
import { createDesktopConnectionSettingsServices } from '../platform/desktop/create-connection-settings-services';
import { createDesktopModuleHubServices } from '../platform/desktop/create-module-hub-services';
import { createDesktopRuntimeHostManagementServices } from '../platform/desktop/create-runtime-host-management-services';
import { createDesktopSessionCollaborationServices } from '../platform/desktop/create-session-collaboration-services';
import { createDesktopSessionNavigationServices } from '../platform/desktop/create-session-navigation-services';
import { SessionBundleServicesProvider } from '../features/session-bundle';
import { StorageUsageServicesProvider } from '../features/storage-usage';
import { createDesktopStorageUsageServices } from '../platform/desktop/create-storage-usage-services.js';
import { createDesktopSessionBundleServices } from '../platform/desktop/create-session-bundle-services.js';
import { createDesktopSessionSettingsServices } from '../platform/desktop/create-session-settings-services';
import { createDesktopTaskEntryServices } from '../platform/desktop/create-task-entry-services';
import { createDesktopWorkbarServices } from '../platform/desktop/create-workbar-services';
import { createDesktopOverlaysServices } from '../platform/desktop/create-overlays-services';
import { observeReactPerformanceMeasures } from '../platform/desktop/react-performance-measures';
import {
  createSessionCatalogController,
  SessionCatalogContext,
} from '../application/contracts/session-catalog/session-catalog-state.js';
import { createDesktopSessionCatalogSource } from '../platform/desktop/session-catalog-sync.js';
import {
  createWorkHubEnablement,
  WorkHubEnablementProvider,
} from '../application/contracts/workhub-workspace/workhub-enablement.js';
import { createDesktopWorkHubEnablementSource } from '../platform/desktop/create-workhub-enablement-source.js';
import {
  createOnboardingAuthority,
  OnboardingAuthorityProvider,
} from '../application/contracts/onboarding/onboarding-authority.js';
import { createDesktopOnboardingSource } from '../platform/desktop/create-onboarding-source.js';
import { ShellLifecycleSourcesProvider } from '../application/contracts/shell-lifecycle.js';
import { createDesktopShellLifecycleSources } from '../platform/desktop/create-shell-lifecycle-sources.js';

if (import.meta.env.DEV) {
  const stopObserving = observeReactPerformanceMeasures();
  import.meta.hot?.dispose(stopObserving);
}

export function createDesktopFeatureServices() {
  return {
    // The session catalog is renderer-owned shared state, not a bridge
    // service — it is created once with the other app singletons and read
    // through `useSessionCatalogController` so providers below do not need it
    // drilled through the shell.
    sessionCatalog: createSessionCatalogController(createDesktopSessionCatalogSource()),
    // Client-global, like the catalog: the shell, Workbar, the rail and the
    // WorkHub dock all follow the same switch.
    workHubEnablement: createWorkHubEnablement(createDesktopWorkHubEnablementSource()),
    // First-run state is read by the shell, the rail and composer readiness.
    onboarding: createOnboardingAuthority(createDesktopOnboardingSource()),
    // The root lifecycle's Desktop events; only ShellLifecycleSubscriptions reads them.
    shellLifecycle: createDesktopShellLifecycleSources(),
    appUpdate: createDesktopAppUpdateServices(),
    clientPlugins: createDesktopClientPluginServices(),
    diagnostics: createDesktopDiagnosticsServices(),
    workHub: createDesktopWorkHubServices(),
    conversation: createDesktopConversationServices(),
    conversationPlan: createDesktopConversationPlanServices(),
    composerStaging: createDesktopComposerStagingServices(),
    taskReadiness: createDesktopTaskReadinessServices(),
    composerSubmission: createDesktopComposerSubmissionServices(),
    connectionSettings: createDesktopConnectionSettingsServices(),
    externalAgentSettings: createDesktopExternalAgentSettingsServices(),
    goal: createDesktopGoalServices(),
    moduleHub: createDesktopModuleHubServices(),
    overlays: createDesktopOverlaysServices(),
    runtimeHostManagement: createDesktopRuntimeHostManagementServices(),
    sessionCollaboration: createDesktopSessionCollaborationServices(),
    sessionNavigation: createDesktopSessionNavigationServices(),
    sessionBundle: createDesktopSessionBundleServices(),
    sessionSettings: createDesktopSessionSettingsServices(),
    storageUsage: createDesktopStorageUsageServices(),
    taskEntry: createDesktopTaskEntryServices(),
    workbar: createDesktopWorkbarServices(),
  };
}

export function DesktopFeatureServicesProvider(props: {
  readonly services: ReturnType<typeof createDesktopFeatureServices>;
  readonly children?: ReactNode;
}) {
  return (
    <SessionCatalogContext.Provider value={props.services.sessionCatalog}>
    <WorkHubEnablementProvider value={props.services.workHubEnablement}>
    <OnboardingAuthorityProvider value={props.services.onboarding}>
    <ShellLifecycleSourcesProvider value={props.services.shellLifecycle}>
    <ClientPluginServicesProvider services={props.services.clientPlugins}>
      <ClientPluginRoot>
        <AppUpdateServicesProvider services={props.services.appUpdate}>
        <DiagnosticsServicesProvider services={props.services.diagnostics}>
      <ConnectionSettingsServicesProvider services={props.services.connectionSettings}>
      <ExternalAgentSettingsServicesProvider services={props.services.externalAgentSettings}>
        <RuntimeHostManagementServicesProvider services={props.services.runtimeHostManagement}>
          <SessionCollaborationServicesProvider services={props.services.sessionCollaboration}>
            <SessionNavigationServicesProvider services={props.services.sessionNavigation}>
              <SessionSettingsServicesProvider services={props.services.sessionSettings}>
                <TaskEntryServicesProvider services={props.services.taskEntry}>
                  <ModuleHubServicesProvider services={props.services.moduleHub}>
                    <GoalServicesProvider services={props.services.goal}>
                      <WorkbarServicesProvider services={props.services.workbar}>
                        <ConversationServicesProvider services={props.services.conversation}>
                          <PlanServicesProvider services={props.services.conversationPlan}>
                          <ComposerStagingServicesProvider services={props.services.composerStaging}>
                          <TaskReadinessServicesProvider services={props.services.taskReadiness}>
                          <ComposerSubmissionServicesProvider services={props.services.composerSubmission}>
                            <WorkHubServicesProvider services={props.services.workHub}>
                              <SessionBundleServicesProvider services={props.services.sessionBundle}>
                                <OverlaysServicesProvider services={props.services.overlays}>
                                  <StorageUsageServicesProvider services={props.services.storageUsage}>
                                    {props.children}
                                  </StorageUsageServicesProvider>
                                </OverlaysServicesProvider>
                              </SessionBundleServicesProvider>
                            </WorkHubServicesProvider>
                          </ComposerSubmissionServicesProvider>
                          </TaskReadinessServicesProvider>
                          </ComposerStagingServicesProvider>
                          </PlanServicesProvider>
                        </ConversationServicesProvider>
                      </WorkbarServicesProvider>
                    </GoalServicesProvider>
                  </ModuleHubServicesProvider>
                </TaskEntryServicesProvider>
              </SessionSettingsServicesProvider>
            </SessionNavigationServicesProvider>
          </SessionCollaborationServicesProvider>
        </RuntimeHostManagementServicesProvider>
      </ExternalAgentSettingsServicesProvider>
      </ConnectionSettingsServicesProvider>
        </DiagnosticsServicesProvider>
        </AppUpdateServicesProvider>
      </ClientPluginRoot>
    </ClientPluginServicesProvider>
    </ShellLifecycleSourcesProvider>
    </OnboardingAuthorityProvider>
    </WorkHubEnablementProvider>
    </SessionCatalogContext.Provider>
  );
}
