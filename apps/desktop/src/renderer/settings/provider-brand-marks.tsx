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

// Official provider brand marks.
//
// Most SVG paths are vendored from `@lobehub/icons-static-svg` (MIT-licensed,
// https://github.com/lobehub/lobe-icons) — the React package was NOT
// adopted because its peerDependencies pull in antd + @lobehub/ui, which
// we don't use. We copy only the handful of marks we render, so there is
// zero runtime dependency. MiniMax comes from Simple Icons (CC0-1.0). Each brand logo remains the
// trademark of its owner and is used here only to identify the provider.
//
// Color marks keep their brand fill; monochrome marks use `currentColor`
// so they inherit the containing product slot's foreground color and stay
// legible in both light and dark themes; viewBox is the upstream 24×24.

import type { ProviderType } from '@maka/core/llm-connections';
import type { ReactElement } from 'react';
import { siMinimax } from 'simple-icons';
import alibabaBrandMark from '../assets/provider-brands/alibabacloud.svg';
import cerebrasBrandMark from '../assets/provider-brands/cerebras.svg';
import cohereBrandMark from '../assets/provider-brands/cohere.svg';
import cloudflareMarkUrl from '../assets/provider-brands/cloudflare.svg';
import deepinfraBrandMark from '../assets/provider-brands/deepinfra.svg';
import fireworksMarkUrl from '../assets/provider-brands/fireworks.svg';
import githubCopilotBrandMark from '../assets/provider-brands/github-copilot.svg';
import groqBrandMark from '../assets/provider-brands/groq.svg';
import huggingfaceBrandMark from '../assets/provider-brands/huggingface.svg';
import hunyuanBrandMark from '../assets/provider-brands/hunyuan.svg';
import tencentCloudBrandMark from '../assets/provider-brands/tencentcloud.svg';
import lmStudioBrandMark from '../assets/provider-brands/lmstudio.svg';
import localAiBrandMark from '../assets/provider-brands/localai.svg';
import mistralBrandMark from '../assets/provider-brands/mistral.svg';
import togetherBrandMark from '../assets/provider-brands/together.svg';
import nvidiaMarkUrl from '../assets/provider-brands/nvidia.svg';
import opencodeBrandMark from '../assets/provider-brands/opencode.svg';
import openrouterBrandMark from '../assets/provider-brands/openrouter.svg';
import stepfunBrandMark from '../assets/provider-brands/stepfun.svg';
import vercelBrandMark from '../assets/provider-brands/vercel.svg';
import volcengineBrandMark from '../assets/provider-brands/volcengine.svg';
import xaiMarkUrl from '../assets/provider-brands/xai.svg';
import xiaomiMiMoMarkUrl from '../assets/provider-brands/xiaomimimo.svg';
import zaiMarkUrl from '../assets/provider-brands/zai.svg';
import zenmuxBrandMark from '../assets/provider-brands/zenmux.svg';

// ZenMux mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/zenmux.svg
// - variant: monochrome; no upstream color variant exists in this release
// - license: MIT (repository LICENSE); ZenMux trademark remains its owner's
// - SHA-256: 1f9fab4e48601ca583e44ff06f22040a8b40f8952bc6bd67e67b065bef00b4b5

// GitHub Copilot mark vendored byte-for-byte from the official Primer Octicons repository:
// - repository: https://github.com/primer/octicons
// - commit: 2ed936e7759451e80ae38b8147cbe2c89de6cc7a
// - path: icons/copilot-24.svg
// - SHA-256: eeafb3c2f333e04ccf7d031ae215f7adafaed4c6352556b0bf79496e048bcdd7
// - governance: GitHub Copilot name and logo remain GitHub trademarks; the Octicons MIT grant
//   does not grant trademark rights. Used unmodified only to identify the connected service.

// Real xAI/Grok mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: 32f4083f7a20b67ecdc7b29c0af031ada5a29c52
// - path: packages/static-svg/icons/xai.svg
// - license: MIT (repository LICENSE)
function XAI(): ReactElement {
  return <ProviderAssetMask src={xaiMarkUrl} />;
}

// Xiaomi MiMo and Z.AI marks vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - paths: packages/static-svg/icons/xiaomimimo.svg and packages/static-svg/icons/zai.svg
// - SHA-256: b04ad7dad52af2212c4567daf0ee6856f2c4625c92c680a27f9880295d558b71
//               e748cb5108ce37b116d7a5ba97d37e0ae97eadf6849b0de11afb248e244a01e1
// - license: MIT (repository LICENSE)
function XiaomiMiMo(): ReactElement {
  return <ProviderAssetMask src={xiaomiMiMoMarkUrl} />;
}

// Real Together AI mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/together-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 27ccaf118a431c386b88418a34a4346afd9638dde10e3f2295db2eec1fa5898a

// Real DeepInfra mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/deepinfra-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: bfc78853fe658f6446651d03218f3e809215fd7cb3bce841a6526de383286544

// Real Groq mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/groq.svg
// - variant: monochrome; no upstream color variant exists in this release
// - license: MIT (repository LICENSE)
// - SHA-256: 078d5cf6e7a54905040c15ddacf5ea33c13042fe7739e820cedc2096e4406651

// Real OpenRouter mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.92.0
// - commit: df132de5a0cef315b9a2f155b1949e39f4b89bb5
// - path: packages/static-svg/icons/openrouter-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 17bede1b89166f824ee06753dc526a3f5e18b769706deaab09d04a3a98de1a78

// Real Alibaba Cloud mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/alibabacloud-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 73ea97baf919edb3d888a77cd45b21574e190a80124a59e199ea6953a28a959c

// Cloudflare mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/cloudflare-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: cee35d3f0ecb7925ce0a89aeaff8b907cadae7c3fe44a23e4001cc8d5ee57502

// Fireworks mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/fireworks-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: f1c4782b86bc03a36323fd68ad6cc376c6b2ebe57b701cc958ebd6b8d37effd6

// Vendored from lobehub/lobe-icons (MIT):
// https://github.com/lobehub/lobe-icons
// npm package: @lobehub/icons-static-svg@1.91.0
// Git commit: e4302041fbb3039608d25f9f618bd462783b875e
// Source path: packages/static-svg/icons/lmstudio.svg
// Upstream SHA-256: 4a575e8382b52ce742ac5d21d361a7d2a08cea7c12390ee1bbb755ef7d3cc25b

// LocalAI mark vendored byte-for-byte from the official LocalAI repository:
// - repository: https://github.com/mudler/LocalAI
// - commit: b10e330590766ea621c0b03401e77a0589558e76
// - path: docs/assets/images/logos/logo.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 1349c022f30a58836e9b09591031f25bf4ff6bb8627bb50691a46a1c8a512c39

// Mistral mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/mistral-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 722f74b289d95486b43662fe24fa883b333701296f618406cd0ed502299170b6

// Cohere mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/cohere-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 84d0ee3cbe66f030e5a18cb2c86da9166ab2137c7a98781693bb1fbf31e392b9

// Hugging Face mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/huggingface-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 5d39d66bb6c9b026d3cb5de7bd9978dad3906570df2aca8f00078a6f8a3d0f5e

// Hunyuan mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/hunyuan-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 510e7bb438506b5aadfaf8b9551d1606efd5b4171161a64a64204c72a453658a

// Tencent Cloud mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/tencentcloud-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: f860dae064a3afd24970efd2bc5892f39438526bf52c3a9748f61fc05c1cfd58

// StepFun mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/stepfun-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: f55afc0e6004c8854f76bd5bbcc0fce9fc0ed9316691d54fb02d088c24fab40d

// Volcengine mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/volcengine-color.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 84f9e2cd1da7e73dc6c9a0f2521745d39cae96c008752cdb1baf57a8c94393a1

// Vercel mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: 32f4083f7a20b67ecdc7b29c0af031ada5a29c52
// - path: packages/static-svg/icons/vercel.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 4874d52d8b2ce7c309cbd10c424fee123b2c9483e76d76ad0dca41794483eb24

// OpenCode mark vendored byte-for-byte from Lobe Icons:
// - repository: https://github.com/lobehub/lobe-icons
// - package/version: @lobehub/icons-static-svg@1.91.0
// - commit: e4302041fbb3039608d25f9f618bd462783b875e
// - path: packages/static-svg/icons/opencode.svg
// - license: MIT (repository LICENSE)
// - SHA-256: 7cfa6e9d6726f7c9fa26c7d9aef0dfec52d20a137380454340f30f12ccbfd302

function ProviderAssetMask({ src }: { src: string }): ReactElement {
  const mask = `url("${src}")`;
  return <span className="providerAssetMask" style={{ maskImage: mask, WebkitMaskImage: mask }} aria-hidden="true" />;
}

function Claude(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="#D97757"
        fillRule="nonzero"
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
      />
    </svg>
  );
}

// @lobehub/icons-static-svg@1.91.0/icons/siliconcloud.svg
function SiliconCloud(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg">
      <path
        clipRule="evenodd"
        d="M22.956 6.521H12.522c-.577 0-1.044.468-1.044 1.044v3.13c0 .577-.466 1.044-1.043 1.044H1.044c-.577 0-1.044.467-1.044 1.044v4.174C0 17.533.467 18 1.044 18h10.434c.577 0 1.044-.467 1.044-1.043v-3.13c0-.578.466-1.044 1.043-1.044h9.391c.577 0 1.044-.467 1.044-1.044V7.565c0-.576-.467-1.044-1.044-1.044z"
      />
    </svg>
  );
}

function OpenAI(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  );
}

function Gemini(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="#3186FF"
        d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      />
      <path
        fill="url(#maka-gemini-0)"
        d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      />
      <path
        fill="url(#maka-gemini-1)"
        d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      />
      <path
        fill="url(#maka-gemini-2)"
        d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      />
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id="maka-gemini-0" x1="7" x2="11" y1="15.5" y2="12">
          <stop stopColor="#08B962" />
          <stop offset="1" stopColor="#08B962" stopOpacity="0" />
        </linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id="maka-gemini-1" x1="8" x2="11.5" y1="5.5" y2="11">
          <stop stopColor="#F94543" />
          <stop offset="1" stopColor="#F94543" stopOpacity="0" />
        </linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id="maka-gemini-2" x1="3.5" x2="17.5" y1="13.5" y2="12">
          <stop stopColor="#FABC12" />
          <stop offset=".46" stopColor="#FABC12" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function DeepSeek(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="#4D6BFE"
        d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"
      />
    </svg>
  );
}

function Moonshot(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg">
      <path d="M1.052 16.916l9.539 2.552a21.007 21.007 0 00.06 2.033l5.956 1.593a11.997 11.997 0 01-5.586.865l-.18-.016-.044-.004-.084-.009-.094-.01a11.605 11.605 0 01-.157-.02l-.107-.014-.11-.016a11.962 11.962 0 01-.32-.051l-.042-.008-.075-.013-.107-.02-.07-.015-.093-.019-.075-.016-.095-.02-.097-.023-.094-.022-.068-.017-.088-.022-.09-.024-.095-.025-.082-.023-.109-.03-.062-.02-.084-.025-.093-.028-.105-.034-.058-.019-.08-.026-.09-.031-.066-.024-.044-.015-.068-.025-.101-.037-.057-.022-.08-.03-.087-.035-.088-.035-.079-.032-.095-.04-.063-.028-.063-.027-.041-.018-.066-.03-.103-.047-.052-.024-.096-.046-.062-.03-.084-.04-.086-.044-.093-.047-.052-.027-.103-.055-.057-.03-.058-.032-.046-.026-.094-.053-.06-.034-.051-.03-.072-.041-.082-.05-.093-.056-.052-.032-.084-.053-.061-.039-.079-.05-.07-.047-.053-.035-.054-.036-.044-.03-.044-.03-.04-.028-.057-.04-.076-.054-.069-.05-.074-.054-.056-.042-.076-.057-.076-.059-.086-.067-.045-.035-.064-.052-.074-.06-.089-.073-.046-.039-.046-.039-.043-.037-.045-.04-.061-.053-.07-.062-.068-.06-.062-.058-.067-.062-.053-.05-.088-.084a13.28 13.28 0 01-.099-.097l-.029-.028-.041-.042-.069-.07-.05-.051-.05-.053-.168-.179-.08-.088-.062-.07-.071-.08-.042-.049-.053-.062-.058-.068-.046-.056-.027-.033-.045-.055-.066-.082-.041-.052-.05-.064-.02-.025a11.99 11.99 0 01-1.44-2.402zm-1.02-5.794l11.353 3.037a20.468 20.468 0 00-.469 2.011l10.817 2.894a12.076 12.076 0 01-1.845 2.005L.657 15.923l-.016-.046-.035-.104-.05-.153-.007-.023a11.896 11.896 0 01-.207-.741l-.03-.126-.018-.08-.021-.097-.018-.081-.018-.09-.017-.084-.018-.094c-.026-.141-.05-.283-.071-.426l-.017-.118-.011-.083-.013-.102-.019-.161-.005-.047a12.12 12.12 0 01-.034-2.145zm1.593-5.15l11.948 3.196c-.368.605-.705 1.231-1.01 1.875l11.295 3.022c-.142.82-.368 1.612-.668 2.365l-11.55-3.09L.124 10.26l.015-.1.008-.049.01-.067.015-.087.018-.098c.026-.148.056-.295.088-.442l.028-.124.02-.085.024-.097c.022-.09.045-.18.07-.268l.028-.102.023-.083.03-.1.025-.082.03-.096.026-.082.031-.095a11.896 11.896 0 011.01-2.232zm4.442-4.4L17.352 4.59a20.77 20.77 0 00-1.688 1.721l7.823 2.093c.267.852.442 1.744.513 2.665L2.106 5.213l.045-.065.027-.04.04-.055.046-.065.055-.076.054-.072.064-.086.05-.065.057-.073.055-.07.06-.074.055-.069.065-.077.054-.066.066-.077.053-.06.072-.082.053-.06.067-.074.054-.058.073-.078.058-.06.063-.067.168-.17.1-.098.059-.056.076-.071a12.084 12.084 0 012.272-1.677zM12.017 0h.097l.082.001.069.001.054.002.068.002.046.001.076.003.047.002.06.003.054.002.087.005.105.007.144.011.088.007.044.004.077.008.082.008.047.005.102.012.05.006.108.014.081.01.042.006.065.01.207.032.07.012.065.011.14.026.092.018.11.022.046.01.075.016.041.01.084.019.042.01.065.015.049.012.071.017.096.024.112.03.113.03.113.032.05.015.07.02.078.024.073.023.05.016.05.016.076.025.099.033.102.036.048.017.064.023.093.034.11.041.116.045.1.04.047.02.06.024.041.018.063.026.04.018.057.025.11.048.1.046.074.035.075.036.06.028.092.046.091.045.102.052.053.028.049.026.046.024.06.033.041.022.052.029.088.05.106.06.087.051.057.034.053.032.096.059.088.055.098.062.036.024.064.041.084.056.04.027.062.042.062.043.023.017c.054.037.108.075.161.114l.083.06.065.048.056.043.086.065.082.064.04.03.05.041.086.069.079.065.085.071c.712.6 1.353 1.283 1.909 2.031L7.222.994l.062-.027.065-.028.081-.034.086-.035c.113-.045.227-.09.341-.131l.096-.035.093-.033.084-.03.096-.031c.087-.03.176-.058.264-.085l.091-.027.086-.025.102-.03.085-.023.1-.026.087-.022.09-.023.091-.022.095-.022.09-.02.098-.021.091-.02.095-.018.092-.018.1-.018.091-.016.098-.017.092-.014.097-.015.092-.013.102-.013.091-.012.105-.012.09-.01.105-.01c.093-.01.186-.018.28-.024l.106-.008.09-.005.11-.006.093-.004.1-.004.097-.002.099-.002.197-.002z" />
    </svg>
  );
}

// Z.ai is the international brand of Zhipu AI (智谱). The product surfaced
// here ("Z.AI Coding Plan") carries the Z.ai wordmark — a stylized "Z" of
// three slanted strokes — NOT the legacy 智谱 molecule mark, so we vendor
// the Z.ai mark. Monochrome upstream (no color variant); uses currentColor.
function ZAI(): ReactElement {
  return <ProviderAssetMask src={zaiMarkUrl} />;
}

// MiniMax mark from the simple-icons package (CC0-1.0); the bundled version
// is whatever package-lock.json pins, so no version is repeated here.
function MiniMaxMark(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
      <path fill={`#${siMinimax.hex}`} d={siMinimax.path} />
    </svg>
  );
}

function GenericProviderMark(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="8" />
      <path d="M8 9.5h6.5a2 2 0 010 4H9.5a2 2 0 000 4H16" />
    </svg>
  );
}

// Vendored unchanged from @lobehub/icons-static-svg@1.91.0:
// https://github.com/lobehub/lobe-icons/blob/32f4083f7a20b67ecdc7b29c0af031ada5a29c52/packages/static-svg/icons/ollama.svg
// Lobe Icons is MIT licensed; this path is consumed verbatim, not redrawn here.
function Ollama(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" role="img" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg">
      <path d="M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zM7.44 2.3l-.003.002a.659.659 0 00-.285.238l-.005.006c-.138.189-.258.467-.348.832-.17.692-.216 1.631-.124 2.782.43-.128.899-.208 1.404-.237l.01-.001.019-.034c.046-.082.095-.161.148-.239.123-.771.022-1.692-.253-2.444-.134-.364-.297-.65-.453-.813a.628.628 0 00-.107-.09L7.44 2.3zm9.174.04l-.002.001a.628.628 0 00-.107.09c-.156.163-.32.45-.453.814-.29.794-.387 1.776-.23 2.572l.058.097.008.014h.03a5.184 5.184 0 011.466.212c.086-1.124.038-2.043-.128-2.722-.09-.365-.21-.643-.349-.832l-.004-.006a.659.659 0 00-.285-.239h-.004z" />
    </svg>
  );
}

/**
 * Official brand mark for a provider type. Aliases (subscription / CLI /
 * OpenAI-compatible variants) reuse the parent brand's mark.
 */
export function ProviderBrandMark({ type }: { type: ProviderType }): ReactElement {
  switch (type) {
    case 'nvidia':
      return <img src={nvidiaMarkUrl} alt="" />;
    case 'cerebras':
      return <img src={cerebrasBrandMark} alt="" />;
    case 'xai':
    case 'xai-oauth':
      return <XAI />;
    case 'togetherai':
      return <img src={togetherBrandMark} alt="" />;
    case 'deepinfra':
      return <img src={deepinfraBrandMark} alt="" />;
    case 'groq':
      return <ProviderAssetMask src={groqBrandMark} />;
    case 'openrouter':
      return <img src={openrouterBrandMark} alt="" />;
    case 'alibaba':
    case 'alibaba-coding-plan-cn':
    case 'alibaba-coding-plan':
    case 'alibaba-token-plan-cn':
    case 'alibaba-token-plan':
      return <img src={alibabaBrandMark} alt="" />;
    case 'cloudflare-workers-ai':
      return <img src={cloudflareMarkUrl} alt="" />;
    case 'fireworks-ai':
      return <img src={fireworksMarkUrl} alt="" />;
    case 'siliconflow':
      return <SiliconCloud />;
    case 'vercel':
      return <ProviderAssetMask src={vercelBrandMark} />;
    case 'opencode':
    case 'opencode-go':
    case 'opencode-free':
      return <ProviderAssetMask src={opencodeBrandMark} />;
    case 'anthropic':
    case 'anthropic-compatible':
    case 'claude-subscription':
      return <Claude />;
    case 'openai':
    case 'openai-codex':
    case 'openai-compatible':
    case 'openai-responses-compatible':
      return <OpenAI />;
    case 'github-copilot':
      return <ProviderAssetMask src={githubCopilotBrandMark} />;
    case 'google':
      return <Gemini />;
    case 'deepseek':
      return <DeepSeek />;
    case 'moonshot':
    case 'kimi-coding-plan':
      return <Moonshot />;
    case 'xiaomi-token-plan-cn':
    case 'xiaomi-token-plan-sgp':
    case 'xiaomi-token-plan-ams':
    case 'xiaomi':
      return <XiaomiMiMo />;
    case 'zai':
    case 'zai-coding-plan':
      return <ZAI />;
    case 'minimax-coding-plan':
    case 'MiniMax':
    case 'MiniMax-cn':
      return <MiniMaxMark />;
    case 'ollama':
    case 'ollama-cloud':
      return <Ollama />;
    case 'lm-studio':
      return <ProviderAssetMask src={lmStudioBrandMark} />;
    case 'localai':
      return <img src={localAiBrandMark} alt="" />;
    case 'mistral':
      return <img src={mistralBrandMark} alt="" />;
    case 'cohere':
      return <img src={cohereBrandMark} alt="" />;
    case 'huggingface':
      return <img src={huggingfaceBrandMark} alt="" />;
    case 'zenmux':
      return <ProviderAssetMask src={zenmuxBrandMark} />;
    case 'tencent-tokenhub':
      return <img src={hunyuanBrandMark} alt="" />;
    case 'tencent-coding-plan':
    case 'tencent-token-plan':
      return <img src={tencentCloudBrandMark} alt="" />;
    case 'stepfun-ai-step-plan':
    case 'stepfun-step-plan':
    case 'stepfun-ai':
    case 'stepfun':
      return <img src={stepfunBrandMark} alt="" />;
    case 'volcengine-ark':
    case 'volcengine-coding-plan':
    case 'volcengine-agent-plan':
      return <img src={volcengineBrandMark} alt="" />;
    default:
      return <GenericProviderMark />;
  }
}
