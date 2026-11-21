import "fake-indexeddb/auto";

import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnalysisReport, ChatMessage, VideoProject } from "@/features/chat-viewer/lib/domain/schemas";

import { createChatAnalysisDb, type ChatAnalysisDb } from "./db";

const dbName = "chat-analysis-db-test";
let db: ChatAnalysisDb | undefined;

const project: VideoProject = {
  id: "project-1",
  title: "June chat",
  videoFileName: "wechat.mp4",
  videoDurationMs: 120_000,
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:10:00.000Z",
};

const messages: ChatMessage[] = [
  {
    id: "message-1",
    projectId: "project-1",
    senderName: "Alice",
    text: "hello",
    timestampMs: 1_000,
    frameId: "frame-1",
  },
];

const report: AnalysisReport = {
  projectId: "project-1",
  generatedAt: "2026-06-09T00:20:00.000Z",
  messageCount: 1,
  participantCount: 1,
  topKeywords: [{ keyword: "hello", count: 1 }],
  timeline: [{ timestampMs: 1_000, messageCount: 1 }],
};

describe("createChatAnalysisDb", () => {
  beforeEach(async () => {
    await deleteDB(dbName);
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    await deleteDB(dbName);
  });

  it("saves and lists projects ordered by updatedAt descending", async () => {
    db = await createChatAnalysisDb({ name: dbName });

    await db.saveProject({
      ...project,
      id: "project-old",
      title: "Older chat",
      updatedAt: "2026-06-09T00:05:00.000Z",
    });
    await db.saveProject(project);

    await expect(db.listProjects()).resolves.toEqual([project, {
      ...project,
      id: "project-old",
      title: "Older chat",
      updatedAt: "2026-06-09T00:05:00.000Z",
    }]);
  });

  it("saves messages and reports without throwing", async () => {
    db = await createChatAnalysisDb({ name: dbName });

    await db.saveProject(project);

    await expect(db.saveMessages(project.id, messages)).resolves.toBeUndefined();
    await expect(db.saveReport(project.id, report)).resolves.toBeUndefined();
  });

  it("reads project messages ordered by timestamp and the saved report", async () => {
    db = await createChatAnalysisDb({ name: dbName });

    const newerMessage: ChatMessage = {
      ...messages[0],
      id: "message-2",
      timestampMs: 2_000,
      text: "later",
    };

    await db.saveProject(project);
    await db.saveMessages(project.id, [newerMessage, messages[0]]);
    await db.saveReport(project.id, report);

    await expect(db.getProjectMessages(project.id)).resolves.toEqual([
      messages[0],
      newerMessage,
    ]);
    await expect(db.getProjectReport(project.id)).resolves.toEqual(report);
  });

  it("clears all local projects and analysis records for privacy reset", async () => {
    db = await createChatAnalysisDb({ name: dbName });

    await db.saveProject(project);
    await db.saveMessages(project.id, messages);
    await db.saveReport(project.id, report);

    await db.clearAllData();

    await expect(db.listProjects()).resolves.toEqual([]);
    await expect(db.getProjectMessages(project.id)).resolves.toEqual([]);
    await expect(db.getProjectReport(project.id)).resolves.toBeNull();
  });
});
