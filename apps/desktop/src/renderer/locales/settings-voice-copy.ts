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
  statusAria: string;
  statusHelp: string;
  microphone: string;
  checking: string;
  run: string;
  permissions: Record<VoicePermissionStatus, string>;
  validation: Record<'duration_exceeded' | 'audio_too_large' | 'invalid_audio_shape' | 'permission_not_granted' | 'default', string>;
  duration(seconds: string): string;
  recognitionTitle: string;
  realtimeTitle: string;
  connection: string;
  model: string;
  language: string;
  prompt: string;
  voice: string;
  notConfigured: string;
  testRecognition: string;
  recognitionTesting: string;
  recognitionSuccess: string;
  recognitionFailed: string;
  createRecognitionConnection: string;
  createRecognitionConnectionTitle: string;
  createRecognitionConnectionSubtitle: string;
  recognitionConnectionCreated: string;
  recognitionConnectionCreatedDetail(connection: string, model: string): string;
  recognitionConnectionCreateFailed: string;
  recognitionConnectionModelMissing: string;
  editRecognitionConnection: string;
  editRecognitionConnectionTitle: string;
  editRecognitionConnectionSubtitle(connection: string): string;
  recognitionConnectionEndpoint: string;
  recognitionConnectionEndpointHelp: string;
  recognitionConnectionEndpointMissing: string;
  recognitionConnectionApiKey: string;
  recognitionConnectionApiKeyPlaceholder: string;
  recognitionConnectionApiKeyHelp: string;
  recognitionConnectionModel: string;
  recognitionConnectionModelPlaceholder: string;
  recognitionConnectionSave: string;
  recognitionConnectionUpdated: string;
  recognitionConnectionUpdatedDetail(connection: string, model: string): string;
  recognitionConnectionUpdateFailed: string;
  cancel: string;
  saveFailed: string;
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
    statusAria: '语音能力状态',
    statusHelp: '麦克风只在自检时录一小段，用完即丢弃；配置语音转写模型前不会把音频发往任何服务，转写结果也会先回到输入框、由你确认后再发送。',
    microphone: '麦克风权限',
    checking: '自检中…',
    run: '运行录音自检',
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
    recognitionTitle: '语音识别',
    realtimeTitle: '实时语音协调器',
    connection: '模型连接',
    model: '模型 ID',
    language: '语言（可选）',
    prompt: '识别提示词（可选）',
    voice: '音色',
    notConfigured: '未配置',
    testRecognition: '录音 4 秒并测试识别',
    recognitionTesting: '正在录音并调用所配置的识别模型…',
    recognitionSuccess: '语音识别测试通过',
    recognitionFailed: '语音识别测试失败',
    createRecognitionConnection: '新建识别连接',
    createRecognitionConnectionTitle: '新建语音识别连接',
    createRecognitionConnectionSubtitle: '填写 OpenAI 兼容的语音识别服务地址、API Key 和 ASR 模型 ID。创建后会自动选中该连接和模型。',
    recognitionConnectionCreated: '语音识别连接已创建',
    recognitionConnectionCreatedDetail: (connection, model) => `已选择 ${connection} · ${model}`,
    recognitionConnectionCreateFailed: '新建语音识别连接失败',
    recognitionConnectionModelMissing: 'ASR 模型 ID 不能为空。',
    editRecognitionConnection: '修改当前配置',
    editRecognitionConnectionTitle: '修改语音识别连接',
    editRecognitionConnectionSubtitle: (connection) => `直接修改 ${connection} 的服务地址、API Key 和 ASR 模型；保存后继续使用该连接。`,
    recognitionConnectionEndpoint: '服务地址',
    recognitionConnectionEndpointHelp: '填写 API 根地址，例如 https://api.siliconflow.cn/v1；不要包含 /audio/transcriptions。',
    recognitionConnectionEndpointMissing: '服务地址不能为空。',
    recognitionConnectionApiKey: 'API Key',
    recognitionConnectionApiKeyPlaceholder: '留空则保留现有 API Key',
    recognitionConnectionApiKeyHelp: '只有填写新值时才会替换现有 API Key。',
    recognitionConnectionModel: 'ASR 模型 ID',
    recognitionConnectionModelPlaceholder: '例如 FunAudioLLM/SenseVoiceSmall',
    recognitionConnectionSave: '保存配置',
    recognitionConnectionUpdated: '语音识别配置已更新',
    recognitionConnectionUpdatedDetail: (connection, model) => `${connection} · ${model}`,
    recognitionConnectionUpdateFailed: '修改语音识别连接失败',
    cancel: '取消',
    saveFailed: '保存语音设置失败',
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
    statusAria: 'Voice capability status',
    statusHelp: 'The microphone records only a short sample during the self-check and discards it immediately. No audio leaves this machine until you configure a speech-to-text model, and transcripts return to the composer for you to confirm before sending.',
    microphone: 'Microphone permission',
    checking: 'Checking…',
    run: 'Run recording check',
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
    recognitionTitle: 'Speech recognition',
    realtimeTitle: 'Realtime voice coordinator',
    connection: 'Model connection',
    model: 'Model ID',
    language: 'Language (optional)',
    prompt: 'Recognition prompt (optional)',
    voice: 'Voice',
    notConfigured: 'Not configured',
    testRecognition: 'Record for four seconds and test',
    recognitionTesting: 'Recording and calling the configured recognition model…',
    recognitionSuccess: 'Speech recognition test passed',
    recognitionFailed: 'Speech recognition test failed',
    createRecognitionConnection: 'New recognition connection',
    createRecognitionConnectionTitle: 'New speech recognition connection',
    createRecognitionConnectionSubtitle: 'Enter an OpenAI-compatible speech recognition endpoint, API key, and ASR model ID. The new connection and model will be selected automatically.',
    recognitionConnectionCreated: 'Speech recognition connection created',
    recognitionConnectionCreatedDetail: (connection, model) => `Selected ${connection} · ${model}`,
    recognitionConnectionCreateFailed: 'Could not create speech recognition connection',
    recognitionConnectionModelMissing: 'The ASR model ID is required.',
    editRecognitionConnection: 'Edit current configuration',
    editRecognitionConnectionTitle: 'Edit speech recognition connection',
    editRecognitionConnectionSubtitle: (connection) => `Edit the endpoint, API key, and ASR model for ${connection}. This connection remains selected after saving.`,
    recognitionConnectionEndpoint: 'Endpoint',
    recognitionConnectionEndpointHelp: 'Enter the API root, such as https://api.siliconflow.cn/v1. Do not include /audio/transcriptions.',
    recognitionConnectionEndpointMissing: 'The endpoint is required.',
    recognitionConnectionApiKey: 'API Key',
    recognitionConnectionApiKeyPlaceholder: 'Leave blank to keep the existing API key',
    recognitionConnectionApiKeyHelp: 'The existing API key is replaced only when a new value is entered.',
    recognitionConnectionModel: 'ASR model ID',
    recognitionConnectionModelPlaceholder: 'For example, FunAudioLLM/SenseVoiceSmall',
    recognitionConnectionSave: 'Save configuration',
    recognitionConnectionUpdated: 'Speech recognition configuration updated',
    recognitionConnectionUpdatedDetail: (connection, model) => `${connection} · ${model}`,
    recognitionConnectionUpdateFailed: 'Could not update speech recognition connection',
    cancel: 'Cancel',
    saveFailed: 'Could not save voice settings',
  },
} satisfies UiCatalog<VoiceSettingsCopy>;

export function getVoiceSettingsCopy(locale: UiLocale): VoiceSettingsCopy {
  return SETTINGS_VOICE_COPY[locale];
}
