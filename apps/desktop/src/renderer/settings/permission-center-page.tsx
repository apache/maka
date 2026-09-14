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
  PermissionCenterPage as PermissionsFeature,
  type PermissionCenterPageProps,
  type PermissionCenterServices,
} from '../features/permissions/index.js';

const services: PermissionCenterServices = {
  permissions: {
    getSnapshot: () => window.maka.permissions.getSnapshot(),
    requestAccess: (id) => window.maka.permissions.requestAccess(id),
    openSystemSettings: (id) => window.maka.permissions.openSystemSettings(id),
    startDragOnboarding: (id) => window.maka.permissions.startDragOnboarding(id),
  },
  capabilities: {
    getSnapshot: (host) => window.maka.capabilities.getSnapshot(host),
  },
};

export function PermissionCenterPage(props: PermissionCenterPageProps) {
  return <PermissionsFeature {...props} services={services} />;
}
