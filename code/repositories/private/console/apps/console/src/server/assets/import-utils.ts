import fs from "node:fs";
import path from "node:path";
import { getCardRoot } from "@/server/assets/scanner";

// 导入留档：写进卡密根目录的 _导入收件箱，失败不阻塞导入。
export function saveToInbox(fileName: string, text: string) {
  const inbox = path.join(getCardRoot(), "_导入收件箱");
  try {
    fs.mkdirSync(inbox, { recursive: true });
    const safe = fileName.replace(/[\\/:*?"<>|]/g, "_");
    fs.writeFileSync(path.join(inbox, `${Date.now()}-${safe}`), text, "utf-8");
  } catch {
    // 收件箱写入失败不阻塞导入
  }
}
