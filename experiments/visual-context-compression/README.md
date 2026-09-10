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

# 长会话视觉上下文压缩实验归档

实验日期：2026-09-09。归档日期：2026-09-10。

- [完整中文报告](BATCH_REPORT_ZH.md)：已交付报告的正文、方法、结果和限制。
- [结构化表格](batch-results-summary.json)：从该报告逐表机械提取，保留单位、舍入值和缺失标记。

## 归档范围

归档时，原实验 worktree 和本地实验分支已不存在，远端没有该实验分支，检查范围内未找到原实验文件备份。本分支根据已交付的完整报告重新归档，并未重新运行模型或推断缺失结果。

此归档不包含原实验脚本、原始运行用量明细、图片、源历史、题目、标准答案和图表，不是完整可复现实验包。报告中“已核验”等表述是实验完成时的记录，不能理解为这些原始证据已随本分支恢复。

JSON 使用新的 `delivered-report-tables/v1` 结构，不冒充丢失的原始结果文件。报告末尾原指向缺失文件的链接已替换为本归档内有效链接。

## 结果口径

本批20种配置，19种完成双材料测试，共78次有效答题。一个配置在B上被操作者停止，缺失项不记零分。主评分保留64题；统一剔除3道格式敏感题的61题结果属于事后诊断。实际输入token与文字代理token、PNG字节数分别记录。详细限制见报告。

Maka摘要器的实验代码版本为 `4e139315f6769dbad823c33564697031cdaa9e89`；本归档分支的基线不代表实验使用的代码版本。
