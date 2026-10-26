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

// Regression fixture: Antigravity returned this drawing in an XML code fence.
export const antigravitySvg = String.raw`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="100%" height="100%">
  <defs>
    <!-- 背景渐变 -->
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a0a1a" />
      <stop offset="50%" stop-color="#120e2e" />
      <stop offset="100%" stop-color="#060814" />
    </linearGradient>

    <!-- 核心球体渐变 -->
    <radialGradient id="coreGrad" cx="35%" cy="35%" r="65%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="25%" stop-color="#7bf0ff" />
      <stop offset="60%" stop-color="#703bf7" />
      <stop offset="100%" stop-color="#19004a" />
    </radialGradient>

    <!-- 光晕渐变 -->
    <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#6454f0" stop-opacity="0.6" />
      <stop offset="50%" stop-color="#00d2ff" stop-opacity="0.2" />
      <stop offset="100%" stop-color="#000" stop-opacity="0" />
    </radialGradient>

    <!-- 轨道渐变 -->
    <linearGradient id="ringGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00f2fe" stop-opacity="0.9" />
      <stop offset="50%" stop-color="#4facfe" stop-opacity="0.3" />
      <stop offset="100%" stop-color="#6b11ff" stop-opacity="0.8" />
    </linearGradient>

    <linearGradient id="ringGrad2" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ff0844" stop-opacity="0.8" />
      <stop offset="100%" stop-color="#ffb199" stop-opacity="0.2" />
    </linearGradient>

    <!-- 发光滤镜 -->
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="8" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- 背景 -->
  <rect width="800" height="600" fill="url(#bgGrad)" />

  <!-- 背景星星装饰 -->
  <g fill="#ffffff" opacity="0.6">
    <circle cx="120" cy="100" r="1.5" opacity="0.8" />
    <circle cx="250" cy="80" r="1" opacity="0.4" />
    <circle cx="680" cy="130" r="2" opacity="0.9" />
    <circle cx="710" cy="420" r="1.2" opacity="0.5" />
    <circle cx="150" cy="480" r="1.8" opacity="0.7" />
    <circle cx="340" cy="530" r="1" opacity="0.3" />
    <circle cx="600" cy="510" r="1.5" opacity="0.6" />
    <circle cx="80" cy="300" r="1" opacity="0.5" />
  </g>

  <!-- 中心发光背景 -->
  <circle cx="400" cy="300" r="220" fill="url(#glowGrad)" />

  <!-- 外围装饰网格与虚线圆环 -->
  <circle cx="400" cy="300" r="190" fill="none" stroke="#4a5568" stroke-width="1" stroke-dasharray="4,8" opacity="0.4" />
  <circle cx="400" cy="300" r="140" fill="none" stroke="#718096" stroke-width="1.5" stroke-dasharray="12,6" opacity="0.3" />

  <!-- 倾斜旋转环 1 (前/后两层穿插效果) -->
  <g transform="translate(400, 300) rotate(-28)">
    <ellipse cx="0" cy="0" rx="175" ry="50" fill="none" stroke="url(#ringGrad1)" stroke-width="4" filter="url(#glow)" />
    <!-- 环上运转的能量粒子 -->
    <circle cx="140" cy="-30" r="5" fill="#00f2fe" filter="url(#glow)" />
    <circle cx="-160" cy="18" r="3.5" fill="#4facfe" filter="url(#glow)" />
  </g>

  <!-- 倾斜旋转环 2 -->
  <g transform="translate(400, 300) rotate(35)">
    <ellipse cx="0" cy="0" rx="165" ry="42" fill="none" stroke="url(#ringGrad2)" stroke-width="3" opacity="0.85" filter="url(#glow)" />
    <circle cx="-130" cy="-25" r="4.5" fill="#ff758c" filter="url(#glow)" />
  </g>

  <!-- 悬浮阴影 -->
  <ellipse cx="400" cy="420" rx="60" ry="12" fill="#000000" opacity="0.5" filter="blur(6px)" />

  <!-- 主体球体 -->
  <circle cx="400" cy="300" r="75" fill="url(#coreGrad)" filter="url(#glow)" />

  <!-- 表面高光反光点弧线 -->
  <path d="M 365 245 A 50 50 0 0 1 430 250" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.6" />
  <circle cx="360" cy="255" r="3.5" fill="#ffffff" opacity="0.8" />

  <!-- 科技感文字与标尺 -->
  <text x="400" y="520" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" letter-spacing="6" fill="#6c7a9c">ANTIGRAVITY // CORE</text>
  <line x1="330" y1="540" x2="470" y2="540" stroke="#2d3748" stroke-width="1.5" />
  <circle cx="400" cy="540" r="2.5" fill="#00f2fe" />
</svg>
`;
