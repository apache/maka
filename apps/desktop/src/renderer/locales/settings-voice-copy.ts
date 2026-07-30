import type { UiCatalog, UiLocale, VoicePermissionStatus } from '@maka/core';

export type VoiceSettingsCopy = {
  idle: string;
  unsupportedMedia: string;
  unsupportedRecorder: string;
  requesting: string;
  recording: string;
  available(duration: string, size: string): string;
  success: string;
  denied: string;
  failed: string;
  failedTitle: string;
  aria: string;
  title: string;
  badge: string;
  subtitle: string;
  statusAria: string;
  microphone: string;
  captureLimit: string;
  durationSize(seconds: number, megabytes: number): string;
  channels: string;
  channelValue(khz: number): string;
  privacy: string;
  privacyValue: string;
  checking: string;
  run: string;
  boundary: string;
  boundaryAria: string;
  boundaries: readonly [string, string, string];
  permissions: Record<VoicePermissionStatus, string>;
  validation: Record<'duration_exceeded' | 'audio_too_large' | 'invalid_audio_shape' | 'permission_not_granted' | 'default', string>;
  duration(seconds: string): string;
};

const SETTINGS_VOICE_COPY = {
  zh: {
    idle: '等待运行本机录音自检。',
    unsupportedMedia: '当前运行环境不支持浏览器麦克风 API。',
    unsupportedRecorder: '当前运行环境不支持 MediaRecorder，无法做本地录音自检。',
    requesting: '正在检查麦克风设备和访问权限…',
    recording: '正在录制 2 秒本地样本；样本只在内存里计算大小，结束后立即丢弃。',
    available: (duration, size) => `录音链路可用：${duration}，${size}。样本未保存。`,
    success: '语音自检通过',
    denied: '麦克风权限被拒绝；请在系统设置里允许 Maka 访问麦克风后重试。',
    failed: '录音自检失败；请确认系统权限和音频设备可用。',
    failedTitle: '语音自检失败',
    aria: '语音模型',
    title: '语音模型',
    badge: '本地自检',
    subtitle: '这页现在可以验证麦克风权限和本地录音链路。语音转写和语音朗读模型必须遵守这个边界：转写结果必须先回到消息输入框，由用户编辑确认后才能发送；音频样本默认不落盘。',
    statusAria: '语音能力状态',
    microphone: '麦克风权限',
    captureLimit: '采集上限',
    durationSize: (seconds, megabytes) => `${seconds} 秒 · ${megabytes} MB`,
    channels: '通道',
    channelValue: (khz) => `单声道 · ≤ ${khz} kHz`,
    privacy: '隐私',
    privacyValue: '不保存音频 · 不进遥测',
    checking: '自检中…',
    run: '运行录音自检',
    boundary: '当前边界',
    boundaryAria: '语音能力边界说明',
    boundaries: [
      '录音样本只在本机内存里用于计算时长和大小；自检结束后立即停止采集并丢弃样本。',
      '配置语音转写模型之前，不会把音频传给任何云端服务。',
      '转写文本只进入消息输入框草稿；用户发送前必须能编辑。',
    ],
    permissions: {
      granted: '已授权',
      denied: '已拒绝',
      restricted: '受系统限制',
      not_determined: '待授权',
      unsupported: '不支持',
      unknown: '未知',
    },
    validation: {
      duration_exceeded: '录音超过时长上限。',
      audio_too_large: '录音样本超过大小上限。',
      invalid_audio_shape: '录音格式不符合当前采集契约。',
      permission_not_granted: '麦克风权限未授予。',
      default: '语音采集自检未通过。',
    },
    duration: (seconds) => `${seconds} 秒`,
  },
  en: {
    idle: 'Ready to run a local recording check.',
    unsupportedMedia: 'This environment does not support the browser microphone API.',
    unsupportedRecorder: 'This environment does not support MediaRecorder, so a local recording check cannot run.',
    requesting: 'Checking the microphone device and access permission…',
    recording: 'Recording a two-second local sample. Its size is calculated in memory and the sample is discarded immediately afterward.',
    available: (duration, size) => `Recording pipeline works: ${duration}, ${size}. The sample was not saved.`,
    success: 'Voice check passed',
    denied: 'Microphone access was denied. Allow Maka to use the microphone in System Settings, then try again.',
    failed: 'Recording check failed. Confirm that system permission and an audio input device are available.',
    failedTitle: 'Voice check failed',
    aria: 'Voice models',
    title: 'Voice models',
    badge: 'Local check',
    subtitle: 'Verify microphone permission and the local recording pipeline here. Speech-to-text and text-to-speech models must preserve this boundary: transcripts return to the message composer for editing and confirmation before sending, and audio samples are not saved by default.',
    statusAria: 'Voice capability status',
    microphone: 'Microphone permission',
    captureLimit: 'Capture limit',
    durationSize: (seconds, megabytes) => `${seconds} seconds · ${megabytes} MB`,
    channels: 'Channels',
    channelValue: (khz) => `Mono · ≤ ${khz} kHz`,
    privacy: 'Privacy',
    privacyValue: 'Audio not saved · excluded from telemetry',
    checking: 'Checking…',
    run: 'Run recording check',
    boundary: 'Current boundary',
    boundaryAria: 'Voice capability boundaries',
    boundaries: [
      'The recording sample is used only in local memory to calculate duration and size; capture stops and the sample is discarded when the check ends.',
      'Audio is never sent to a cloud service before a speech-to-text model is configured.',
      'Transcribed text enters only the message composer draft and remains editable before sending.',
    ],
    permissions: {
      granted: 'Granted',
      denied: 'Denied',
      restricted: 'Restricted by system',
      not_determined: 'Not determined',
      unsupported: 'Unsupported',
      unknown: 'Unknown',
    },
    validation: {
      duration_exceeded: 'The recording exceeded the duration limit.',
      audio_too_large: 'The recording sample exceeded the size limit.',
      invalid_audio_shape: 'The recording format does not match the capture contract.',
      permission_not_granted: 'Microphone permission was not granted.',
      default: 'The voice capture check did not pass.',
    },
    duration: (seconds) => `${seconds} seconds`,
  },
} satisfies UiCatalog<VoiceSettingsCopy>;

export function getVoiceSettingsCopy(locale: UiLocale): VoiceSettingsCopy {
  return SETTINGS_VOICE_COPY[locale];
}
