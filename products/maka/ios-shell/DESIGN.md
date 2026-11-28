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

# Chat attachment motion

The draft strip briefly fades items in and out without translating the composer.
Reduce Motion skips the fade. Upload status changes in place; no spinner or
progress bar guesses at completion. The picker, menu and compact management
sheet use system presentation and dismissal.

Image attachment buttons change fill on press. The fullscreen viewer fades in
and out with native modal presentation (immediate under Reduce Motion), and
loading, error and image share the same viewport. The image follows the native
scroll view's pinch and pan, without competing with a swipe-to-dismiss gesture;
Close and the system accessibility escape dismiss the viewer.
