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

function frameGeometry(request) {
  if (!this.isConnected) throw new Error('Frame is not connected');
  this.scrollIntoView({ ...request.alignment, behavior: 'instant' });
  const view = this.ownerDocument.defaultView;
  const style = view.getComputedStyle(this);
  const bounds = this.getBoundingClientRect();
  if (!(bounds.width > 0 && bounds.height > 0 && this.offsetWidth > 0 && this.offsetHeight > 0))
    throw new Error('Frame does not have a clickable bounding box');
  if (
    request.requireVisible &&
    (style.visibility !== 'visible' ||
      (typeof this.checkVisibility === 'function' && !this.checkVisibility()))
  )
    throw new Error('Ancestor frame is not visible');
  const scaleX = bounds.width / this.offsetWidth;
  const scaleY = bounds.height / this.offsetHeight;
  const inset = [
    this.clientLeft + Number.parseFloat(style.paddingLeft),
    this.clientTop + Number.parseFloat(style.paddingTop),
  ];
  if (!inset.every(Number.isFinite)) throw new Error('Frame content inset is unavailable');
  const point = [
    bounds.left + (inset[0] + request.point[0]) * scaleX,
    bounds.top + (inset[1] + request.point[1]) * scaleY,
  ];
  return {
    point,
    viewport: [view.innerWidth, view.innerHeight],
    size: [this.offsetWidth, this.offsetHeight],
    inset,
  };
}
