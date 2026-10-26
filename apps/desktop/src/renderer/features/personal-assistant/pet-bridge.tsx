/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect, useState, useRef } from "react";
import type { PetActivityState } from "@maka/core/pet";
import { usePersonalAssistantServices } from "./services.js";
import { projectAssistantPet } from "./pet-model.js";

/** This is a read-only presentation bridge: no tools, models or assistant enablement. */
export function PetDesktopBridge(props: {
  activity: { turnRunning: boolean; awaitingInteraction: boolean };
  hasActiveSession: boolean;
  sessionStatus?: string;
  contextKey: string | undefined;
  completionNonce: number;
  openSession(id: string): void;
}) {
  const services = usePersonalAssistantServices();
  const pet = services.pet;
  const lastCompletion = useRef(props.completionNonce);
  const [completed, setCompleted] = useState(false);
  useEffect(() => {
    if (lastCompletion.current === props.completionNonce) return;
    lastCompletion.current = props.completionNonce;
    setCompleted(true);
    const timer = setTimeout(() => setCompleted(false), 3000);
    return () => clearTimeout(timer);
  }, [props.completionNonce]);
  useEffect(() => setCompleted(false), [props.contextKey]);
  const [configuration, setConfiguration] = useState({
    enabled: false,
    mode: "session" as "session" | "assistant",
  });
  useEffect(() => {
    if (!pet) return;
    let live = true;
    const stop = pet.subscribeConfiguration(setConfiguration);
    void pet
      .configuration()
      .then((value) => {
        if (live) setConfiguration(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, [pet]);
  useEffect(
    () =>
      pet?.subscribeOpen((id) => {
        if (id) props.openSession(id);

      }),
    [props.openSession, pet],
  );
  const activity: PetActivityState = !props.hasActiveSession
    ? "idle"
    : props.activity.awaitingInteraction ||
        props.sessionStatus === "waiting_for_user"
      ? "needs-input"
      : props.sessionStatus === "blocked"
        ? "blocked"
        : props.activity.turnRunning
          ? "working"
          : completed
            ? "ready"
            : "idle";
  useEffect(() => {
    if (!pet || !configuration.enabled) return;
    pet.publish({
      kind: "session",
      surface: {
        activity,
        sessionId: props.contextKey,
        label: !props.hasActiveSession
          ? "没有打开的会话"
          : activity === "working"
            ? "会话进行中"
            : activity === "needs-input"
              ? "等你回复"
              : activity === "blocked"
                ? "会话需要处理"
                : "准备好了",
      },
    });
  }, [
    pet,
    configuration.enabled,
    activity,
    props.contextKey,
    props.hasActiveSession,
  ]);
  useEffect(() => {
    if (!pet || !configuration.enabled || configuration.mode !== "assistant")
      return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let owner: string | undefined;
    let stopTranscript: (() => void) | undefined;
    const closeTranscript = () => {
      stopTranscript?.();
      stopTranscript = undefined;
      owner = undefined;
    };
    const observe = (sessionId: string) => {
      if (owner === sessionId) return;
      closeTranscript();
      owner = sessionId;
      stopTranscript = pet.observeMessages(sessionId, closeTranscript);
    };
    const check = async () => {
      try {
        const host = await services.defaultHost();
        const enabled = await services.call("assistant.enablement", {}, host);
        if (!live) return;
        if (!enabled.enabled) {
          closeTranscript();
          pet.publish({
            kind: "assistant",
            surface: { activity: "idle", label: "个人助手未开启" },
          });
          return;
        }
        const result = await services.call(
          "assistant.status",
          { includeMemory: false },
          host,
        );
        if (!live) return;
        const sessionId = result.state?.sessionId
          ? JSON.stringify([host.hostId, result.state.sessionId])
          : undefined;
        if (result.state?.sessionId) {
          try { result.memoryActivity = await services.call('assistant.memory-activity', { sessionId: result.state.sessionId }, host); }
          catch { /* Older Hosts can still show their task and discovery status. */ }
        }
        if (!live) return;
        pet.publish({ kind: 'assistant', surface: projectAssistantPet(result, sessionId) });
        if (sessionId) observe(sessionId);
        else closeTranscript();
      } catch {
        if (live)
          pet.publish({
            kind: "assistant",
            surface: { activity: "blocked", label: "助手连接暂不可用" },
          });
      } finally {
        if (live) timer = setTimeout(check, 3000);
      }
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
      closeTranscript();
    };
  }, [configuration.enabled, configuration.mode, services, pet]);
  return null;
}
