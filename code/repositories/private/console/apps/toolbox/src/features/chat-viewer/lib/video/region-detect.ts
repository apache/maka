import type { Rect } from "@/features/chat-viewer/lib/domain/schemas";

/**
 * 待处理视频帧的尺寸。
 */
export type FrameDimensions = {
  width: number;
  height: number;
};

/**
 * 可被裁剪为聊天区域的帧来源类型。
 */
export type CropFrameSource = Blob | ImageBitmap | HTMLCanvasElement | HTMLImageElement;

/**
 * 估算桌面微信窗口中的聊天消息区域。
 */
export function detectDesktopWechatChatRegion({ width, height }: FrameDimensions): Rect {
  /**
   * 桌面微信左侧会话列表的估算宽度。
   */
  const leftListWidth = Math.max(280, Math.round(width * 0.22));

  /**
   * 顶部标题栏的估算高度。
   */
  const titleBarHeight = Math.max(40, Math.round(height * 0.06));

  /**
   * 底部输入框区域的估算高度。
   */
  const inputBoxHeight = Math.max(160, Math.round(height * 0.18));

  return clampRect(
    {
      x: leftListWidth,
      y: titleBarHeight,
      width: width - leftListWidth,
      height: height - titleBarHeight - inputBoxHeight,
    },
    width,
    height,
  );
}

/**
 * 将一帧图片裁剪为给定聊天区域。
 */
export async function cropFrameToRegion(
  source: CropFrameSource,
  region: Rect,
): Promise<ImageBitmap> {
  /**
   * 标准化后的图片来源。
   */
  const image = await createImageBitmap(source);

  /**
   * 限制在图片边界内的安全裁剪区域。
   */
  const crop = clampRect(region, image.width, image.height);

  /**
   * 承载裁剪结果的离屏画布。
   */
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create canvas 2D context.");
  }

  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );

  return createImageBitmap(canvas);
}

/**
 * 将裁剪区域限制到图片尺寸范围内。
 */
function clampRect(region: Rect, frameWidth: number, frameHeight: number): Rect {
  const x = clamp(Math.round(region.x), 0, Math.max(0, frameWidth));
  const y = clamp(Math.round(region.y), 0, Math.max(0, frameHeight));
  const right = clamp(Math.round(region.x + region.width), x, Math.max(0, frameWidth));
  const bottom = clamp(Math.round(region.y + region.height), y, Math.max(0, frameHeight));

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

/**
 * 将数值限制到闭区间内。
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
