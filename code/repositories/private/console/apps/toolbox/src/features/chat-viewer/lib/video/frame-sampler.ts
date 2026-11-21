/**
 * 抽帧时间表生成参数。
 */
export type FrameScheduleOptions = {
  durationSeconds: number;
  framesPerSecond: number;
  maxFrames?: number;
};

/**
 * 从视频中采样出的单帧图片。
 */
export type SampledVideoFrame = {
  blob: Blob;
  timeSeconds: number;
  width: number;
  height: number;
};

/**
 * 视频抽帧的完整参数。
 */
export type SampleVideoFramesOptions = FrameScheduleOptions & {
  mimeType?: string;
  quality?: number;
  /**
   * 每完成一帧采样后触发的进度回调。
   */
  onProgress?: (progress: {
    completedFrames: number;
    totalFrames: number;
    timeSeconds: number;
  }) => void;
};

/**
 * 根据视频时长和帧率生成采样时间点。
 */
export function buildFrameSchedule({
  durationSeconds,
  framesPerSecond,
  maxFrames,
}: FrameScheduleOptions): number[] {
  if (durationSeconds <= 0 || framesPerSecond <= 0) {
    return [];
  }

  /**
   * 理论上需要采样的帧数。
   */
  const frameCount = Math.ceil(durationSeconds * framesPerSecond);

  /**
   * 应用 maxFrames 后的最终采样帧数。
   */
  const cappedFrameCount =
    maxFrames === undefined ? frameCount : Math.min(frameCount, Math.max(0, maxFrames));

  /**
   * 相邻采样帧之间的时间间隔。
   */
  const intervalSeconds = 1 / framesPerSecond;

  return Array.from({ length: cappedFrameCount }, (_, index) =>
    Number((index * intervalSeconds).toFixed(6)),
  );
}

/**
 * 从视频 Blob 中按时间表抽取图片帧。
 */
export async function sampleVideoFrames(
  videoBlob: Blob,
  options: SampleVideoFramesOptions,
): Promise<SampledVideoFrame[]> {
  /**
   * 浏览器临时对象 URL，用于把 Blob 交给 video 元素加载。
   */
  const objectUrl = URL.createObjectURL(videoBlob);

  /**
   * 离屏 video 元素，用于定位和绘制视频帧。
   */
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = objectUrl;

  try {
    await waitForVideoMetadata(video);

    /**
     * 实际执行的采样时间点列表。
     */
    const schedule = buildFrameSchedule({
      durationSeconds: options.durationSeconds || video.duration,
      framesPerSecond: options.framesPerSecond,
      maxFrames: options.maxFrames,
    });

    /**
     * 承载当前视频帧绘制结果的离屏画布。
     */
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create canvas 2D context.");
    }

    /**
     * 已完成采样的帧结果集合。
     */
    const frames: SampledVideoFrame[] = [];
    for (const timeSeconds of schedule) {
      await seekVideo(video, Math.min(timeSeconds, Math.max(0, video.duration)));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await canvasToBlob(
        canvas,
        options.mimeType ?? "image/webp",
        options.quality ?? 0.9,
      );
      frames.push({
        blob,
        timeSeconds,
        width: canvas.width,
        height: canvas.height,
      });
      options.onProgress?.({
        completedFrames: frames.length,
        totalFrames: schedule.length,
        timeSeconds,
      });
    }

    return frames;
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * 等待视频元数据加载完成，确保时长和尺寸可读。
 */
function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (Number.isFinite(video.duration) && video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Unable to load video metadata."));
  });
}

/**
 * 跳转 video 元素到指定时间点。
 */
function seekVideo(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    video.onseeked = () => resolve();
    video.onerror = () => reject(new Error("Unable to seek video."));
    video.currentTime = timeSeconds;
  });
}

/**
 * 将画布内容编码为图片 Blob。
 */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Unable to encode sampled frame."));
      },
      mimeType,
      quality,
    );
  });
}
