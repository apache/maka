import type { Metadata } from "next";
import { ResumeListPage } from "@/features/resume/ResumeListPage";

export const metadata: Metadata = {
  title: "简历管理",
  description: "多份简历管理：新建 / 编辑 / 复制 / 删除",
};

export default function ResumePage() {
  return <ResumeListPage />;
}
