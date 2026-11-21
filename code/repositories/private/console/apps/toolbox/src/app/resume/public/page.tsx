import { Suspense } from "react";
import type { Metadata } from "next";
import { PublicResumePage } from "@/features/resume/PublicResumePage";

export const metadata: Metadata = {
  title: "简历预览",
  description: "个人简历公开预览页",
};

export default function ResumePublicPage() {
  return (
    <Suspense>
      <PublicResumePage />
    </Suspense>
  );
}
