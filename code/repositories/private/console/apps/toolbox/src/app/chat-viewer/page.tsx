import type { Metadata } from "next";
import { LocalChatViewer } from "@/features/chat-viewer/components/viewer/local-chat-viewer";

export const metadata: Metadata = {
  title: "聊天记录查看器",
  description: "本地优先的微信聊天查看与录屏 OCR 分析：导入/合并/搜索/统计/导出，数据不出浏览器",
};

export default function ChatViewerPage() {
  return <LocalChatViewer />;
}
