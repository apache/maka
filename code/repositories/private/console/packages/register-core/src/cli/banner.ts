/** 启动横幅 + 合规确认交互。 */
import readline from 'node:readline';
import { COMPLIANCE_BANNER, CONFIRM_PROMPT } from '../compliance/warnings.js';

/** 打印横幅;若要求确认则等待 stdin 输入 'I understand'。 */
export async function confirmCompliance(requireConfirmation: boolean): Promise<boolean> {
    console.error(COMPLIANCE_BANNER);
    if (!requireConfirmation) return true;

    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question(CONFIRM_PROMPT, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'i understand');
        });
    });
}
