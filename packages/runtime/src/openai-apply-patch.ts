import { openai } from '@ai-sdk/openai';

export const openAiApplyPatchProviderTool = openai.tools.applyPatch({});
export const codexV4aApplyPatchProviderTool = openai.tools.customTool({});
const inputSchema = openAiApplyPatchProviderTool.inputSchema;
export const openAiApplyPatchInputSchema =
  typeof inputSchema === 'function' ? inputSchema() : inputSchema;

/** Models documented by OpenAI as supporting the native Apply Patch tool. */
export function openAiModelSupportsApplyPatch(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return (
    /^gpt-5\.(?:1|2|5)(?:-\d{4}-\d{2}-\d{2})?$/.test(id) ||
    /^gpt-5\.4(?:-(?:mini|nano|pro))?(?:-\d{4}-\d{2}-\d{2})?$/.test(id) ||
    /^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)
  );
}
