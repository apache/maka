#!/bin/bash
# 探测 47.116.78.77 上是否有新课程目录。2026-09-05 实测：仅 / 和 /harness/ 存在。
# 用法：Git Bash 里 bash 探测新课程.sh ，出现 HIT 行即为新应用。
SIG="404:3314"   # Anolis OS nginx 默认 404 页的「状态:字节数」签名，若服务器换了 404 页需重新校准
WORDS="ai llm llms gpt agent agents agentic rag mcp a2a prompt prompts prompting cot tot reasoning
inference training finetune fine-tune finetuning sft rlhf dpo distill distillation quantization quant
embedding embeddings vector vectordb multimodal vision vlm diffusion transformer transformers attention
token tokens tokenizer context context-engineering system-prompt memory long-horizon agent-graph graph
swarm team agent-team workflow workflows cli maka apache-maka raft grok bot grok-bot kv-cache cache
structured-output tool-calling function-calling multi-agent autonomous plan plan-mode note notes
second-brain deepseek qwen kimi glm anthropic openai gemini llama eval evaluation benchmark guardrail
safety alignment moe nlp cv asr tts aigc mlops claude claude-code cursor copilot code coding vibe
vibe-coding skill skills subagent subagents hook hooks tool tools tool-use course courses lesson
lessons learn learning class bootcamp camp workshop deck decks slides slide ppt docs book tutorial
tutorials series"
for w in $WORDS; do
  r=$(curl -s -o /dev/null -m 6 -w '%{http_code}:%{size_download}' "http://47.116.78.77/$w")
  [ "$r" != "$SIG" ] && echo "HIT /$w => $r"
  sleep 0.15
done
echo "=== DONE（无 HIT 即无新应用）==="
