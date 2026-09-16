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

import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core';
import { useRuntimeHostManagementServices } from '../services-context.js';

export interface RuntimeHostAddComputerCopy {
  readonly addComputer: string;
  readonly useConnectionCode: string;
  readonly useConnectionCodeDescription: string;
  readonly addSshComputer: string;
  readonly addSshComputerDescription: string;
  readonly addWslEnvironment: string;
  readonly addWslEnvironmentDescription: string;
  readonly configureManually: string;
  readonly configureManuallyDescription: string;
  readonly cancel: string;
}

export function RuntimeHostAddComputerMenu(props: {
  readonly copy: RuntimeHostAddComputerCopy;
  readonly isDisabled: boolean;
  readonly isManualConfigurationOpen: boolean;
  readonly onUseConnectionCode: () => void;
  readonly onSetupSsh: () => void;
  readonly onSetupWsl: () => void;
  readonly onConfigureManually: () => void;
}) {
  const services = useRuntimeHostManagementServices();
  return (
    <DropdownMenu
      hasChevron
      placement="below"
      menuWidth={320}
      button={{
        variant: 'primary',
        size: 'sm',
        label: props.copy.addComputer,
        isDisabled: props.isDisabled,
      }}
    >
      <DropdownMenuItem
        label={props.copy.useConnectionCode}
        description={props.copy.useConnectionCodeDescription}
        onClick={props.onUseConnectionCode}
      />
      <DropdownMenuItem
        label={props.copy.addSshComputer}
        description={props.copy.addSshComputerDescription}
        onClick={props.onSetupSsh}
      />
      {services.supportsWsl ? (
        <DropdownMenuItem
          label={props.copy.addWslEnvironment}
          description={props.copy.addWslEnvironmentDescription}
          onClick={props.onSetupWsl}
        />
      ) : null}
      <DropdownMenuItem
        label={
          props.isManualConfigurationOpen
            ? props.copy.cancel
            : props.copy.configureManually
        }
        description={props.copy.configureManuallyDescription}
        onClick={props.onConfigureManually}
      />
    </DropdownMenu>
  );
}
