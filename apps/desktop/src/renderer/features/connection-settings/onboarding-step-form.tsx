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

// A wizard step that takes focus when it appears.
//
// A step replaces the whole form in place: the button the user pressed unmounts
// with the step it belonged to, and focus falls to `document.body`. The
// settings route has not moved, so the page's level focus never re-runs. The
// step that arrives is the only thing that knows it arrived, so it owns the
// move, and it owns it on mount — which is exactly when it arrives.
//
// Focus lands on the step itself rather than its first control, so a screen
// reader announces the step the user is now in. A step whose first control is a
// text field can say so with that field's `hasAutoFocus` instead and skip this.
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { VStack } from '@astryxdesign/core';

export function OnboardingStepForm(props: {
  /** Names the step for assistive technology; focus lands here. */
  label: string;
  /** The story DOM contract for this step. */
  contract: string;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  children: ReactNode;
}) {
  const stepRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // `preventScroll` because the step renders at the top of the content area
    // already: scrolling to the focus target would push its header out of view.
    stepRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <form
      ref={stepRef}
      tabIndex={-1}
      aria-label={props.label}
      data-maka-contract={props.contract}
      onSubmit={props.onSubmit}
    >
      <VStack gap={4}>{props.children}</VStack>
    </form>
  );
}
