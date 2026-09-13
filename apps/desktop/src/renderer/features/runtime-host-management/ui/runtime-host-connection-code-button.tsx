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
import { Button, useToast } from '@maka/ui';
import { useRuntimeHostManagementServices } from '../services-context.js';

export function RuntimeHostConnectionCodeButton(props: {
  readonly profileId: string;
  readonly label: string;
  readonly failureTitle: string;
  readonly isDisabled: boolean;
  readonly errorMessage: (error: unknown) => string;
  readonly onCreated: (connectionCode: string) => void;
  readonly onWorkingChange: (working: boolean) => void;
}) {
  const services = useRuntimeHostManagementServices();
  const toast = useToast();
  const [working, setWorking] = useState(false);

  async function create(): Promise<void> {
    setWorking(true);
    props.onWorkingChange(true);
    let connectionCode: string | undefined;
    try {
      connectionCode = await services.connectionCodes.create(props.profileId);
    } catch (error) {
      toast.error(props.failureTitle, props.errorMessage(error));
    } finally {
      setWorking(false);
      props.onWorkingChange(false);
    }
    if (connectionCode) props.onCreated(connectionCode);
  }

  return (
    <Button
      variant="primary"
      size="sm"
      label={props.label}
      isDisabled={props.isDisabled || working}
      isLoading={working}
      onClick={() => void create()}
    />
  );
}
