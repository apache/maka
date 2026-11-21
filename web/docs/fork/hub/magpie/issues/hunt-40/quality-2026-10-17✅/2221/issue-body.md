# gateway: 重复function_call_output是否在实际无状态relay中失败，等待真实请求证据

状态：本地更正稿，未发布；产品去重patch暂停，不要求合入或关单。

原报告通过人工重放证明了重复条目可以到达relay，但没有证明该形状会被实际使用的无状态上游拒绝。维护者对ChatGPT Codex后端的相邻/分隔重复output、重复call、重复id测试均得到200；引用的社区400属于store:true/previous_response_id状态重放，不能视为同一种失败。api.openai.com尚无本单实测，既不能断言所有上游都失败，也不能由Codex200推断其他上游永不失败。

在没有真实失败前，自动删除第二份结果会改变用户输入；保留原patch仅供历史复核，不推进该行为变更。

重新启动的必要证据：客户端及版本、供应商类型/脱敏地址、失败请求的具体形状、用量→请求中的错误原文，以及当前main仍失败的对照。当前没有这些证据，不新增评论、不催收、不建议关闭。

依据：https://github.com/yetone/magpie/issues/2221#issuecomment-6174842444

AI assistance: OpenAI Codex参与本轮材料复核；具体模型未由运行环境提供。
