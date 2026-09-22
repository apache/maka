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

// Standalone preview of the actual plugin component. All task content below is sample data.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
await mkdir('.artifacts/preview', { recursive: true });
const now = new Date();
const later = (day, hour) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour, 0, 0).getTime();
const data = {
  ready: true,
  matters: [
    {
      id: 'design',
      title: '跟进设计交付',
      status: 'waiting',
      wakes: [{ at: later(1, 10) }],
      lastUpdate: '最新版稿件已收到，视觉审核已通过，正在等待无障碍审核。',
      handoff: {
        summary: '确认了最新稿件和视觉审核结果，并核对了双方的会议时间。',
        next: '检查无障碍审核结果。通过后安排验收会议，再更新项目任务。',
      },
    },
    {
      id: 'refund',
      title: '跟进退款到账',
      status: 'waiting',
      wakes: [{ at: later(1, 14) }],
      lastUpdate: '商家已受理退款，暂未到账。',
      handoff: { summary: '已确认退款申请受理成功。', next: '查询退款进度，确认是否到账。' },
    },
    {
      id: 'trip',
      title: '安排周末的短途旅行',
      status: 'active',
      wakes: [],
      lastUpdate: '已经确定出行日期，正在比较两家酒店。',
      handoff: {
        summary: '确认了目的地、预算和出行人数。',
        next: '核对交通和住宿方案，再整理建议。',
      },
    },
  ],
};
await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
const data=${JSON.stringify(data)};const slots=[];
window.__MakaModuleLoader__={load(pkg){pkg.factory(()=>React).apply({style(css){const el=document.createElement('style');el.textContent=css;document.head.append(el)},slots:{register(meta,Component){slots.push({meta,Component})}},remote:{async call(){return data},async *stream(){yield data}}});}};
${await readFile('src/client.js', 'utf8')}
for(const {meta,Component} of slots){const el=document.createElement('div');document.getElementById(meta.name==='sidebar.footer'?'entry':'overlay').append(el);createRoot(el).render(React.createElement(Component));}
`,
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  outfile: '.artifacts/preview/app.js',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile(
  '.artifacts/preview/index.html',
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>长任务 · 组件预览</title><style>
:root{--background:#fff;--foreground:#323531}body{margin:0;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#fcfcfb;color:#323531}*{box-sizing:border-box}header.shell{height:62px;border-bottom:1px solid #efefed;padding:0 30px;display:flex;align-items:center;justify-content:space-between;font-size:13px}header small{color:#9b9d98;font-size:11px}.chat{margin:78px 420px 0 64px;max-width:590px}.eyebrow{font-size:11px;color:#9da098;letter-spacing:2px}.chat h1{font-size:26px;letter-spacing:-.8px;font-weight:500;margin:14px 0 36px}.user{padding:16px 20px;border-radius:18px 18px 4px 18px;background:#f0f1ee;font-size:14px;line-height:1.9;margin:0 0 30px 32px}.assistant{font-size:14px;line-height:2;color:#5d625a;padding:0 8px}.assistant p{margin:0 0 14px}.composer{position:absolute;left:64px;bottom:44px;right:420px;max-width:590px;height:100px;border:1px solid #e6e8e2;border-radius:20px;padding:19px 20px;background:#fff;color:#a2a69e;font-size:13px;box-shadow:0 4px 18px #00000003}.composer span{position:absolute;bottom:14px;left:20px;color:#757e70;font-size:12px}#entry{position:absolute;left:24px;bottom:10px;opacity:.65}@media(max-width:700px){.chat,.composer{display:none}}
</style><header class="shell"><span>长任务</span><small>实际插件组件 · 示例数据预览</small></header><main class="chat"><div class="eyebrow">持续跟进，让事情继续向前</div><h1>把需要惦记的事，交代在这里。</h1><div class="user">帮我跟进设计交付，审核通过后安排一次验收会议，再把项目任务更新好。</div><div class="assistant"><p>已经开始跟进。最新版稿件的视觉审核已通过，现在还在等无障碍审核结果。</p><p>下次检查安排在明天上午 10 点。审核通过后，我会继续安排会议并更新项目任务。</p></div></main><div class="composer">补充要求，或交代一件新的事…<span>＋</span></div><div id="entry"></div><div id="overlay"></div><script>${await readFile('.artifacts/preview/app.js', 'utf8')}</script></html>`,
);
console.log(resolve('.artifacts/preview/index.html'));
