import type { Metadata } from "next";
import { VenueBoard } from "./venue-board";
import { SpaceNav } from "./space-nav";

export const metadata: Metadata = {
  title: "约会攻略",
  description: "阳西地点库 + 情侣空间：计划/复盘/里程碑/时间线，node:sqlite 持久化",
};

export default function DatePlaybookPage() {
  return (
    <div>
      <header className="mb-4">
        <h1 className="text-3xl font-semibold tracking-tight">约会攻略</h1>
        <p className="mt-1 text-sm text-muted-foreground">阳西地点库 · 情侣共享计划，数据持久化在服务端本地库</p>
      </header>
      <SpaceNav active="/date-playbook" />
      <VenueBoard />
    </div>
  );
}
