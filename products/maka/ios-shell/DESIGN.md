<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Maka on iOS

The conversation is the primary surface. Show the active Host and path in the
header; keep switches, account details and configuration in sheets. Pairing
presents the authenticated Host code before granting access. The device key lives in a non-synchronizing, ThisDeviceOnly Keychain item. Only ad-hoc Simulator builds missing the Keychain entitlement use a 0600, backup-excluded container file. The Bearer mode
is separate and its credential is never saved. Safe-area insets and the native
keyboard must not cover controls. The system appearance supplies light/dark
mode; the theme defines semantic colors and glass must not obscure text.

## Motion inventory

| Change | Motion and reduced motion |
| --- | --- |
| Control press | Brief active opacity transition; instant with reduced motion. |
| Connect, send and approval | Immediate state text, with native haptics at explicit action and outcome boundaries. |
| Pairing mode and filters | UIKit segmented selection; system accessibility settings apply. |
| Host, model, turn and directory sheets | NSH slide, detent and interactive dismissal; reduced motion settles immediately. |
| Overflow and long press | Native menus own presentation and dismissal. |
| Transcript append/queue updates | Keep stable rows and the current scroll position; animate only the local layout change, instant with reduced motion. |
| Streaming and live path values | Update in place, no repeating transition. |
| Errors and reconnect | Native toast stack, no success toast for ordinary sends. |


After a transport loss the app reopens the Host anchor and resumes the
session watch at the last consumed cursor. An unacknowledged mutation is
not retried. While the app is running, a reconnect to the same pinned
Host can reconcile the original operation reference through its
published receipt reader; a missing receipt is not proof of failure.
