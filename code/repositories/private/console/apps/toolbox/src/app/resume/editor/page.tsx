import type { Metadata } from "next";
import { EditorPage } from "@/features/resume/EditorPage";

export const metadata: Metadata = {
  title: "简历编辑器",
};

export default function ResumeEditorPage() {
  return <EditorPage />;
}
