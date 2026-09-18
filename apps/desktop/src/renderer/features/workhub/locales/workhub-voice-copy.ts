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

import type { UiCatalog } from '@maka/core/ui-locale';
export const workHubVoiceCopy = {
  en: { transcript: 'Live voice transcript', you: 'You', reply: 'Voice', providerHint: 'Requires an installed voice provider. Keep talking while WorkHub handles delegated work and returns updates. The conversation is saved here. Microphone audio is sent during the call.', call: 'Voice call', connecting: 'Connecting…', live: 'In call', mute: 'Mute', unmute: 'Unmute', end: 'End call', start: 'Start call', playbackError: 'Unable to play audio. Check your output device.', serviceError: 'Realtime service error. Please reconnect.' },
  'zh-CN': { transcript: '通话实时转写', you: '你', reply: '语音', providerHint: '需要先安装语音服务提供方。可以持续交谈，由 WorkHub 处理委派的工作并回传进展。对话保存在这里。通话期间发送麦克风音频。', call: '语音通话', connecting: '连接中…', live: '通话中', mute: '静音', unmute: '取消静音', end: '挂断', start: '开始通话', playbackError: '无法播放语音，请检查输出设备。', serviceError: '实时语音服务出现错误，请重新连接。' },
  'zh-TW': { transcript: '通話即時轉寫', you: '你', reply: '語音', providerHint: '需要先安裝語音服務提供方。語音輸入同步至目前 WorkHub 對話，回覆會自動播報。通話期間傳送麥克風音訊。', call: '語音通話', connecting: '連線中…', live: '通話中', mute: '靜音', unmute: '取消靜音', end: '掛斷', start: '開始通話', playbackError: '無法播放語音，請檢查輸出裝置。', serviceError: '即時語音服務發生錯誤，請重新連線。' },
} satisfies UiCatalog<Record<string, string>>;
