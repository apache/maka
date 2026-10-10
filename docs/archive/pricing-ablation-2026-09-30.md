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

# Pricing 消融实验结论（2026-09-30）

在合并提交 `b043e2cf2` 上进行了 30 项单独消融和 3 项组合消融。
27 项机制的删除会触发具体行为回归；3 项局部简化及其组合通过观察面。
这不是性能基准，也不证明其他实现方式不可能替代这些机制。

保留 CAS 快照、Host 与弹窗生命周期、同步输入、请求顺序、写入恢复、
价格语义校验，以及 Chromium 验证过的 ARIA 和焦点保护。采用三处简化：

- 分页严格前进且响应必须匹配请求 offset，已排除历史游标，无需另存 Set。
- 有效 reload 开始时已清错，成功路径无需再次清空。
- `setEditor(null)` 通过模型身份变化清除已结算冲突，关闭弹窗无需重复清理。

实验补入的持续回归覆盖同一 Host 下卸载后的迟到保存、刷新乱序、分页自环/
回退/重复键、恢复内置定价的反例，以及 Host review 按钮消失时的原生焦点。
这些测试保留在现有 Pricing 组件、client 和 Storybook 测试中并随 CI 运行。
当时的生产代码验证结果为 124 项 Node 测试、12 个浏览器场景及 1 项 Electron
跨进程持久化测试通过；后续覆盖和验证结果以对应提交的 CI 为准。

2026-10-10 根据评审精简 PR：未接入 CI 的实验运行器、固定探针和大 JSON
已移出当前树。原始脚本、数据和完整报告仍可从提交 `17e0d3db3` 的
`scripts/experiments/` 与 `docs/archive/pricing-ablation-2026-09-30.*` 获取。
原工作区另保留在 `perf-results/pricing-ablation-20260930/reviewer-archive-20261010/`，
该目录不上传。历史实验应在原提交及其锁文件上复现，不能把旧源码散列和
测试计数当作最新代码的验证结果。
