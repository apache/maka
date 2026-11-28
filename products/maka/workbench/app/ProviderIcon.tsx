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

import {
  Canvas,
  Path2D,
  platform,
  View,
  type CanvasPaint,
  type CanvasRenderingContext2D,
} from 'nsh';
import { Icon } from './Icon';
import {
  PROVIDER_BRANDS,
  resolveExternalAgentBrand,
  resolveProviderBrand,
  type BrandFill,
  type ProviderBrandId,
  type ProviderBrandIdentity,
} from './providerBrands';
import { SettingsMonogram } from './SettingsPage';
import { C, radius } from './ui';

const terminal = platform.idiom === 'terminal';
const cachedPaths = new Map<string, Path2D>();

function path2d(d: string): Path2D {
  let cached = cachedPaths.get(d);
  if (!cached) {
    cached = new Path2D(d);
    cachedPaths.set(d, cached);
  }
  return cached;
}

function resolvePaint(
  cx: CanvasRenderingContext2D,
  fill: BrandFill,
  foreground: string,
): CanvasPaint {
  if (typeof fill === 'string') {
    return fill === 'currentColor' ? foreground : fill;
  }
  const gradient =
    fill.kind === 'linear'
      ? cx.createLinearGradient(fill.x0, fill.y0, fill.x1, fill.y1)
      : cx.createRadialGradient(fill.x0, fill.y0, fill.r0, fill.x1, fill.y1, fill.r1);
  for (const [offset, color] of fill.stops) {
    gradient.addColorStop(offset, color);
  }
  return gradient;
}

function drawBrandMark(
  cx: CanvasRenderingContext2D,
  brand: ProviderBrandId,
  size: number,
  foreground: string,
) {
  const mark = PROVIDER_BRANDS[brand];
  cx.save();
  const unit = size / 24;
  cx.scale(unit, unit);
  if ('scale' in mark && mark.scale !== undefined) {
    cx.scale(mark.scale, mark.scale);
  }
  if ('clipPath' in mark && mark.clipPath !== undefined) {
    cx.clip(path2d(mark.clipPath));
  }
  for (const shape of mark.shapes) {
    const opacity: number | undefined = 'opacity' in shape ? shape.opacity : undefined;
    const hasOpacity = opacity !== undefined && opacity !== 1;
    if (hasOpacity) {
      cx.save();
      cx.globalAlpha = opacity;
    }
    cx.fillStyle = resolvePaint(cx, shape.fill, foreground);
    if (shape.tag === 'path') {
      const rule = 'fillRule' in shape ? shape.fillRule : undefined;
      if (rule === 'evenodd') {
        cx.fill(path2d(shape.d), 'evenodd');
      } else {
        cx.fill(path2d(shape.d));
      }
    } else {
      cx.beginPath();
      cx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
      cx.fill();
    }
    if (hasOpacity) {
      cx.restore();
    }
  }
  cx.restore();
}

function BrandCanvas(props: { brand: ProviderBrandId; size: number; color: string }) {
  return (
    <Canvas
      accessibilityElementsHidden
      style={[{ width: props.size, height: props.size, flexShrink: 0 }, { pointerEvents: 'none' }]}
      draw={(cx) => drawBrandMark(cx, props.brand, props.size, props.color)}
    />
  );
}

/**
 * Renders a provider or external agent vector brand mark on desktop `<Canvas>`,
 * falling back cleanly to `SettingsMonogram` (tile variant) or a generic `Icon`
 * (inline variant) for unrecognized providers and terminal sessions.
 */
export function ProviderIcon(props: {
  brand?: ProviderBrandId | null;
  provider?: ProviderBrandIdentity | null;
  runtime?: string | null;
  name?: string;
  muted?: boolean;
  variant?: 'tile' | 'inline';
  size?: number;
  color?: string;
  fallbackIcon?: Parameters<typeof Icon>[0]['name'];
}) {
  const brand = (): ProviderBrandId | null =>
    props.brand !== undefined
      ? props.brand
      : props.runtime !== undefined
        ? resolveExternalAgentBrand(props.runtime)
        : resolveProviderBrand(props.provider);

  if (props.variant === 'inline') {
    const size = () => props.size ?? 16;
    const fallback = () => (
      <Icon
        name={props.fallbackIcon ?? 'bot'}
        color={props.color ?? (props.muted ? C.muted : C.secondary)}
        size={size()}
      />
    );
    if (terminal) return fallback();
    return (
      <If when={brand() !== null} else={fallback()}>
        <View
          accessibilityElementsHidden
          style={[
            {
              width: size(),
              height: size(),
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              opacity: props.muted ? 0.45 : 1,
            },
            { pointerEvents: 'none' },
          ]}
        >
          <BrandCanvas brand={brand()!} size={size()} color={props.color ?? C.text} />
        </View>
      </If>
    );
  }

  return (
    <If when={!terminal}>
      <If
        when={brand() !== null}
        else={<SettingsMonogram name={props.name ?? ''} muted={Boolean(props.muted)} />}
      >
        <View
          accessibilityElementsHidden
          style={[
            {
              width: 28,
              height: 28,
              borderRadius: radius(8),
              backgroundColor: C.cardRaised,
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            },
            { pointerEvents: 'none' },
          ]}
        >
          <View
            style={[
              {
                opacity: props.muted ? 0.45 : 1,
                alignItems: 'center',
                justifyContent: 'center',
              },
              { pointerEvents: 'none' },
            ]}
          >
            <BrandCanvas brand={brand()!} size={props.size ?? 16} color={props.color ?? C.text} />
          </View>
        </View>
      </If>
    </If>
  );
}
