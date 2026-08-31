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

import { Button, useToast } from '@maka/ui';
import { useRuntimeHostManagementServices } from '../services-context.js';

export function PeerMeshPeerIdButton(props: {
  readonly peerId: string;
  readonly displayValue: string;
  readonly copyLabel: string;
  readonly copiedTitle: string;
  readonly failedTitle: string;
  readonly errorMessage: (error: unknown) => string;
  readonly className?: string;
}) {
  const services = useRuntimeHostManagementServices();
  const toast = useToast();

  async function copy(): Promise<void> {
    try {
      await services.peerMesh.copyText(props.peerId);
      toast.success(props.copiedTitle);
    } catch (error) {
      toast.error(props.failedTitle, props.errorMessage(error));
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      label={props.copyLabel}
      className={props.className}
      tooltip={props.copyLabel}
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
    >
      {props.displayValue}
    </Button>
  );
}
