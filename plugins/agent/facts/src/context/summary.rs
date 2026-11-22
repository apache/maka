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

use crate::language::Language;

macro_rules! summary_format {
    () => {
        "## Objective and user constraints\nCurrent goal, scope, acceptance criteria, authorization boundaries, user corrections, and standing collaboration or style rules for this session.\n\n## Workspace and findings\n- Modified state: created, edited, or deleted file paths, concrete changes made, Git/branch state, and which checks passed, failed, or have not run (tool call success is not goal completion).\n- Key findings: verified root causes, invariants, interfaces, and exact file:line or symbol locations needed to continue without re-reading explored files.\n- Decisions and dead ends: active design choices with rationale, plus rejected or failed approaches and why not to repeat them.\n\n## Live state and recovery handles\nUnsettled or resumable handles: archived result resource_ref values with next Read line/offset cursors; running or background processes, delegated sessions, tasks, or REPL state with owner, original IDs, and last observed status; pending user questions or approvals. Keep unsettled operations marked pending unless captured evidence resolves them. Note the last visible event or action at this checkpoint cut.\n\n## Next actions\nOrdered concrete steps to execute next, their dependencies, and the evidence or verification needed to advance or confirm completion."
    };
    (zh_cn) => {
        "## 目标与用户约束\n当前目标、范围、验收标准、授权边界、用户纠正，以及本会话需持续遵守的协作与风格要求。\n\n## 代码与工作现场\n- 已变更状态：已修改、新建或删除的文件路径、具体改动点、Git/分支状态，以及哪些验证已通过、失败或尚未运行（工具调用成功不等于目标完成）。\n- 已查明的关键结论：已核实的根因、核心机制、不变量及精确的文件行号或符号位置，避免接手后重复阅读已排查文件。\n- 决定与排雷：当前选定方案及依据；已排除或失败的做法及原因，避免重复踩坑。\n\n## 运行中状态与恢复句柄\n未结清或需续接的精确句柄：归档结果 resource_ref 及继续 Read 的行号或偏移量；运行中或后台进程、子会话、任务、REPL 状态等的归属、原始 ID 与最后观测状态；待用户回复的问题或审批。未见明确完结证据的操作一律保留为待确认。标明此检查点切分处的最后可见事件或操作引用。\n\n## 下一步行动\n按顺序列出接下来执行的具体步骤、前置依赖，以及推进或确认完成所需的输入与验证方式。"
    };
    (zh_tw) => {
        "## 目標與使用者約束\n目前目標、範圍、驗收標準、授權邊界、使用者修正，以及本工作階段需持續遵守的協作與風格要求。\n\n## 程式碼與工作現場\n- 已變更狀態：已修改、新建或刪除的檔案路徑、具體改動點、Git/分支狀態，以及哪些驗證已通過、失敗或尚未執行（工具呼叫成功不等於目標完成）。\n- 已查明的關鍵結論：已核實的根因、核心機制、不變量及精確的檔案行號或符號位置，避免接手後重複閱讀已排查檔案。\n- 決定與排雷：目前選定方案及依據；已排除或失敗的做法及原因，避免重複踩坑。\n\n## 執行中狀態與恢復控柄\n未結清或需接續的精確控柄：封存結果 resource_ref 及繼續 Read 的行號或偏移量；執行中或背景行程、子工作階段、任務、REPL 狀態等的歸屬、原始 ID 與最後觀測狀態；待使用者回覆的問題或核准事項。未見明確完結證據的操作一律保留為待確認。標明此檢查點切分處的最後可見事件或操作參照。\n\n## 下一步行動\n依序列出接下來執行的具體步驟、前置相依關係，以及推進或確認完成所需的輸入與驗證方式。"
    };
}

pub fn summary_format_template(language: Language) -> &'static str {
    match language {
        Language::En => summary_format!(),
        Language::ZhCn => summary_format!(zh_cn),
        Language::ZhTw => summary_format!(zh_tw),
    }
}

pub fn default_compaction_prompt(language: Language) -> &'static str {
    match language {
        Language::En => concat!(
            "Summarize the captured conversation above into a checkpoint handoff for the assistant that continues the work. Do not call any tools or initiate actions; output plain text only. Write in the natural language the user is conversing in, while keeping file paths, symbols, commands, IDs, resource_ref handles, and exact error messages verbatim. If earlier checkpoints appear above, merge them with newer turns: let later evidence and user corrections supersede stale state while retaining unresolved requirements and standing collaboration preferences. Treat omitted or truncated input as unseen rather than absent. Use concise bullet points under the sections below, omit inapplicable sub-items, and do not copy explanatory prompts:\n\n",
            summary_format!()
        ),
        Language::ZhCn => concat!(
            "将以上捕获的对话整理为供接续工作的助手直接接手的检查点交接单。严禁调用任何工具或发起操作，仅输出纯文本交接单。使用用户交谈所用的自然语言撰写；文件路径、符号、命令、各类 ID、resource_ref 及关键报错原文严格保持原样不翻译。若上文包含旧检查点，将其与新近对话合并：以最新证据和用户纠正覆盖过期状态，同时保留尚未完成的要求与会话内需持续遵守的协作约束。被省略或截断的输入仅代表此处不可见，不代表未发生。用紧凑要点按以下章节输出，不涉及的子项直接省略，不要保留章节说明文字：\n\n",
            summary_format!(zh_cn)
        ),
        Language::ZhTw => concat!(
            "將以上擷取的對話整理為供接續工作的助手直接接手的檢查點交接單。嚴禁呼叫任何工具或發起操作，僅輸出純文字交接單。使用使用者交談所用的自然語言撰寫；檔案路徑、符號、命令、各類 ID、resource_ref 及關鍵錯誤原文嚴格保持原樣不翻譯。若上文包含舊檢查點，將其與新近對話合併：以最新證據和使用者修正覆蓋過期狀態，同時保留尚未完成的要求與工作階段內需持續遵守的協作約束。被省略或截斷的輸入僅代表此處不可見，不代表未發生。用緊湊要點按以下章節輸出，不涉及的子項直接省略，不要保留章節說明文字：\n\n",
            summary_format!(zh_tw)
        ),
    }
}
