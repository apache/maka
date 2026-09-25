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

# Session collaboration

This slice owns sharing and joining Sessions, Guest access management, and
Owner approval of Guest Turn requests.

## Sharing dialog ownership

`SessionCollaborationDialogRoot` is the only production owner of
`useSessionCollaborationDialog`, registered in `controllerOwners`. The public
entry exports the root and its narrow shell projection, never the controller.

The root owns the target and mounts the sharing dialog. The shell receives a
stable `openSession` command, the localized action label, and `isOpen` for its
existing modal coordination. Target changes and dialog polling, invitations,
and access mutations do not invalidate that projection. Opening and closing
still update the shell because its shortcuts and Workbar need modal visibility.

A dialog instance belongs to one target Session. Changing targets remounts it,
clears the previous invitation and access state, and releases its polling loop.
Closing or unmounting ignores late projection reads and stops polling.

The dialog obtains its capabilities from `SessionCollaborationServices`.
The Desktop adapter owns bridge and clipboard access. Remote access is checked
before reading local sharing controls and again before creating an invitation;
unencrypted connections still require explicit confirmation. Opening remote
access Settings closes sharing first and uses the shared Settings navigation
contract to select `projects`.

`testing.ts` provides injectable fake services. The sharing tests mount the
production root and dialog without Electron, exercising modal projection,
polling cleanup, invitation confirmation/copying, access revocation, and Turn
approval/rejection. Session settings and Plan ownership are separate work.
