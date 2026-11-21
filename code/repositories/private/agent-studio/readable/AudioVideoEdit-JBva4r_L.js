import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Ar as r,
  Br as i,
  E as a,
  Ei as o,
  F as s,
  Hi as c,
  Ht as l,
  Ii as u,
  K as d,
  Kr as f,
  Kt as p,
  Or as m,
  Pi as h,
  Rr as g,
  T as _,
  Vt as v,
  W as y,
  Y as b,
  Yi as x,
  b as S,
  ci as C,
  dr as w,
  dt as T,
  er as E,
  f as D,
  fn as ee,
  ft as O,
  gn as k,
  j as A,
  lt as te,
  nn as j,
  or as M,
  q as N,
  rr as ne,
  tt as re,
  u as ie,
  un as P,
  yr as F,
} from "./vendor-antd.QfSgOu5e.js";
import {
  a as ae,
  d as oe,
  f as se,
  h as ce,
  l as le,
  n as ue,
  p as de,
  s as fe,
} from "./knowledge-B15iS6D5.js";
import { t as pe } from "./oss-Cy14UKhC.js";
import { t as I } from "./knowledge-model-config-2k16YL5C.js";
import {
  J as me,
  St as L,
  Tt as R,
  W as he,
  Y as ge,
} from "./index.B_LPe2F7.js";
import { t as _e } from "./DetailLayout-139jNxZs.js";
import { t as ve } from "./doc.api-VLu_TcYx.js";
import { r as ye, t as be } from "./SegmentEditModal-i88UFvxt.js";
import { t as xe } from "./SensitiveWordsTable-JUreUfuP.js";
import { n as Se, t as Ce } from "./onDeployConfirm-LfJr7a5N.js";
import "./utils-Diwvqo7L.js";
var z = e(t(), 1);
v();
var B = {
    "step1-wrapper": `_step1-wrapper_1d8ii_6`,
    left: `_left_1d8ii_13`,
    "left-header": `_left-header_1d8ii_24`,
    "left-body": `_left-body_1d8ii_27`,
    right: `_right_1d8ii_35`,
    title: `_title_1d8ii_46`,
    subtitle: `_subtitle_1d8ii_51`,
    "link-text": `_link-text_1d8ii_57`,
    "upload-dragger": `_upload-dragger_1d8ii_65`,
    "upload-icon-wrapper": `_upload-icon-wrapper_1d8ii_83`,
    "upload-icon": `_upload-icon_1d8ii_83`,
    "upload-text": `_upload-text_1d8ii_100`,
    "upload-rules": `_upload-rules_1d8ii_106`,
    "upload-rule-item": `_upload-rule-item_1d8ii_113`,
    "upload-rule-content": `_upload-rule-content_1d8ii_116`,
    "file-list": `_file-list_1d8ii_123`,
    "clear-btn": `_clear-btn_1d8ii_129`,
    "file-list-header": `_file-list-header_1d8ii_133`,
    "file-item": `_file-item_1d8ii_144`,
    "file-card": `_file-card_1d8ii_158`,
    "file-card-active": `_file-card-active_1d8ii_175`,
    "file-icon": `_file-icon_1d8ii_179`,
    "file-main": `_file-main_1d8ii_185`,
    "file-meta": `_file-meta_1d8ii_190`,
    "file-name": `_file-name_1d8ii_195`,
    "file-size": `_file-size_1d8ii_201`,
    "file-delete": `_file-delete_1d8ii_206`,
    "file-progress-row": `_file-progress-row_1d8ii_218`,
    "file-progress": `_file-progress_1d8ii_218`,
    "file-info-row": `_file-info-row_1d8ii_232`,
    "file-alert": `_file-alert_1d8ii_238`,
    "file-info": `_file-info_1d8ii_232`,
    "file-tag": `_file-tag_1d8ii_251`,
    "file-tag-video": `_file-tag-video_1d8ii_259`,
    "file-tag-audio": `_file-tag-audio_1d8ii_262`,
    "file-status": `_file-status_1d8ii_279`,
    "file-status-uploading": `_file-status-uploading_1d8ii_285`,
    "file-status-success": `_file-status-success_1d8ii_288`,
    "file-status-error": `_file-status-error_1d8ii_291`,
    "preview-area": `_preview-area_1d8ii_294`,
    "preview-video": `_preview-video_1d8ii_304`,
    "preview-audio": `_preview-audio_1d8ii_309`,
    "preview-audio-wrapper": `_preview-audio-wrapper_1d8ii_312`,
    "preview-placeholder": `_preview-placeholder_1d8ii_322`,
    "preview-empty-img": `_preview-empty-img_1d8ii_331`,
    "preview-empty-text": `_preview-empty-text_1d8ii_335`,
    "preview-icon": `_preview-icon_1d8ii_340`,
    "progress-wrapper": `_progress-wrapper_1d8ii_345`,
    "progress-text": `_progress-text_1d8ii_352`,
  },
  we = (function (e) {
    return (
      (e[(e.Unprocessed = 0)] = `Unprocessed`),
      (e[(e.Processing = 1)] = `Processing`),
      (e[(e.Completed = 2)] = `Completed`),
      e
    );
  })({}),
  V = (function (e) {
    return (
      (e[(e.Step1 = 0)] = `Step1`),
      (e[(e.Step2 = 1)] = `Step2`),
      (e[(e.Step3 = 2)] = `Step3`),
      (e[(e.Step4 = 3)] = `Step4`),
      e
    );
  })({}),
  H = (function (e) {
    return (
      (e.Enabled = `enabled`),
      (e.Disabled = `disabled`),
      (e.Reviewing = `reviewing`),
      e
    );
  })({}),
  U = [
    `.aac`,
    `.amr`,
    `.flac`,
    `.m4a`,
    `.mp3`,
    `.ogg`,
    `.opus`,
    `.wav`,
    `.webm`,
    `.wma`,
  ],
  W = [`.mp4`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.flv`, `.mpeg`],
  Te = [...U, ...W],
  G = /^[\u4e00-\u9fa5a-zA-Z0-9._\-()（） +]+$/,
  Ee = 200,
  De = (e) => `.${e.split(`.`).pop()?.toLowerCase() || ``}`,
  Oe = (e) => {
    let t = e.lastIndexOf(`.`);
    return t > 0 ? e.substring(0, t) : e;
  },
  ke = (e) => {
    if (e === 0) return `0 B`;
    let t = 1024,
      n = [`B`, `KB`, `MB`, `GB`],
      r = e,
      i = 0;
    for (; r >= t && i < n.length - 1;) ((r /= t), i++);
    return `${Number(r.toFixed(1))} ${n[i]}`;
  },
  Ae = (e) => W.includes(De(e)),
  K = [`.aac`, `.flac`, `.m4a`, `.mp3`, `.ogg`, `.opus`, `.wav`, `.webm`],
  je = [`.mp4`, `.webm`, `.ogg`],
  q = (e) => {
    let t = De(e);
    return K.includes(t) || je.includes(t);
  },
  Me = 1024 * 1024,
  Ne = async (e) => {
    let { size: t } = e,
      n = [
        [0, Math.min(Me, t)],
        [
          Math.max(0, Math.floor(t / 2) - Me / 2),
          Math.max(0, Math.floor(t / 2) + Me / 2),
        ],
        [Math.max(0, t - Me), t],
      ],
      r = await Promise.all(n.map(([t, n]) => e.slice(t, n).arrayBuffer())),
      i = r.reduce((e, t) => e + t.byteLength, 0),
      a = new Uint8Array(i),
      o = 0;
    for (let e of r) (a.set(new Uint8Array(e), o), (o += e.byteLength));
    let s = await crypto.subtle.digest(`SHA-256`, a);
    return `${t}-${Array.from(new Uint8Array(s))
      .map((e) => e.toString(16).padStart(2, `0`))
      .join(``)}`;
  },
  Pe = (e) => {
    let t = [],
      n = De(e.name);
    (Te.includes(n) ||
      t.push(
        `「${e.name}」不支持该文件格式，音频支持 mp3/wav/m4a/aac/flac 等12种格式，视频支持 mp4/mov/avi 等5种格式`,
      ),
      e.size === 0 && t.push(`「${e.name}」为空文件，无法进行处理`),
      e.size &&
        e.size > 536870912 &&
        t.push(
          `「${e.name}」文件大小超过512MB限制（当前 ${ke(e.size)}），请压缩后重新上传`,
        ));
    let r = Oe(e.name);
    return (
      r.length > Ee &&
        t.push(
          `「${e.name}」文件名过长（当前 ${r.length} 字符），不能超过 ${Ee} 个字符`,
        ),
      G.test(r) ||
        t.push(
          `「${e.name}」文件名包含不支持的字符，仅支持中英文、数字、空格及 . - _ ( ) 符号`,
        ),
      t
    );
  },
  Fe = (e) =>
    (e?.files || []).map((e, t) => ({
      uid: `existing-${t}`,
      name: e.docName || e.name || ``,
      size: e.fileSize || e.size,
      status: `done`,
      url: e.url,
    })),
  Ie = (e) =>
    e.map((e) => ({
      ...e,
      sizeFormatted: ke(e.size || 0),
      isVideo: Ae(e.name),
    })),
  J = n(),
  Le = `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/preview-empty.png`,
  Re = ({ percent: e }) =>
    (0, J.jsxs)(`div`, {
      className: B[`progress-wrapper`],
      children: [
        (0, J.jsxs)(p.Text, {
          type: `secondary`,
          className: B[`progress-text`],
          children: [`正在转码中 `, e, `%`],
        }),
        (0, J.jsx)(E, {
          percent: e,
          strokeColor: `#7165ee`,
          trailColor: `#e8e8e8`,
          showInfo: !1,
          size: `small`,
        }),
      ],
    }),
  ze = (0, z.memo)(
    ({
      previewFile: e,
      previewSrc: t,
      convertedPreviewSrc: n,
      converting: r,
      progress: i = 0,
      error: a,
    }) =>
      (0, J.jsxs)(`div`, {
        className: B.right,
        children: [
          (0, J.jsx)(p.Title, {
            level: 5,
            className: B.title,
            children: `音视频预览`,
          }),
          (0, J.jsx)(p.Paragraph, {
            className: B.subtitle,
            children: `仅提供部分分段预览的视频`,
          }),
          (0, J.jsx)(`div`, {
            className: B[`preview-area`],
            children: e
              ? r
                ? (0, J.jsx)(`div`, {
                    className: B[`preview-placeholder`],
                    children:
                      i > 0
                        ? (0, J.jsx)(Re, { percent: Math.round(i * 100) })
                        : (0, J.jsxs)(J.Fragment, {
                            children: [
                              (0, J.jsx)(A, { className: B[`preview-icon`] }),
                              (0, J.jsx)(p.Text, {
                                type: `secondary`,
                                children: `正在加载解码器...`,
                              }),
                            ],
                          }),
                  })
                : q(e.name)
                  ? t
                    ? Ae(e.name)
                      ? (0, J.jsx)(`video`, {
                          controls: !0,
                          className: B[`preview-video`],
                          src: t,
                        })
                      : (0, J.jsx)(`div`, {
                          className: B[`preview-audio-wrapper`],
                          children: (0, J.jsx)(`audio`, {
                            controls: !0,
                            className: B[`preview-audio`],
                            src: t,
                          }),
                        })
                    : (0, J.jsx)(`div`, {
                        className: B[`preview-placeholder`],
                        children: (0, J.jsx)(p.Text, {
                          type: `secondary`,
                          children: `无法获取预览地址`,
                        }),
                      })
                  : n
                    ? Ae(e.name)
                      ? (0, J.jsx)(`video`, {
                          controls: !0,
                          className: B[`preview-video`],
                          src: n,
                        })
                      : (0, J.jsx)(`div`, {
                          className: B[`preview-audio-wrapper`],
                          children: (0, J.jsx)(`audio`, {
                            controls: !0,
                            className: B[`preview-audio`],
                            src: n,
                          }),
                        })
                    : (0, J.jsxs)(`div`, {
                        className: B[`preview-placeholder`],
                        children: [
                          (0, J.jsx)(y, { className: B[`preview-icon`] }),
                          (0, J.jsx)(p.Text, {
                            type: `secondary`,
                            children: `当前格式不支持浏览器预览，请下载后查看`,
                          }),
                        ],
                      })
              : (0, J.jsxs)(`div`, {
                  className: B[`preview-placeholder`],
                  children: [
                    (0, J.jsx)(`img`, {
                      src: Le,
                      alt: `选择要预览的文件`,
                      className: B[`preview-empty-img`],
                    }),
                    (0, J.jsx)(`p`, {
                      className: B[`preview-empty-text`],
                      children: `选择要预览的文件`,
                    }),
                  ],
                }),
          }),
        ],
      }),
  );
v();
var Be = `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/delete.svg`,
  Ve = (0, z.memo)(
    ({
      fileListWithInfo: e,
      uploadStatusMap: t,
      uploading: n,
      selectedFileUid: r,
      onSelectFile: i,
      handleClearAll: a,
      handlePreviewFile: o,
      handleRemove: s,
      retryFile: c,
    }) =>
      e.length === 0
        ? null
        : (0, J.jsxs)(`div`, {
            className: B[`file-list`],
            "data-file-list": `av`,
            children: [
              (0, J.jsx)(`div`, {
                className: B[`file-list-header`],
                children: (0, J.jsx)(x, {
                  size: `small`,
                  className: B[`clear-btn`],
                  onClick: a,
                  children: `清空列表`,
                }),
              }),
              e.map((e) => {
                let a = t.get(e.uid),
                  l = r === e.uid;
                return (0, J.jsxs)(
                  `div`,
                  {
                    className: `${B[`file-card`]} ${l ? B[`file-card-active`] : ``}`,
                    onClick: () => i?.(e),
                    children: [
                      (0, J.jsx)(`img`, {
                        src: `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/${e.isVideo ? `video-icon.svg` : `audio-icon.svg`}`,
                        alt: e.isVideo ? `视频` : `音频`,
                        className: B[`file-icon`],
                      }),
                      (0, J.jsxs)(`div`, {
                        className: B[`file-main`],
                        children: [
                          (0, J.jsx)(`div`, {
                            className: B[`file-meta`],
                            children: (0, J.jsx)(p.Text, {
                              className: B[`file-name`],
                              ellipsis: { tooltip: !0 },
                              onClick: (t) => {
                                (t.stopPropagation(), i?.(e), o(e));
                              },
                              children: e.name,
                            }),
                          }),
                          a?.status === `uploading` &&
                            (0, J.jsxs)(`div`, {
                              className: B[`file-progress-row`],
                              children: [
                                (0, J.jsx)(`div`, {
                                  className: B[`file-progress`],
                                  style: { width: `${a.progress}%` },
                                }),
                                (0, J.jsxs)(p.Text, {
                                  className: B[`file-status-uploading`],
                                  children: [a.progress, `%`],
                                }),
                              ],
                            }),
                          a?.status !== `uploading` &&
                            (0, J.jsxs)(`div`, {
                              className: B[`file-info-row`],
                              children: [
                                (0, J.jsx)(`span`, {
                                  className: B[`file-size`],
                                  children: e.sizeFormatted,
                                }),
                                a?.status === `success` &&
                                  (0, J.jsx)(p.Text, {
                                    className: B[`file-status-success`],
                                    children: `✓ 完成`,
                                  }),
                                a?.status === `error` &&
                                  (0, J.jsxs)(J.Fragment, {
                                    children: [
                                      (0, J.jsx)(p.Text, {
                                        className: B[`file-status-error`],
                                        title: a.errorMsg,
                                        children: `✗ 失败`,
                                      }),
                                      c &&
                                        (0, J.jsx)(x, {
                                          type: `link`,
                                          size: `small`,
                                          icon: (0, J.jsx)(S, {}),
                                          className: B[`retry-btn`],
                                          onClick: (t) => {
                                            (t.stopPropagation(), c(e.uid));
                                          },
                                          children: `重试`,
                                        }),
                                    ],
                                  }),
                              ],
                            }),
                        ],
                      }),
                      !n &&
                        (0, J.jsx)(`img`, {
                          src: Be,
                          alt: `删除`,
                          className: B[`file-delete`],
                          onClick: (t) => {
                            (t.stopPropagation(), s(e));
                          },
                        }),
                    ],
                  },
                  e.uid,
                );
              }),
            ],
          }),
  );
v();
var He = ({ open: e, onClose: t }) =>
  (0, J.jsx)(r, {
    title: `音视频上传说明`,
    width: 600,
    onClose: t,
    open: e,
    children: (0, J.jsxs)(p, {
      children: [
        (0, J.jsx)(p.Title, { level: 5, children: `1、单个文件上传说明：` }),
        (0, J.jsx)(p.Paragraph, { children: `支持上传单个音频或视频文件` }),
        (0, J.jsx)(p.Title, { level: 5, children: `支持格式：` }),
        (0, J.jsxs)(p.Paragraph, {
          children: [
            (0, J.jsxs)(`p`, {
              children: [
                (0, J.jsx)(`strong`, { children: `音频格式：` }),
                (0, J.jsx)(`br`, {}),
                `.aac、.amr、.flac、.flv、.m4a、.mp3、.mpeg、.ogg、.opus、.wav、.webm、.wma`,
              ],
            }),
            (0, J.jsxs)(`p`, {
              children: [
                (0, J.jsx)(`strong`, { children: `视频格式：` }),
                (0, J.jsx)(`br`, {}),
                `.mp4、.mkv、.avi、.mov、.wmv`,
              ],
            }),
          ],
        }),
        (0, J.jsx)(p.Title, { level: 5, children: `注意：` }),
        (0, J.jsxs)(p.Paragraph, {
          children: [
            (0, J.jsx)(`p`, { children: `1）可同时上传50个文件` }),
            (0, J.jsx)(`p`, { children: `2）单个文件大小不超过512MB` }),
            (0, J.jsx)(`p`, { children: `3）空文件无法上传` }),
            (0, J.jsx)(`p`, {
              children: `4）文件名不超过200字符，仅支持中英文、数字、空格及 . - _ ( )（ ）符号`,
            }),
            (0, J.jsx)(`p`, {
              children: `5）已上传的重复文件将自动检测并忽略，不重复上传`,
            }),
          ],
        }),
      ],
    }),
  });
v();
var Y = [
    `单音频：大小≤512MB，格式支持.aac,.amr,.flac,.m4a,.mp3,.ogg,.opus,.wav,.webm,.wma`,
    `单视频：大小≤512MB，格式支持.mp4,.mkv,.avi,.mov,.wmv,.flv,.mpeg`,
  ],
  Ue = (0, z.memo)(
    ({
      fileList: e,
      accept: t,
      beforeUpload: n,
      handleChange: r,
      handleRemove: i,
      drawerOpen: a,
      handleOpenDrawer: o,
      handleCloseDrawer: s,
      children: c,
    }) =>
      (0, J.jsxs)(`div`, {
        className: B.left,
        children: [
          (0, J.jsxs)(`div`, {
            className: B[`left-header`],
            children: [
              (0, J.jsx)(p.Title, {
                level: 5,
                className: B.title,
                children: `文件上传`,
              }),
              (0, J.jsxs)(p.Paragraph, {
                className: B.subtitle,
                children: [
                  `上传音频或视频前，请先查看`,
                  (0, J.jsx)(`span`, {
                    className: B[`link-text`],
                    onClick: o,
                    children: `《音视频上传说明》`,
                  }),
                  `，按要求上传`,
                ],
              }),
            ],
          }),
          (0, J.jsxs)(`div`, {
            className: B[`left-body`],
            children: [
              (0, J.jsxs)(l.Dragger, {
                className: B[`upload-dragger`],
                multiple: !0,
                accept: t,
                fileList: e,
                beforeUpload: n,
                onChange: r,
                onRemove: i,
                showUploadList: !1,
                maxCount: 50,
                children: [
                  (0, J.jsx)(`div`, {
                    className: B[`upload-icon-wrapper`],
                    children: (0, J.jsx)(`img`, {
                      src: `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/upload-icon.png`,
                      alt: `上传文件`,
                      width: `60`,
                      height: `60`,
                    }),
                  }),
                  (0, J.jsx)(p.Paragraph, {
                    className: B[`upload-text`],
                    children: `将文件拖到此处或点击上传`,
                  }),
                  (0, J.jsxs)(`ul`, {
                    className: B[`upload-rules`],
                    children: [
                      Y.map((e, t) =>
                        (0, J.jsx)(
                          `li`,
                          {
                            className: B[`upload-rule-item`],
                            children: (0, J.jsx)(`span`, {
                              className: B[`upload-rule-content`],
                              children: e,
                            }),
                          },
                          e,
                        ),
                      ),
                      (0, J.jsx)(`li`, {
                        className: B[`upload-rule-item`],
                        children: (0, J.jsxs)(`span`, {
                          className: B[`upload-rule-content`],
                          children: [`最多支持（`, e.length, `/`, 50, `）个`],
                        }),
                      }),
                    ],
                  }),
                ],
              }),
              c,
              (0, J.jsx)(He, { open: a, onClose: s }),
            ],
          }),
        ],
      }),
  ),
  X;
(function (e) {
  ((e.LOAD = `LOAD`),
    (e.EXEC = `EXEC`),
    (e.FFPROBE = `FFPROBE`),
    (e.WRITE_FILE = `WRITE_FILE`),
    (e.READ_FILE = `READ_FILE`),
    (e.DELETE_FILE = `DELETE_FILE`),
    (e.RENAME = `RENAME`),
    (e.CREATE_DIR = `CREATE_DIR`),
    (e.LIST_DIR = `LIST_DIR`),
    (e.DELETE_DIR = `DELETE_DIR`),
    (e.ERROR = `ERROR`),
    (e.DOWNLOAD = `DOWNLOAD`),
    (e.PROGRESS = `PROGRESS`),
    (e.LOG = `LOG`),
    (e.MOUNT = `MOUNT`),
    (e.UNMOUNT = `UNMOUNT`));
})((X ||= {}));
var We = (() => {
    let e = 0;
    return () => e++;
  })(),
  Ge = Error("ffmpeg is not loaded, call `await ffmpeg.load()` first"),
  Ke = Error(`called FFmpeg.terminate()`),
  qe = class {
    #e = null;
    #t = {};
    #n = {};
    #r = [];
    #i = [];
    loaded = !1;
    #a = () => {
      this.#e &&
        (this.#e.onmessage = ({ data: { id: e, type: t, data: n } }) => {
          switch (t) {
            case X.LOAD:
              ((this.loaded = !0), this.#t[e](n));
              break;
            case X.MOUNT:
            case X.UNMOUNT:
            case X.EXEC:
            case X.FFPROBE:
            case X.WRITE_FILE:
            case X.READ_FILE:
            case X.DELETE_FILE:
            case X.RENAME:
            case X.CREATE_DIR:
            case X.LIST_DIR:
            case X.DELETE_DIR:
              this.#t[e](n);
              break;
            case X.LOG:
              this.#r.forEach((e) => e(n));
              break;
            case X.PROGRESS:
              this.#i.forEach((e) => e(n));
              break;
            case X.ERROR:
              this.#n[e](n);
              break;
          }
          (delete this.#t[e], delete this.#n[e]);
        });
    };
    #o = ({ type: e, data: t }, n = [], r) =>
      this.#e
        ? new Promise((i, a) => {
            let o = We();
            (this.#e && this.#e.postMessage({ id: o, type: e, data: t }, n),
              (this.#t[o] = i),
              (this.#n[o] = a),
              r?.addEventListener(
                `abort`,
                () => {
                  a(
                    new DOMException(
                      `Message # ${o} was aborted`,
                      `AbortError`,
                    ),
                  );
                },
                { once: !0 },
              ));
          })
        : Promise.reject(Ge);
    on(e, t) {
      e === `log` ? this.#r.push(t) : e === `progress` && this.#i.push(t);
    }
    off(e, t) {
      e === `log`
        ? (this.#r = this.#r.filter((e) => e !== t))
        : e === `progress` && (this.#i = this.#i.filter((e) => e !== t));
    }
    load = ({ classWorkerURL: e, ...t } = {}, { signal: n } = {}) => (
      this.#e ||
        ((this.#e = e
          ? new Worker(new URL(e, import.meta.url), { type: `module` })
          : new Worker(
              new URL(
                `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/worker-BzdDEeh7.js`,
                `` + import.meta.url,
              ),
              { type: `module` },
            )),
        this.#a()),
      this.#o({ type: X.LOAD, data: t }, void 0, n)
    );
    exec = (e, t = -1, { signal: n } = {}) =>
      this.#o({ type: X.EXEC, data: { args: e, timeout: t } }, void 0, n);
    ffprobe = (e, t = -1, { signal: n } = {}) =>
      this.#o({ type: X.FFPROBE, data: { args: e, timeout: t } }, void 0, n);
    terminate = () => {
      let e = Object.keys(this.#n);
      for (let t of e) (this.#n[t](Ke), delete this.#n[t], delete this.#t[t]);
      this.#e && (this.#e.terminate(), (this.#e = null), (this.loaded = !1));
    };
    writeFile = (e, t, { signal: n } = {}) => {
      let r = [];
      return (
        t instanceof Uint8Array && r.push(t.buffer),
        this.#o({ type: X.WRITE_FILE, data: { path: e, data: t } }, r, n)
      );
    };
    mount = (e, t, n) =>
      this.#o(
        { type: X.MOUNT, data: { fsType: e, options: t, mountPoint: n } },
        [],
      );
    unmount = (e) => this.#o({ type: X.UNMOUNT, data: { mountPoint: e } }, []);
    readFile = (e, t = `binary`, { signal: n } = {}) =>
      this.#o({ type: X.READ_FILE, data: { path: e, encoding: t } }, void 0, n);
    deleteFile = (e, { signal: t } = {}) =>
      this.#o({ type: X.DELETE_FILE, data: { path: e } }, void 0, t);
    rename = (e, t, { signal: n } = {}) =>
      this.#o({ type: X.RENAME, data: { oldPath: e, newPath: t } }, void 0, n);
    createDir = (e, { signal: t } = {}) =>
      this.#o({ type: X.CREATE_DIR, data: { path: e } }, void 0, t);
    listDir = (e, { signal: t } = {}) =>
      this.#o({ type: X.LIST_DIR, data: { path: e } }, void 0, t);
    deleteDir = (e, { signal: t } = {}) =>
      this.#o({ type: X.DELETE_DIR, data: { path: e } }, void 0, t);
  },
  Je;
(function (e) {
  ((e.MEMFS = `MEMFS`),
    (e.NODEFS = `NODEFS`),
    (e.NODERAWFS = `NODERAWFS`),
    (e.IDBFS = `IDBFS`),
    (e.WORKERFS = `WORKERFS`),
    (e.PROXYFS = `PROXYFS`));
})((Je ||= {}));
var Ye = Error(`failed to get response body reader`),
  Xe = Error(`failed to complete download`),
  Ze = (e) =>
    new Promise((t, n) => {
      let r = new FileReader();
      ((r.onload = () => {
        let { result: e } = r;
        e instanceof ArrayBuffer ? t(new Uint8Array(e)) : t(new Uint8Array());
      }),
        (r.onerror = (e) => {
          n(
            Error(
              `File could not be read! Code=${e?.target?.error?.code || -1}`,
            ),
          );
        }),
        r.readAsArrayBuffer(e));
    }),
  Qe = async (e) => {
    let t;
    if (typeof e == `string`)
      t = /data:_data\/([a-zA-Z]*);base64,([^"]*)/.test(e)
        ? atob(e.split(`,`)[1])
            .split(``)
            .map((e) => e.charCodeAt(0))
        : await (await fetch(e)).arrayBuffer();
    else if (e instanceof URL) t = await (await fetch(e)).arrayBuffer();
    else if (e instanceof File || e instanceof Blob) t = await Ze(e);
    else return new Uint8Array();
    return new Uint8Array(t);
  },
  $e = async (e, t) => {
    let n = await fetch(e),
      r;
    try {
      let i = parseInt(n.headers.get(`Content-Length`) || `-1`),
        a = n.body?.getReader();
      if (!a) throw Ye;
      let o = [],
        s = 0;
      for (;;) {
        let { done: n, value: r } = await a.read(),
          c = r ? r.length : 0;
        if (n) {
          if (i != -1 && i !== s) throw Xe;
          t && t({ url: e, total: i, received: s, delta: c, done: n });
          break;
        }
        (o.push(r),
          (s += c),
          t && t({ url: e, total: i, received: s, delta: c, done: n }));
      }
      let c = new Uint8Array(s),
        l = 0;
      for (let e of o) (c.set(e, l), (l += e.length));
      r = c.buffer;
    } catch (i) {
      (console.log(`failed to send download progress event: `, i),
        (r = await n.arrayBuffer()),
        t &&
          t({
            url: e,
            total: r.byteLength,
            received: r.byteLength,
            delta: 0,
            done: !0,
          }));
    }
    return r;
  },
  et = async (e, t, n = !1, r) => {
    let i = n ? await $e(e, r) : await (await fetch(e)).arrayBuffer(),
      a = new Blob([i], { type: t });
    return URL.createObjectURL(a);
  },
  tt = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/worker-BzdDEeh7.js`,
  nt = 1024,
  rt = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm`,
  it = class e {
    static instance;
    ffmpeg = null;
    loaded = !1;
    progressCallback = null;
    eventsRegistered = !1;
    constructor() {}
    static getInstance() {
      return ((e.instance ||= new e()), e.instance);
    }
    async load() {
      if (this.loaded) {
        console.log(`[FFmpeg] 已加载，跳过`);
        return;
      }
      let e = performance.now();
      (console.log(`[FFmpeg] ========== 开始加载解码器 ==========`),
        console.log(`[FFmpeg] 版本: ESM 多线程`),
        console.log(`[FFmpeg] core 基础 URL:`, rt),
        console.log(`[FFmpeg] worker URL:`, tt));
      try {
        (this.ffmpeg ||
          (console.log(`[FFmpeg] 步骤1: 创建 FFmpeg 实例...`),
          (this.ffmpeg = new qe()),
          console.log(`[FFmpeg] 步骤1: ✓ 实例已创建`)),
          this.eventsRegistered ||
            (console.log(`[FFmpeg] 步骤2: 注册事件监听...`),
            this.ffmpeg.on(`log`, ({ message: e }) => {
              console.log(`[FFmpeg]`, e);
            }),
            this.ffmpeg.on(`progress`, ({ progress: e, time: t }) => {
              let n = Math.min(1, Math.max(0, e));
              this.progressCallback?.({ progress: n, time: t });
            }),
            (this.eventsRegistered = !0),
            console.log(`[FFmpeg] 步骤2: ✓ 事件已注册`)));
        let t = `${rt}/ffmpeg-core.js`,
          n = `${rt}/ffmpeg-core.wasm`,
          r = await et(tt, `text/javascript`);
        (console.log(`[FFmpeg] 步骤3: 下载 core/wasm 文件（toBlobURL）...`),
          console.log(`[FFmpeg]   - core.js  :`, t),
          console.log(`[FFmpeg]   - core.wasm:`, n),
          console.log(`[FFmpeg]   - worker mode:`, `PROD (toBlobURL)`),
          console.log(`[FFmpeg]   - worker URL:`, r));
        let i = performance.now(),
          a,
          o;
        try {
          (([a, o] = await Promise.all([
            et(t, `text/javascript`),
            et(n, `application/wasm`),
          ])),
            console.log(
              `[FFmpeg] 步骤3: ✓ 下载完成 (耗时 ${(performance.now() - i).toFixed(0)}ms)`,
            ),
            console.log(
              `[FFmpeg]   - coreURL  :`,
              a.startsWith(`blob:`) ? `blob URL` : typeof a,
            ),
            console.log(
              `[FFmpeg]   - wasmURL  :`,
              o.startsWith(`blob:`) ? `blob URL` : typeof o,
            ));
        } catch (e) {
          throw (
            console.error(`[FFmpeg] 步骤3: ✗ 下载 core/wasm 文件失败`),
            console.error(`[FFmpeg]   错误详情:`, e),
            console.error(
              `[FFmpeg]   可能原因: CDN 不可达、网络超时、CORS 未配置`,
            ),
            e
          );
        }
        console.log(
          `[FFmpeg] 步骤4: 调用 ffmpeg.load() 初始化 WASM + Worker...`,
        );
        let s = performance.now();
        try {
          (await this.ffmpeg.load({
            coreURL: a,
            wasmURL: o,
            classWorkerURL: r,
          }),
            console.log(
              `[FFmpeg] 步骤4: ✓ WASM + Worker 初始化完成 (耗时 ${(performance.now() - s).toFixed(0)}ms)`,
            ));
        } catch (e) {
          throw (
            console.error(`[FFmpeg] 步骤4: ✗ ffmpeg.load() 失败`),
            console.error(`[FFmpeg]   错误详情:`, e),
            console.error(
              `[FFmpeg]   可能原因: SharedArrayBuffer 不可用(缺少 COEP/COOP 头)、WASM 不兼容、Worker 创建失败`,
            ),
            console.error(
              `[FFmpeg]   SharedArrayBuffer 可用:`,
              typeof SharedArrayBuffer < `u`,
            ),
            console.error(
              `[FFmpeg]   crossOriginIsolated:`,
              window.crossOriginIsolated,
            ),
            e
          );
        }
        ((this.loaded = !0),
          console.log(
            `[FFmpeg] ========== 加载完成 (总耗时 ${(performance.now() - e).toFixed(0)}ms) ==========`,
          ));
      } catch (t) {
        throw (
          console.error(
            `[FFmpeg] ========== 加载失败 (耗时 ${(performance.now() - e).toFixed(0)}ms) ==========`,
          ),
          console.error(`[FFmpeg] 完整错误:`, t),
          t instanceof Error &&
            (console.error(`[FFmpeg] 错误消息:`, t.message),
            console.error(`[FFmpeg] 错误堆栈:`, t.stack)),
          t
        );
      }
    }
    onProgress(e) {
      this.progressCallback = e;
    }
    removeProgress() {
      this.progressCallback = null;
    }
    sanitizeFileName(e) {
      let t = e.lastIndexOf(`.`);
      return t === -1
        ? e.replace(/[^a-zA-Z0-9]/g, `_`)
        : `${e.substring(0, t).replace(/[^a-zA-Z0-9]/g, `_`)}${e.substring(t)}`;
    }
    async safeDeleteFile(e) {
      if (this.ffmpeg)
        try {
          await this.ffmpeg.deleteFile(e);
        } catch {}
    }
    async convert(e, t, n, r = []) {
      this.loaded || (await this.load());
      let i = this.ffmpeg,
        a = this.sanitizeFileName(t);
      (await this.safeDeleteFile(a), await this.safeDeleteFile(n));
      try {
        let t = await Qe(e);
        await i.writeFile(a, t);
        let o = [`-i`, a, ...r, `-y`, n];
        console.log(`[FFmpeg] 执行:`, o.join(` `));
        try {
          await i.exec(o);
        } catch (e) {
          console.warn(`[FFmpeg] exec 异常，尝试读取已生成文件:`, e);
        }
        let s;
        try {
          s = await i.readFile(n);
        } catch {
          throw Error(`输出文件不存在，转码失败`);
        }
        let c = typeof s == `string` ? new TextEncoder().encode(s) : s;
        if (c.length < nt)
          throw Error(`输出文件异常: size=${c.length}B, min=${nt}B`);
        let l = n.endsWith(`.mp4`) ? `video/mp4` : `audio/mp3`,
          u = new Blob([c], { type: l });
        return URL.createObjectURL(u);
      } finally {
        (await this.safeDeleteFile(a), await this.safeDeleteFile(n));
      }
    }
  },
  at = [`.wmv`, `.avi`, `.flv`, `.mpeg`],
  ot = [`.amr`, `.wma`],
  st = it.getInstance(),
  ct = (e) => `.${e.split(`.`).pop()?.toLowerCase() || ``}`,
  lt = (e) => {
    let t = ct(e);
    return at.includes(t) || ot.includes(t);
  },
  ut = (e) => {
    let t = ct(e);
    return at.includes(t)
      ? {
          outputName: `output.mp4`,
          args: [
            `-c:v`,
            `libx264`,
            `-profile:v`,
            `high`,
            `-level`,
            `4.1`,
            `-pix_fmt`,
            `yuv420p`,
            `-preset`,
            `ultrafast`,
            `-tune`,
            `zerolatency`,
            `-crf`,
            `23`,
            `-vf`,
            `scale=-2:480`,
            `-r`,
            `30`,
            `-c:a`,
            `aac`,
            `-b:a`,
            `128k`,
            `-movflags`,
            `+faststart`,
          ],
        }
      : {
          outputName: `output.mp3`,
          args: [`-c:a`, `libmp3lame`, `-ar`, `44100`, `-b:a`, `128k`],
        };
  },
  dt = async (e, t) => {
    let n = await (await fetch(e)).blob();
    return new File([n], t);
  },
  ft = (e, t) => {
    let [n, r] = (0, z.useState)(void 0),
      [i, a] = (0, z.useState)(!1),
      [o, s] = (0, z.useState)(0),
      [c, l] = (0, z.useState)(null),
      u = (0, z.useRef)(new Map()),
      d = (0, z.useRef)(null);
    return (
      (0, z.useEffect)(() => {
        if (!e || !t) {
          (r(void 0), a(!1), s(0), l(null));
          return;
        }
        let n = e.name || ``,
          i = e.uid;
        if (q(n)) {
          (r(t), a(!1), s(0), l(null));
          return;
        }
        if (!lt(n)) {
          (r(void 0), a(!1), s(0), l(null));
          return;
        }
        let o = u.current.get(i);
        if (o) {
          (r(o.blobUrl), a(!1), s(1));
          return;
        }
        ((d.current = i),
          a(!0),
          s(0),
          l(null),
          (async () => {
            try {
              let t = null,
                o = e.originFileObj;
              if (
                (o && o instanceof File
                  ? (t = o)
                  : e.url && (t = await dt(e.url, n)),
                !t)
              ) {
                a(!1);
                return;
              }
              if (d.current !== i) {
                a(!1);
                return;
              }
              st.onProgress((e) => {
                d.current === i && s(e.progress);
              });
              let { outputName: c, args: l } = ut(n),
                f = await st.convert(t, n, c, l);
              if (d.current !== i) {
                (URL.revokeObjectURL(f), a(!1));
                return;
              }
              (u.current.set(i, { blobUrl: f }), r(f), s(1));
            } catch (e) {
              let t = e instanceof Error ? e.message : `FFmpeg 转码失败`;
              (console.error(`FFmpeg 转码失败:`, e), r(void 0), s(0), l(t));
            } finally {
              d.current === i && a(!1);
            }
          })());
      }, [e, t]),
      (0, z.useEffect)(() => {
        let e = u.current;
        return () => {
          (e.forEach((e) => {
            URL.revokeObjectURL(e.blobUrl);
          }),
            e.clear(),
            st.removeProgress());
        };
      }, []),
      { convertedPreviewSrc: n, converting: i, progress: o, error: c }
    );
  };
v();
var pt = ({ docDetail: e, onFileChange: t }) => {
    let [n, r] = (0, z.useState)([]),
      [i, a] = (0, z.useState)(!1),
      [o, s] = (0, z.useState)(null),
      [c, l] = (0, z.useState)(``),
      [u, f] = (0, z.useState)(!1),
      [p, m] = (0, z.useState)(new Map()),
      h = (0, z.useRef)(new Map()),
      g = (0, z.useRef)(new Set()),
      _ = (0, z.useRef)(new Map()),
      v = (0, z.useRef)(0),
      y = (0, z.useRef)(0),
      b = (0, z.useRef)(null),
      x = (0, z.useRef)(new Set()),
      S = (0, z.useRef)(n);
    S.current = n;
    let C = (0, z.useRef)(p);
    C.current = p;
    let w = (0, z.useCallback)((e, t) => {
        m((n) => {
          let r = new Map(n);
          return (r.set(e, t), r);
        });
      }, []),
      T = (0, z.useCallback)(async () => {
        b.current && (await b.current);
        let e = S.current;
        if (!e.length) return (M.warning(`请先选择文件`), { success: !1 });
        let t = ++v.current,
          n = y.current,
          r;
        ((b.current = new Promise((e) => {
          r = e;
        })),
          a(!0));
        try {
          x.current.size > 0 &&
            (await Promise.all(
              Array.from(x.current).map(
                (e) =>
                  new Promise((t) => {
                    let n = () => {
                      x.current.has(e) ? setTimeout(n, 200) : t();
                    };
                    n();
                  }),
              ),
            ));
          let i = e.filter((e) => {
            if (!e.originFileObj) return !1;
            let t = C.current.get(e.uid);
            return !t || t.status === `pending` || t.status === `error`;
          });
          if (i.length === 0) {
            let t = e.filter((e) => e.originFileObj);
            if (
              t.every((e) => C.current.get(e.uid)?.status === `success`) &&
              t.length > 0
            ) {
              let e = t.map((e) => _.current.get(e.uid)).filter(Boolean);
              return (r(!0), { success: !0, ossResults: e });
            }
            return (M.warning(`请先选择文件`), r(!1), { success: !1 });
          }
          i.forEach((e) => {
            w(e.uid, { progress: 0, status: `uploading` });
          });
          let a = new Set();
          for (let e of i) {
            if (y.current !== n || v.current !== t)
              return (r(!1), { success: !1 });
            if (e.originFileObj)
              try {
                let n = await pe(e.originFileObj, {
                  onProgress: (n) => {
                    v.current === t &&
                      w(e.uid, { progress: n, status: `uploading` });
                  },
                });
                if (v.current !== t) return (r(!1), { success: !1 });
                (_.current.set(e.uid, n),
                  w(e.uid, { progress: 100, status: `success` }));
              } catch (n) {
                if (v.current !== t) return (r(!1), { success: !1 });
                (a.add(e.uid),
                  w(e.uid, {
                    progress: 0,
                    status: `error`,
                    errorMsg: n.message || `上传失败`,
                  }));
              }
          }
          if (v.current !== t) return (r(!1), { success: !1 });
          let o = e.filter((e) => e.originFileObj),
            s = o.map((e) => _.current.get(e.uid)).filter(Boolean);
          if (s.length === 0)
            return (
              M.error(`所有文件上传失败，请重试`),
              r(!1),
              { success: !1 }
            );
          if (a.size > 0) {
            let e = o
              .filter((e) => a.has(e.uid))
              .map((e) => e.name)
              .join(`、`);
            return (
              M.error(
                `以下 ${a.size} 个文件上传失败：${e}，请重试上传成功后再进入下一步`,
              ),
              r(!1),
              { success: !1 }
            );
          }
          return (
            M.success(`${s.length} 个文件上传成功`),
            r(!0),
            { success: !0, ossResults: s }
          );
        } catch (e) {
          return (
            console.error(`文件上传失败:`, e),
            M.error(`文件上传失败，请重试`),
            r(!1),
            { success: !1 }
          );
        } finally {
          (v.current === t && a(!1), (b.current = null));
        }
      }, [w]),
      E = (0, z.useCallback)(
        async (e) => {
          let t = S.current.find((t) => t.uid === e);
          if (!t?.originFileObj)
            return (M.error(`找不到原始文件`), { success: !1 });
          (w(e, { progress: 0, status: `uploading` }), x.current.add(e));
          try {
            let n = await pe(t.originFileObj, {
              onProgress: (t) => {
                w(e, { progress: t, status: `uploading` });
              },
            });
            return (
              _.current.set(e, n),
              w(e, { progress: 100, status: `success` }),
              M.success(`「${t.name}」重试上传成功`),
              { success: !0, ossResult: n }
            );
          } catch (n) {
            return (
              w(e, {
                progress: 0,
                status: `error`,
                errorMsg: n.message || `上传失败`,
              }),
              M.error(`「${t.name}」重试上传失败`),
              { success: !1 }
            );
          } finally {
            x.current.delete(e);
          }
        },
        [w],
      ),
      D = (0, z.useCallback)(
        (e) => {
          let n = e.fileList;
          if (n.length > 50) {
            M.warning(`单次最多上传 50 个文件，请分批上传`);
            return;
          }
          let i = [],
            a = [];
          for (let e of n) {
            if (e.originFileObj && e.status !== `removed`) {
              let t = Pe(e);
              t.length > 0 ? i.push(...t) : a.push(e);
              continue;
            }
            a.push(e);
          }
          if (i.length > 0) {
            (i.slice(0, 5).forEach((e) => {
              M.error({ content: e, key: e });
            }),
              i.length > 5 &&
                M.warning(
                  `还有 ${i.length - 5} 个文件校验失败，请检查后重新上传`,
                ),
              r(a),
              t?.(a.length > 0),
              !o && a.length > 0 && s(a[0]));
            return;
          }
          (r(n), t?.(n.length > 0), !o && n.length > 0 && s(n[0]));
        },
        [t, o],
      ),
      ee = (0, z.useCallback)(
        (e) => {
          let n = S.current.filter((t) => t.uid !== e.uid);
          return (
            r(n),
            h.current.delete(e.uid),
            g.current.delete(e.uid),
            _.current.delete(e.uid),
            t?.(n.length > 0),
            o?.uid === e.uid && s(null),
            !0
          );
        },
        [t, o],
      ),
      O = (0, z.useCallback)(() => !1, []),
      k = (0, z.useCallback)(() => {
        let e =
          i || x.current.size > 0
            ? `当前有文件正在上传中，清空将终止所有上传任务并清除 ${S.current.length} 个文件，确认继续吗？`
            : `确定要清空所有 ${S.current.length} 个已选文件吗？`;
        ne.confirm({
          title: `清空文件列表`,
          icon: (0, z.createElement)(d),
          content: e,
          okText: `确认清空`,
          cancelText: `取消`,
          onOk: () => {
            (y.current++,
              v.current++,
              (b.current = null),
              x.current.clear(),
              a(!1),
              r([]),
              m(new Map()),
              h.current.clear(),
              g.current.clear(),
              _.current.clear(),
              t?.(!1),
              s(null));
          },
        });
      }, [i, t]),
      A = (0, z.useCallback)((e) => {
        s(e);
      }, []),
      te = (0, z.useCallback)(() => {
        f(!0);
      }, []),
      j = (0, z.useCallback)(() => {
        f(!1);
      }, []);
    ((0, z.useEffect)(() => {
      let e = !1;
      return (
        (async () => {
          let i = n.filter((e) => e.originFileObj && !g.current.has(e.uid));
          if (i.length === 0) return;
          let a = new Set(h.current.values()),
            o = [...n],
            s = [];
          for (let t of i)
            if (!(!t.originFileObj || e)) {
              try {
                let e = await Ne(t.originFileObj);
                a.has(e)
                  ? (s.push(t.name), (o = o.filter((e) => e.uid !== t.uid)))
                  : (h.current.set(t.uid, e), a.add(e));
              } catch {
                console.warn(`文件 Hash 计算失败，跳过重复检测:`, t.name);
              }
              g.current.add(t.uid);
            }
          e ||
            s.length === 0 ||
            (M.warning({
              content:
                s.length === 1
                  ? `「${s[0]}」已在待处理列表中，已自动跳过`
                  : `${s.length} 个文件已在待处理列表中，已自动跳过`,
              key: `duplicate-file`,
            }),
            r(o),
            t?.(o.length > 0));
        })(),
        () => {
          e = !0;
        }
      );
    }, [n, t]),
      (0, z.useEffect)(() => {
        if (!e?.files?.length) return;
        let n = Fe(e);
        (r(n),
          t?.(n.length > 0),
          n.forEach((e) => {
            w(e.uid, { progress: 100, status: `success` });
          }),
          n.length > 0 && s(n[0]));
      }, [e, t, w]),
      (0, z.useEffect)(() => {
        if (!o?.originFileObj) {
          l(``);
          return;
        }
        let e = URL.createObjectURL(o.originFileObj);
        return (
          l(e),
          () => {
            URL.revokeObjectURL(e);
          }
        );
      }, [o]));
    let N = (0, z.useMemo)(() => Te.join(`,`), []);
    return {
      fileList: n,
      fileListWithInfo: (0, z.useMemo)(() => Ie(n), [n]),
      uploading: i,
      previewFile: o,
      previewSrc: o?.originFileObj ? c : o?.url,
      drawerOpen: u,
      uploadStatusMap: p,
      accept: N,
      beforeUpload: O,
      handleChange: D,
      handleRemove: ee,
      handleClearAll: k,
      handlePreviewFile: A,
      handleOpenDrawer: te,
      handleCloseDrawer: j,
      send: T,
      retryFile: E,
    };
  },
  mt = (0, z.forwardRef)((e, t) => {
    let {
        fileList: n,
        fileListWithInfo: r,
        uploading: i,
        previewFile: a,
        previewSrc: o,
        drawerOpen: s,
        uploadStatusMap: c,
        accept: l,
        beforeUpload: u,
        handleChange: d,
        handleRemove: f,
        handleClearAll: p,
        handlePreviewFile: m,
        handleOpenDrawer: h,
        handleCloseDrawer: g,
        send: _,
        retryFile: v,
      } = pt(e),
      {
        convertedPreviewSrc: y,
        converting: b,
        progress: x,
        error: S,
      } = ft(a, o),
      [C, w] = (0, z.useState)(``),
      [T, E] = (0, z.useState)(!1),
      D = (0, z.useCallback)(
        (e) => {
          (w(e.uid), E(!1), m(e));
        },
        [m],
      ),
      ee = (0, z.useCallback)(
        (e) => {
          e.target.closest(`[data-file-list="av"]`) || (w(``), E(!0), m(null));
        },
        [m],
      );
    (0, z.useEffect)(() => {
      if (!T) {
        if (r.length === 0) {
          w(``);
          return;
        }
        if (!r.some((e) => e.uid === C)) {
          let e = r[0];
          (w(e.uid), m(e));
        }
      }
    }, [r, C, m, T]);
    let O = (0, z.useMemo)(
      () => Array.from(c.values()).some((e) => e.status === `error`),
      [c],
    );
    return (
      (0, z.useImperativeHandle)(t, () => ({ send: _, hasFailed: O }), [_, O]),
      (0, J.jsxs)(`div`, {
        className: B[`step1-wrapper`],
        onClick: ee,
        children: [
          (0, J.jsx)(Ue, {
            fileList: n,
            accept: l,
            beforeUpload: u,
            handleChange: d,
            handleRemove: f,
            drawerOpen: s,
            handleOpenDrawer: h,
            handleCloseDrawer: g,
            children: (0, J.jsx)(Ve, {
              fileListWithInfo: r,
              uploadStatusMap: c,
              uploading: i,
              selectedFileUid: C,
              onSelectFile: D,
              handleClearAll: p,
              handlePreviewFile: m,
              handleRemove: f,
              retryFile: v,
            }),
          }),
          (0, J.jsx)(ze, {
            previewFile: a,
            previewSrc: o,
            convertedPreviewSrc: y,
            converting: b,
            progress: x,
            error: S,
          }),
        ],
      })
    );
  });
mt.displayName = `Step1`;
var ht = (0, z.memo)(mt),
  gt = {
    qa: {
      name: `问答模式`,
      description: `根据 Query 与候选文档的匹配度排序，关注答案准确性和事实一致性`,
    },
    similar: {
      name: `相似模式`,
      description: `根据 Query 与候选文档的语义相似度排序，关注语义相关性和内容覆盖度`,
    },
  },
  _t = [
    {
      code: `V1`,
      name: `平台存储`,
      description: `平台统一管理的异质向量存储引擎，内置容灾能力，免运维、高可用`,
    },
  ],
  vt = (function (e) {
    return ((e[(e.Smart = 0)] = `Smart`), e);
  })({}),
  Z = {
    "step2-wrapper": `_step2-wrapper_x7r2e_2`,
    title: `_title_x7r2e_9`,
    form: `_form_x7r2e_15`,
    "section-title": `_section-title_x7r2e_18`,
    required: `_required_x7r2e_27`,
    "info-icon": `_info-icon_x7r2e_30`,
    "strategy-section": `_strategy-section_x7r2e_35`,
    "strategy-list": `_strategy-list_x7r2e_38`,
    "strategy-card": `_strategy-card_x7r2e_42`,
    "strategy-card-active": `_strategy-card-active_x7r2e_55`,
    "strategy-header": `_strategy-header_x7r2e_59`,
    "strategy-icon": `_strategy-icon_x7r2e_65`,
    "strategy-name": `_strategy-name_x7r2e_69`,
    "strategy-desc": `_strategy-desc_x7r2e_74`,
    "strategy-scene": `_strategy-scene_x7r2e_80`,
    "strategy-check": `_strategy-check_x7r2e_83`,
    "param-section": `_param-section_x7r2e_90`,
    "slider-wrapper": `_slider-wrapper_x7r2e_93`,
    "slider-col": `_slider-col_x7r2e_98`,
    "slider-input-col": `_slider-input-col_x7r2e_109`,
    "param-desc": `_param-desc_x7r2e_113`,
    "model-section": `_model-section_x7r2e_117`,
    "model-select": `_model-select_x7r2e_120`,
    "mode-section": `_mode-section_x7r2e_123`,
    "mode-list": `_mode-list_x7r2e_126`,
    "mode-card": `_mode-card_x7r2e_130`,
    "mode-card-active": `_mode-card-active_x7r2e_142`,
    "mode-header": `_mode-header_x7r2e_146`,
    "mode-name": `_mode-name_x7r2e_152`,
    "mode-desc": `_mode-desc_x7r2e_157`,
    "mode-check": `_mode-check_x7r2e_162`,
    "mode-check-active": `_mode-check-active_x7r2e_167`,
    "storage-section": `_storage-section_x7r2e_170`,
    "storage-list": `_storage-list_x7r2e_173`,
    "storage-card": `_storage-card_x7r2e_177`,
    "storage-card-active": `_storage-card-active_x7r2e_190`,
    "storage-header": `_storage-header_x7r2e_194`,
    "storage-name": `_storage-name_x7r2e_200`,
    "storage-desc": `_storage-desc_x7r2e_205`,
    "storage-check": `_storage-check_x7r2e_210`,
  };
v();
var yt = (0, z.memo)(({ segmentType: e, handleSegmentTypeChange: t }) =>
  (0, J.jsxs)(`div`, {
    className: Z[`strategy-section`],
    children: [
      (0, J.jsxs)(p.Title, {
        level: 5,
        className: Z[`section-title`],
        children: [
          `切片方式 `,
          (0, J.jsx)(`span`, { className: Z.required, children: `*` }),
        ],
      }),
      (0, J.jsxs)(`div`, {
        className: Z[`strategy-list`],
        children: [
          (0, J.jsxs)(`div`, {
            className: `${Z[`strategy-card`]} ${e === vt.Smart ? Z[`strategy-card-active`] : ``}`,
            onClick: () => t(vt.Smart),
            children: [
              (0, J.jsx)(`div`, {
                className: Z[`strategy-header`],
                children: (0, J.jsx)(`span`, {
                  className: Z[`strategy-name`],
                  children: `智能切分`,
                }),
              }),
              (0, J.jsx)(p.Text, {
                type: `secondary`,
                className: Z[`strategy-desc`],
                children: `在通用文档上的较优 chunk 切分方法，经过评测可在多数文档上获得较佳的检索效果`,
              }),
              e === vt.Smart &&
                (0, J.jsx)(`div`, {
                  className: Z[`strategy-check`],
                  children: (0, J.jsx)(te, {}),
                }),
            ],
          }),
          (0, J.jsx)(F.Item, {
            name: `segmentType`,
            initialValue: vt.Smart,
            hidden: !0,
            children: (0, J.jsx)(i, {}),
          }),
        ],
      }),
    ],
  }),
);
yt.displayName = `StrategySection`;
var bt = (0, z.memo)(({ chunkSize: e, handleChunkSizeChange: t }) => {
  let n = F.useFormInstance();
  return (0, J.jsxs)(`div`, {
    className: Z[`param-section`],
    children: [
      (0, J.jsxs)(p.Title, {
        level: 5,
        className: Z[`section-title`],
        children: [
          `最大分段长度 `,
          (0, J.jsx)(`span`, { className: Z.required, children: `*` }),
          (0, J.jsx)(h, {
            title: `当文本切片字符数超过此值时将被强制截断`,
            children: (0, J.jsx)(s, { className: Z[`info-icon`] }),
          }),
        ],
      }),
      (0, J.jsx)(F.Item, {
        name: `chunkSize`,
        initialValue: 512,
        rules: [
          { required: !0, message: `请输入最大分段长度` },
          {
            validator: (e, t) => {
              if (t == null || t === ``) return Promise.resolve();
              let n = Number(t);
              return isNaN(n) || n < 10 || n > 6e3
                ? Promise.reject(Error(`分段长度区间10~6000`))
                : Promise.resolve();
            },
          },
        ],
        children: (0, J.jsxs)(`div`, {
          className: Z[`slider-wrapper`],
          children: [
            (0, J.jsx)(`div`, {
              className: Z[`slider-col`],
              children: (0, J.jsx)(g, {
                className: `av-slider`,
                min: 10,
                max: 6e3,
                value: e ?? 512,
                onChange: (e) => t(e),
              }),
            }),
            (0, J.jsx)(`div`, {
              className: Z[`slider-input-col`],
              children: (0, J.jsx)(f, {
                min: 10,
                max: 6e3,
                value: e ?? 512,
                onChange: t,
                onBlur: () => {
                  let e = n.getFieldValue(`chunkSize`),
                    t = Number(e);
                  e != null &&
                    e !== `` &&
                    !isNaN(t) &&
                    n.setFieldsValue({
                      chunkSize: Math.max(10, Math.min(6e3, t)),
                    });
                },
              }),
            }),
          ],
        }),
      }),
    ],
  });
});
bt.displayName = `ChunkSizeSection`;
var xt = (0, z.memo)(
  ({
    embeddingModel: e,
    embeddingModels: t,
    rerankModel: n,
    rerankModels: r,
  }) =>
    (0, J.jsxs)(J.Fragment, {
      children: [
        (0, J.jsxs)(`div`, {
          className: Z[`model-section`],
          children: [
            (0, J.jsxs)(p.Title, {
              level: 5,
              className: Z[`section-title`],
              children: [
                `向量模型 `,
                (0, J.jsx)(`span`, { className: Z.required, children: `*` }),
              ],
            }),
            (0, J.jsx)(F.Item, {
              name: `embeddingModel`,
              rules: [{ required: !0, message: `请选择向量模型` }],
              children: (0, J.jsx)(u, {
                disabled: !0,
                className: Z[`model-select`],
                children: t.map((e) =>
                  (0, J.jsx)(u.Option, { value: e, children: e }, e),
                ),
              }),
            }),
          ],
        }),
        (0, J.jsxs)(`div`, {
          className: Z[`model-section`],
          children: [
            (0, J.jsxs)(p.Title, {
              level: 5,
              className: Z[`section-title`],
              children: [
                `排序模型 `,
                (0, J.jsx)(`span`, { className: Z.required, children: `*` }),
              ],
            }),
            (0, J.jsx)(F.Item, {
              name: `rerankModel`,
              rules: [{ required: !0, message: `请选择排序模型` }],
              children: (0, J.jsx)(u, {
                disabled: !0,
                className: Z[`model-select`],
                children: r.map((e) =>
                  (0, J.jsx)(u.Option, { value: e, children: e }, e),
                ),
              }),
            }),
          ],
        }),
      ],
    }),
);
xt.displayName = `ModelSection`;
var St = (0, z.memo)(({ sortMode: e, rerankModes: t, handleModeChange: n }) =>
  (0, J.jsxs)(`div`, {
    className: Z[`mode-section`],
    children: [
      (0, J.jsx)(p.Title, {
        level: 5,
        className: Z[`section-title`],
        children: `排序模型模式`,
      }),
      (0, J.jsxs)(`div`, {
        className: Z[`mode-list`],
        children: [
          t.map((t) => {
            let r = gt[t],
              i = r?.name ?? t;
            return (0, J.jsxs)(
              `div`,
              {
                className: `${Z[`mode-card`]} ${e === t ? Z[`mode-card-active`] : ``}`,
                onClick: () => n(t),
                children: [
                  (0, J.jsxs)(`div`, {
                    className: Z[`mode-header`],
                    children: [
                      (0, J.jsx)(`span`, {
                        className: Z[`mode-name`],
                        children: i,
                      }),
                      (0, J.jsx)(`div`, {
                        className: `${Z[`mode-check`]} ${e === t ? Z[`mode-check-active`] : ``}`,
                        children: (0, J.jsx)(te, {}),
                      }),
                    ],
                  }),
                  r?.description
                    ? (0, J.jsx)(p.Text, {
                        type: `secondary`,
                        className: Z[`mode-desc`],
                        children: r.description,
                      })
                    : null,
                ],
              },
              t,
            );
          }),
          (0, J.jsx)(F.Item, {
            name: `rerankMode`,
            initialValue: `similar`,
            hidden: !0,
            children: (0, J.jsx)(i, {}),
          }),
        ],
      }),
    ],
  }),
);
St.displayName = `ModeSection`;
var Ct = (0, z.memo)(({ vectorStorage: e, handleStorageChange: t }) =>
  (0, J.jsxs)(`div`, {
    className: Z[`storage-section`],
    children: [
      (0, J.jsxs)(p.Title, {
        level: 5,
        className: Z[`section-title`],
        children: [
          `向量存储 `,
          (0, J.jsx)(`span`, { className: Z.required, children: `*` }),
        ],
      }),
      (0, J.jsxs)(`div`, {
        className: Z[`storage-list`],
        children: [
          _t.map((n) =>
            (0, J.jsxs)(
              `div`,
              {
                className: `${Z[`storage-card`]} ${e === n.code ? Z[`storage-card-active`] : ``}`,
                onClick: () => t(n.code),
                children: [
                  (0, J.jsx)(`div`, {
                    className: Z[`storage-header`],
                    children: (0, J.jsx)(`span`, {
                      className: Z[`storage-name`],
                      children: n.name,
                    }),
                  }),
                  (0, J.jsx)(p.Text, {
                    type: `secondary`,
                    className: Z[`storage-desc`],
                    children: n.description,
                  }),
                  e === n.code &&
                    (0, J.jsx)(`div`, {
                      className: Z[`storage-check`],
                      children: (0, J.jsx)(te, {}),
                    }),
                ],
              },
              n.code,
            ),
          ),
          (0, J.jsx)(F.Item, {
            name: `vectorStorage`,
            initialValue: `V1`,
            hidden: !0,
            children: (0, J.jsx)(i, {}),
          }),
        ],
      }),
    ],
  }),
);
((Ct.displayName = `StorageSection`), v());
var wt = ({ docDetail: e, baseId: t }) => {
  let [n] = F.useForm(),
    [r, i] = (0, z.useState)(!1),
    a = F.useWatch(`segmentType`, n) ?? vt.Smart,
    o = F.useWatch(`chunkSize`, n),
    s = F.useWatch(`vectorStorage`, n),
    c = F.useWatch(`embeddingModel`, n),
    l = F.useWatch(`rerankModel`, n),
    u = F.useWatch(`rerankMode`, n),
    d = I((e) => e.config),
    f = I((e) => e.fetchConfig),
    p = (0, z.useMemo)(() => d?.embeddingModels ?? [], [d?.embeddingModels]),
    m = (0, z.useMemo)(() => d?.rerankModels ?? [], [d?.rerankModels]),
    h = (0, z.useMemo)(() => d?.rerankModes ?? [], [d?.rerankModes]);
  return (
    (0, z.useEffect)(() => {
      f();
    }, [f]),
    (0, z.useEffect)(() => {
      let r = t ?? e?.baseId;
      if (!r) return;
      let a = !1;
      return (
        (async () => {
          i(!0);
          try {
            let e = await le(r);
            if (a) return;
            if (e?.code === 0 && e.data) {
              let t = {};
              (e.data.embeddingModelName &&
                (t.embeddingModel = e.data.embeddingModelName),
                e.data.rerankModelName &&
                  (t.rerankModel = e.data.rerankModelName),
                Object.keys(t).length && n.setFieldsValue(t));
            }
          } catch (e) {
            console.warn(`获取知识库详情失败:`, e);
          } finally {
            a || i(!1);
          }
        })(),
        () => {
          a = !0;
        }
      );
    }, [t, e?.baseId, n]),
    (0, z.useEffect)(() => {
      if (!d) return;
      let e = {};
      (!n.getFieldValue(`embeddingModel`) && p[0] && (e.embeddingModel = p[0]),
        !n.getFieldValue(`rerankModel`) && m[0] && (e.rerankModel = m[0]),
        !n.getFieldValue(`rerankMode`) && h[0] && (e.rerankMode = h[0]),
        Object.keys(e).length && n.setFieldsValue(e));
    }, [p, n, d, m, h]),
    (0, z.useEffect)(() => {
      e?.config && n.setFieldsValue(e.config);
    }, [e, n]),
    {
      form: n,
      segmentType: a,
      chunkSize: o,
      vectorStorage: s,
      embeddingModel: c,
      rerankModel: l,
      sortMode: u,
      embeddingModels: p,
      rerankModels: m,
      rerankModes: h,
      loadingBaseDetail: r,
      handleValidate: (0, z.useCallback)(async () => {
        try {
          return (await n.validateFields(), { success: !0 });
        } catch {
          return (M.warning(`请填写完整`), { success: !1 });
        }
      }, [n]),
      handleValidateNext: (0, z.useCallback)(async () => {
        try {
          let e = await n.validateFields();
          return {
            success: !0,
            values: {
              segmentType: e.segmentType ?? vt.Smart,
              chunkSize: e.chunkSize,
              rerankMode: e.rerankMode,
            },
          };
        } catch {
          return (M.warning(`请填写完整`), { success: !1 });
        }
      }, [n]),
      handleStorageChange: (0, z.useCallback)(
        (e) => {
          n.setFieldsValue({ vectorStorage: e });
        },
        [n],
      ),
      handleModeChange: (0, z.useCallback)(
        (e) => {
          n.setFieldsValue({ rerankMode: e });
        },
        [n],
      ),
      handleSegmentTypeChange: (0, z.useCallback)(
        (e) => {
          n.setFieldsValue({ segmentType: e });
        },
        [n],
      ),
      handleChunkSizeChange: (0, z.useCallback)(
        (e) => {
          let t = typeof e == `number` && !isNaN(e) ? e : void 0;
          n.setFieldsValue({ chunkSize: t });
        },
        [n],
      ),
    }
  );
};
v();
var Tt = (0, z.forwardRef)(({ docDetail: e, baseId: t }, n) => {
  let {
    form: r,
    segmentType: i,
    chunkSize: a,
    vectorStorage: o,
    embeddingModel: s,
    rerankModel: c,
    sortMode: l,
    embeddingModels: u,
    rerankModels: d,
    rerankModes: f,
    handleValidate: p,
    handleValidateNext: m,
    handleStorageChange: h,
    handleModeChange: g,
    handleSegmentTypeChange: _,
    handleChunkSizeChange: v,
  } = wt({ docDetail: e, baseId: t });
  return (
    (0, z.useImperativeHandle)(n, () => ({ send: p, sendNext: m })),
    (0, J.jsx)(`div`, {
      className: Z[`step2-wrapper`],
      children: (0, J.jsxs)(F, {
        form: r,
        layout: `vertical`,
        className: Z.form,
        children: [
          (0, J.jsx)(yt, { segmentType: i, handleSegmentTypeChange: _ }),
          (0, J.jsx)(bt, { chunkSize: a, handleChunkSizeChange: v }),
          (0, J.jsx)(xt, {
            embeddingModel: s,
            embeddingModels: u,
            rerankModel: c,
            rerankModels: d,
          }),
          (0, J.jsx)(St, { sortMode: l, rerankModes: f, handleModeChange: g }),
          (0, J.jsx)(Ct, { vectorStorage: o, handleStorageChange: h }),
        ],
      }),
    })
  );
});
Tt.displayName = `Step2`;
var Et = (0, z.memo)(Tt),
  Q = {
    "step3-wrapper": `_step3-wrapper_jh178_2`,
    "file-review-section": `_file-review-section_jh178_10`,
    "file-info-bar": `_file-info-bar_jh178_13`,
    "file-info-left": `_file-info-left_jh178_19`,
    "file-name": `_file-name_jh178_24`,
    "file-info-right": `_file-info-right_jh178_27`,
    "filter-bar": `_filter-bar_jh178_32`,
    "filter-bar-left": `_filter-bar-left_jh178_42`,
    "filter-bar-left-right": `_filter-bar-left-right_jh178_48`,
    "filter-bar-right": `_filter-bar-right_jh178_53`,
    "filter-select": `_filter-select_jh178_59`,
    "btn-ai-diagnosis": `_btn-ai-diagnosis_jh178_62`,
    "keyword-input": `_keyword-input_jh178_71`,
    "file-select-wide": `_file-select-wide_jh178_74`,
    "loading-block-large": `_loading-block-large_jh178_77`,
    "loading-block-small": `_loading-block-small_jh178_80`,
    sentinel: `_sentinel_jh178_83`,
    "view-tabs": `_view-tabs_jh178_86`,
    "view-tab": `_view-tab_jh178_86`,
    "view-tab-active": `_view-tab-active_jh178_101`,
    "segment-list": `_segment-list_jh178_106`,
    "segment-card": `_segment-card_jh178_111`,
    "segment-card-body": `_segment-card-body_jh178_126`,
    "segment-thumbnail": `_segment-thumbnail_jh178_131`,
    "segment-thumbnail-mask": `_segment-thumbnail-mask_jh178_146`,
    "segment-thumbnail-placeholder": `_segment-thumbnail-placeholder_jh178_157`,
    "segment-content": `_segment-content_jh178_169`,
    "segment-header": `_segment-header_jh178_173`,
    "segment-header-left": `_segment-header-left_jh178_179`,
    "segment-header-right": `_segment-header-right_jh178_184`,
    "segment-status-hover": `_segment-status-hover_jh178_189`,
    "segment-index": `_segment-index_jh178_200`,
    "segment-char-count": `_segment-char-count_jh178_206`,
    "segment-preview": `_segment-preview_jh178_210`,
    "segment-expand-btn": `_segment-expand-btn_jh178_216`,
    "segment-card-footer": `_segment-card-footer_jh178_224`,
    "footer-file-icon": `_footer-file-icon_jh178_230`,
    "segment-file-name": `_segment-file-name_jh178_235`,
    "sensitive-word": `_sensitive-word_jh178_239`,
    "transcript-view": `_transcript-view_jh178_246`,
    "transcript-block": `_transcript-block_jh178_251`,
    "transcript-segment-label": `_transcript-segment-label_jh178_258`,
    "transcript-text": `_transcript-text_jh178_267`,
    "keyframe-view": `_keyframe-view_jh178_275`,
    "keyframe-card": `_keyframe-card_jh178_280`,
    "keyframe-image-placeholder": `_keyframe-image-placeholder_jh178_291`,
    "keyframe-timestamp": `_keyframe-timestamp_jh178_302`,
    "keyframe-info": `_keyframe-info_jh178_313`,
    "keyframe-title": `_keyframe-title_jh178_319`,
    "keyframe-desc": `_keyframe-desc_jh178_322`,
    "sensitive-modal-body": `_sensitive-modal-body_jh178_326`,
    "sensitive-file-info": `_sensitive-file-info_jh178_329`,
    "sensitive-warning": `_sensitive-warning_jh178_332`,
    "sensitive-warning-icon": `_sensitive-warning-icon_jh178_342`,
    "sensitive-count": `_sensitive-count_jh178_347`,
    "sensitive-table": `_sensitive-table_jh178_351`,
    "sensitive-pagination": `_sensitive-pagination_jh178_354`,
    "sensitive-footer": `_sensitive-footer_jh178_360`,
    "position-link": `_position-link_jh178_365`,
    "detail-modal-body": `_detail-modal-body_jh178_373`,
    "detail-header": `_detail-header_jh178_376`,
    "detail-header-left": `_detail-header-left_jh178_384`,
    "detail-index": `_detail-index_jh178_389`,
    "detail-char-count": `_detail-char-count_jh178_395`,
    "detail-header-right": `_detail-header-right_jh178_399`,
    "detail-content": `_detail-content_jh178_404`,
    "detail-content-editing": `_detail-content-editing_jh178_413`,
    "detail-edit-icon": `_detail-edit-icon_jh178_419`,
    "detail-media": `_detail-media_jh178_428`,
    "detail-media-section": `_detail-media-section_jh178_434`,
    "detail-media-section-title": `_detail-media-section-title_jh178_439`,
    "detail-video-grid": `_detail-video-grid_jh178_444`,
    "detail-video-item": `_detail-video-item_jh178_449`,
    "detail-video-thumb": `_detail-video-thumb_jh178_462`,
    "detail-video-mask": `_detail-video-mask_jh178_467`,
    "detail-video-index": `_detail-video-index_jh178_478`,
    "detail-audio-list": `_detail-audio-list_jh178_488`,
    "detail-audio-item": `_detail-audio-item_jh178_493`,
    "detail-audio-item-active": `_detail-audio-item-active_jh178_502`,
    "detail-audio-play": `_detail-audio-play_jh178_505`,
    "detail-audio-index": `_detail-audio-index_jh178_527`,
    "detail-image-grid": `_detail-image-grid_jh178_534`,
    "detail-media-image": `_detail-media-image_jh178_539`,
    "detail-text": `_detail-text_jh178_545`,
    "detail-textarea": `_detail-textarea_jh178_552`,
    "detail-footer": `_detail-footer_jh178_561`,
    "detail-footer-left": `_detail-footer-left_jh178_568`,
    "detail-footer-right": `_detail-footer-right_jh178_573`,
    "video-tooltip": `_video-tooltip_jh178_577`,
    "video-tooltip-text": `_video-tooltip-text_jh178_581`,
    "video-tooltip-thumb": `_video-tooltip-thumb_jh178_584`,
    "video-tooltip-mask": `_video-tooltip-mask_jh178_597`,
    "video-tooltip-duration": `_video-tooltip-duration_jh178_608`,
    "audio-tooltip": `_audio-tooltip_jh178_626`,
    "audio-tooltip-title": `_audio-tooltip-title_jh178_630`,
    "audio-tooltip-list": `_audio-tooltip-list_jh178_636`,
    "audio-tooltip-item": `_audio-tooltip-item_jh178_641`,
    "audio-tooltip-item-active": `_audio-tooltip-item-active_jh178_653`,
    "audio-tooltip-icon": `_audio-tooltip-icon_jh178_657`,
    "audio-tooltip-play": `_audio-tooltip-play_jh178_669`,
    "audio-tooltip-progress": `_audio-tooltip-progress_jh178_689`,
    "audio-tooltip-range": `_audio-tooltip-range_jh178_695`,
    "audio-tooltip-time": `_audio-tooltip-time_jh178_734`,
    "audio-tooltip-time-sep": `_audio-tooltip-time-sep_jh178_746`,
    "audio-tooltip-volume-wrap": `_audio-tooltip-volume-wrap_jh178_750`,
    "audio-tooltip-volume-icon": `_audio-tooltip-volume-icon_jh178_757`,
    "audio-tooltip-range-volume": `_audio-tooltip-range-volume_jh178_766`,
    "video-preview-modal": `_video-preview-modal_jh178_801`,
    "video-preview-wrapper": `_video-preview-wrapper_jh178_804`,
    "video-player-container": `_video-player-container_jh178_811`,
    "video-player-info": `_video-player-info_jh178_820`,
    "video-arrow": `_video-arrow_jh178_826`,
    "video-arrow-left": `_video-arrow-left_jh178_846`,
    "video-arrow-right": `_video-arrow-right_jh178_849`,
  },
  Dt = (e) => `#${String(e + 1).padStart(3, `0`)}`,
  Ot = (e, t, n = 250) => (t || e.length <= n ? e : `${e.slice(0, n)}...`),
  kt = (e) =>
    e
      ? {
          导入索引失败: `导入索引失败，注意：音视频文件如果只有音乐声或自然环境声（如喇叭声、钟声、雷声等），文档不支持识别解析为文本。`,
          文档为空: `文档为空异常，没有文字的空白文档或者没有人声的空白音视频文件，不支持解析为文本。`,
        }[e.trim()] || e
      : ``,
  At = (e, t, n) => {
    if (!t.length) return e;
    let r = t.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`)),
      i = RegExp(`(${r.join(`|`)})`, `gi`);
    return e
      .split(i)
      .map((e, r) =>
        t.some((t) => t.toLowerCase() === e.toLowerCase())
          ? (0, J.jsx)(`span`, { className: n, children: e }, `${e}-${r}`)
          : e,
      );
  };
v();
var jt = (0, z.memo)(
  ({
    open: e,
    detailSegment: t,
    detailIndex: n,
    totalCount: r,
    editing: a,
    editingContent: s,
    saving: c,
    readonly: l = !1,
    handleCloseDetail: u,
    handleStartEdit: d,
    handleCancelEdit: f,
    setEditingContent: p,
    handleToggleStatus: h,
    handleStepDetail: g,
    handleSaveEdit: _,
  }) => {
    let v = (0, z.useMemo)(() => {
      if (!t) return null;
      let e = t.status === H.Enabled;
      return (0, J.jsx)(o, {
        status: e ? `success` : `default`,
        text: e ? `已启用` : `已禁用`,
      });
    }, [t]);
    return (0, J.jsx)(ne, {
      title: null,
      open: e,
      onCancel: u,
      width: 680,
      footer: null,
      children:
        t &&
        (0, J.jsxs)(`div`, {
          className: Q[`detail-modal-body`],
          children: [
            (0, J.jsxs)(`div`, {
              className: Q[`detail-header`],
              children: [
                (0, J.jsxs)(`div`, {
                  className: Q[`detail-header-left`],
                  children: [
                    (0, J.jsx)(`span`, {
                      className: Q[`detail-index`],
                      children: Dt(t.index),
                    }),
                    (0, J.jsxs)(`span`, {
                      className: Q[`detail-char-count`],
                      children: [t.charCount, `字符`],
                    }),
                  ],
                }),
                (0, J.jsx)(`div`, {
                  className: Q[`detail-header-right`],
                  children:
                    !a &&
                    !l &&
                    (0, J.jsx)(b, {
                      className: Q[`detail-edit-icon`],
                      onClick: d,
                    }),
                }),
              ],
            }),
            (0, J.jsx)(`div`, {
              className: `${Q[`detail-content`]} ${a ? Q[`detail-content-editing`] : ``}`,
              children: a
                ? (0, J.jsx)(i.TextArea, {
                    value: s,
                    onChange: (e) => p(e.target.value),
                    autoSize: { minRows: 8, maxRows: 20 },
                    className: Q[`detail-textarea`],
                  })
                : (0, J.jsx)(`div`, {
                    className: Q[`detail-text`],
                    children: t.content || `该切片暂无内容`,
                  }),
            }),
            (0, J.jsxs)(`div`, {
              className: Q[`detail-footer`],
              children: [
                (0, J.jsxs)(`div`, {
                  className: Q[`detail-footer-left`],
                  children: [
                    v,
                    (0, J.jsx)(P, {
                      checked: t.status === H.Enabled,
                      disabled: a || l,
                      onChange: () => h(t),
                    }),
                  ],
                }),
                (0, J.jsx)(`div`, {
                  className: Q[`detail-footer-right`],
                  children: (0, J.jsxs)(m, {
                    children: [
                      n > 0 &&
                        !a &&
                        (0, J.jsx)(x, {
                          onClick: () => g(-1),
                          children: `上一片段`,
                        }),
                      n < r - 1 &&
                        !a &&
                        (0, J.jsx)(x, {
                          onClick: () => g(1),
                          children: `下一片段`,
                        }),
                      a
                        ? (0, J.jsxs)(J.Fragment, {
                            children: [
                              (0, J.jsx)(x, { onClick: f, children: `取消` }),
                              (0, J.jsx)(x, {
                                type: `primary`,
                                loading: c,
                                onClick: _,
                                children: `保存`,
                              }),
                            ],
                          })
                        : (0, J.jsx)(x, {
                            type: `primary`,
                            onClick: u,
                            children: `关闭`,
                          }),
                    ],
                  }),
                }),
              ],
            }),
          ],
        }),
    });
  },
);
v();
var Mt = (0, z.memo)(
    ({
      activeFileDocId: e,
      fileSelectOptions: t,
      statusFilter: n,
      keyword: r,
      totalSegments: a,
      diagnosing: o,
      disabled: s,
      handleChangeFile: c,
      setStatusFilter: l,
      setKeyword: d,
      onAiDiagnosis: f,
    }) =>
      (0, J.jsxs)(`div`, {
        className: Q[`filter-bar`],
        children: [
          (0, J.jsxs)(`div`, {
            className: Q[`filter-bar-left`],
            children: [
              (0, J.jsx)(u, {
                value: e,
                onChange: c,
                className: Q[`filter-select`],
                options: t,
                popupMatchSelectWidth: !1,
                rootClassName: Q[`file-select-wide`],
                placeholder: `选择文件`,
              }),
              (0, J.jsxs)(`div`, {
                className: Q[`filter-bar-left-right`],
                children: [
                  (0, J.jsx)(u, {
                    value: n,
                    onChange: l,
                    className: Q[`filter-select`],
                    options: [
                      { value: `all`, label: `全部` },
                      { value: H.Enabled, label: `已启用` },
                      { value: H.Disabled, label: `已禁用` },
                    ],
                  }),
                  (0, J.jsx)(i, {
                    placeholder: `关键词搜索`,
                    prefix: (0, J.jsx)(D, {}),
                    value: r,
                    onChange: (e) => d(e.target.value),
                    className: Q[`keyword-input`],
                    allowClear: !0,
                  }),
                ],
              }),
            ],
          }),
          (0, J.jsxs)(`div`, {
            className: Q[`filter-bar-right`],
            children: [
              (0, J.jsx)(h, {
                title: `对当前文件所有切片进行敏感词检测`,
                children: (0, J.jsx)(x, {
                  loading: o,
                  disabled: s,
                  className: Q[`btn-ai-diagnosis`],
                  onClick: f,
                  children: `AI诊断`,
                }),
              }),
              (0, J.jsxs)(p.Text, {
                type: `secondary`,
                children: [`共 `, a, ` 个切片`],
              }),
            ],
          }),
        ],
      }),
  ),
  Nt = (e) => {
    if (!e) return {};
    try {
      return JSON.parse(e) ?? {};
    } catch {
      return {};
    }
  },
  Pt = (e, t) => {
    let n = Nt(e.urls);
    return {
      id: String(e.docId ?? t) + `_` + String(e.segmentId),
      index: e.segmentOrder,
      segmentId: e.segmentId,
      docId: String(e.docId ?? t),
      content: e.content ?? ``,
      charCount: e.size ?? (e.content ?? ``).length,
      status: e.enable === 1 ? H.Enabled : H.Disabled,
      videoUrls: n.videoUrl ?? [],
      audioUrls: n.audioUrl ?? [],
      imageUrls: n.imageUrl ?? [],
    };
  };
v();
var Ft = 10,
  It = `__all__`,
  Lt = ({
    docId: e,
    docDetail: t,
    docIdList: n,
    getInfo: r,
    setStopParentPolling: i,
    onReadyStateChange: a,
  }) => {
    let [o, s] = (0, z.useState)(n?.[0]?.docId ?? e ?? ``),
      [c, l] = (0, z.useState)(`all`),
      [u, d] = (0, z.useState)(``),
      [f, p] = (0, z.useState)([]),
      [m, h] = (0, z.useState)(!1),
      g = (0, z.useRef)({ position: -1, stop: !1, loading: !1 }),
      _ = (0, z.useRef)(null),
      v = (0, z.useRef)({}),
      [y, b] = (0, z.useState)({}),
      x = (0, z.useRef)(null),
      S = (0, z.useRef)(!1),
      C = (0, z.useRef)(),
      w = (0, z.useRef)([]),
      [T, E] = (0, z.useState)(0),
      D = (0, z.useRef)(0),
      [ee, O] = (0, z.useState)(!1),
      [k, A] = (0, z.useState)([]),
      [te, j] = (0, z.useState)(!1),
      [N, re] = (0, z.useState)(-1),
      [ie, P] = (0, z.useState)(!1),
      [F, ce] = (0, z.useState)(``),
      [le, ue] = (0, z.useState)(!1),
      pe = (0, z.useRef)(null);
    (0, z.useEffect)(() => {
      n?.length && o !== It && (n.some((e) => e.docId === o) || s(n[0].docId));
    }, [n, o]);
    let I = o === It,
      me = (0, z.useMemo)(() => {
        if (!I || !n?.length) return !1;
        let e = n.every((e) => {
          let t = y[e.docId];
          return t ? t.step != null && (t.docStatus === 2 || t.step === 7) : !1;
        });
        return ((S.current = e), e);
      }, [I, n, y]),
      L = (0, z.useMemo)(() => {
        if (I) return !me;
        let e = t?.step;
        return e == null ? !0 : [1, 2].includes(e) && t?.docStatus !== 2;
      }, [t?.step, t?.docStatus, I, me]),
      R = (0, z.useCallback)(async () => {
        if (g.current.loading || !o) return;
        let e = ++D.current;
        if (I) {
          if (!S.current) return;
          ((g.current.loading = !0), h(!0));
          try {
            let t = !1;
            for (let r of n || []) {
              let n = v.current[r.docId];
              if (!n || n.stop) continue;
              let i = await se({
                docId: r.docId,
                position: n.position,
                size: Ft,
              });
              if (D.current !== e) return;
              if (i.code === 0) {
                let e = i.data || [];
                n.stop = e.length < Ft;
                let a = e[e.length - 1];
                (a && (n.position = a.segmentOrder + 1),
                  n.stop || (t = !0),
                  p((t) => {
                    let n = new Set(t.map((e) => e.id)),
                      i = e
                        .map((e) => Pt(e, r.docId))
                        .filter((e) => !n.has(e.id));
                    return i.length === 0 ? t : [...t, ...i];
                  }));
              }
            }
            g.current.stop = !t;
          } finally {
            ((g.current.loading = !1), h(!1));
          }
          return;
        }
        if (!(g.current.stop || L)) {
          ((g.current.loading = !0), h(!0));
          try {
            let t = await se({
              docId: o,
              position: g.current.position,
              size: Ft,
            });
            if (D.current !== e) return;
            if (t.code === 0) {
              let e = t.data || [];
              g.current.stop = e.length < Ft;
              let n = e[e.length - 1];
              (n && (g.current.position = n.segmentOrder + 1),
                p((t) => {
                  let n = new Set(t.map((e) => e.id)),
                    r = e.map((e) => Pt(e, o)).filter((e) => !n.has(e.id));
                  return r.length === 0 ? t : [...t, ...r];
                }));
            }
          } finally {
            ((g.current.loading = !1), h(!1));
          }
        }
      }, [o, me, L, n, I, T]);
    ((0, z.useEffect)(() => {
      C.current = R;
    }, [R]),
      (0, z.useEffect)(() => {
        ((g.current = { position: -1, stop: !1, loading: !1 }),
          p([]),
          o &&
            (I &&
              ((v.current = {}),
              (n || []).forEach((e) => {
                v.current[e.docId] = { position: -1, stop: !1, loading: !1 };
              })),
            L || R()));
      }, [o, L, n, I, R, T]),
      (0, z.useEffect)(
        () => (
          I && i?.(!0),
          () => {
            i?.(!1);
          }
        ),
        [I, i],
      ));
    let he = (0, z.useMemo)(
      () =>
        I
          ? n?.length
            ? n.some((e) => {
                let t = y[e.docId];
                return t
                  ? t.docStatus === 2 && [3, 6].includes(t.step ?? -1)
                  : !1;
              })
            : !1
          : t?.docStatus === 2 && [3, 6].includes(t?.step ?? -1),
      [I, n, y, t?.docStatus, t?.step],
    );
    ((0, z.useEffect)(() => {
      a?.(he);
    }, [he, a]),
      (0, z.useEffect)(() => {
        let e = _.current;
        if (!e) return;
        let t = new IntersectionObserver(
          (e) => {
            e[0]?.isIntersecting && !L && R();
          },
          { rootMargin: `120px` },
        );
        return (t.observe(e), () => t.disconnect());
      }, [L, R]),
      (0, z.useEffect)(() => {
        if (!I || !n?.length) {
          x.current &&= (clearInterval(x.current), null);
          return;
        }
        let e = n.map((e) => e.docId).filter(Boolean);
        if (!e.length) return;
        w.current = [...e];
        let t = () => {
          if (w.current.length === 0) {
            x.current &&= (clearInterval(x.current), null);
            return;
          }
          fe({ docIds: w.current }).then((e) => {
            if (e?.code === 0 && Array.isArray(e.data)) {
              let t = {};
              (e.data.forEach((e) => {
                e.docId && (t[String(e.docId)] = e);
              }),
                b(t),
                (w.current = w.current.filter((e) => t[e]?.step !== 7)),
                (w.current.length === 0 ||
                  w.current.every((e) => {
                    let n = t[e];
                    return n && n.docStatus === 2;
                  })) &&
                  x.current &&
                  (clearInterval(x.current),
                  (x.current = null),
                  (S.current = !0),
                  E((e) => e + 1)));
            }
          });
        };
        return (
          t(),
          (x.current = setInterval(t, 3e3)),
          () => {
            x.current &&= (clearInterval(x.current), null);
          }
        );
      }, [I]));
    let ge = (0, z.useMemo)(() => {
        let e = f;
        c !== `all` && (e = e.filter((e) => e.status === c));
        let t = u.trim().toLowerCase();
        return (
          t && (e = e.filter((e) => e.content.toLowerCase().includes(t))),
          e
        );
      }, [u, f, c]),
      _e = (0, z.useMemo)(
        () =>
          I
            ? `全部文件（${n?.length ?? 0}个）`
            : n?.find((e) => e.docId === o)?.docName || t?.docName || ``,
        [o, t?.docName, n, I],
      ),
      ve = (0, z.useMemo)(
        () => (I ? `` : n?.find((e) => e.docId === o)?.suffix || ``),
        [o, n, I],
      ),
      be = (0, z.useMemo)(
        () =>
          I
            ? f.length
            : o === e && t?.segmentCount != null
              ? Number(t.segmentCount)
              : f.length,
        [o, t?.segmentCount, e, I, f.length],
      ),
      Se = (0, z.useMemo)(
        () =>
          I
            ? n?.length
              ? (y[n[0].docId]?.step ?? void 0)
              : void 0
            : o === e
              ? t?.step
              : y[o]?.step,
        [o, t?.step, e, n, y, I],
      ),
      Ce = (0, z.useMemo)(
        () =>
          I
            ? n?.length
              ? (y[n[0].docId]?.docStatus ?? void 0)
              : void 0
            : o === e
              ? t?.docStatus
              : y[o]?.docStatus,
        [o, t?.docStatus, e, n, y, I],
      ),
      B = (0, z.useMemo)(
        () =>
          I
            ? n?.length
              ? (y[n[0].docId]?.stepMsg ?? void 0)
              : void 0
            : o === e
              ? t?.stepMsg
              : y[o]?.stepMsg,
        [o, t?.stepMsg, e, n, y, I],
      ),
      we = (0, z.useMemo)(() => {
        if (!I || !n?.length) return [];
        let e = {};
        return (
          n.forEach((t) => {
            e[t.docId] = {
              docId: t.docId,
              docName: t.docName,
              suffix: t.suffix,
              step: y[t.docId]?.step,
              docStatus: y[t.docId]?.docStatus,
              stepMsg: y[t.docId]?.stepMsg,
              segments: [],
            };
          }),
          ge.forEach((t) => {
            let n = e[t.docId];
            n && n.segments.push(t);
          }),
          Object.values(e)
        );
      }, [n, y, ge, I]),
      V = (0, z.useMemo)(() => {
        let r = [];
        return (
          (n?.length ?? 0) > 1 && r.push({ value: It, label: `全部文件` }),
          (n || []).forEach((e) => {
            r.push({ value: e.docId, label: e.docName });
          }),
          !r.length &&
            e &&
            t?.docName &&
            r.push({ value: e, label: t.docName }),
          r
        );
      }, [n, e, t?.docName]),
      U = (0, z.useCallback)(
        (e) => {
          if (e !== o)
            if ((s(e), e === It)) {
              let e = (n || []).map((e) => e.docId).filter(Boolean);
              e.length > 0 &&
                fe({ docIds: e }).then((t) => {
                  if (t?.code === 0 && Array.isArray(t.data)) {
                    let n = {};
                    (t.data.forEach((e) => {
                      e.docId && (n[String(e.docId)] = e);
                    }),
                      b(n));
                    let r = e.filter((e) => n[String(e)]?.step !== 7);
                    (r.length === 0 ||
                      r.every((e) => {
                        let t = n[String(e)];
                        return t && t.docStatus === 2;
                      })) &&
                      E((e) => e + 1);
                  }
                });
            } else r?.(null, e);
        },
        [o, n, r, E],
      ),
      W = (0, z.useCallback)(
        async (e) => {
          let t = e.status === H.Enabled ? 0 : 1,
            { code: n } = await ae({
              enable: t,
              segmentId: Number(e.segmentId),
            });
          if (n !== 0) return;
          M.success(`操作成功`);
          let i = t === 1 ? H.Enabled : H.Disabled;
          (p((t) => t.map((t) => (t.id === e.id ? { ...t, status: i } : t))),
            r?.());
        },
        [r],
      ),
      Te = (0, z.useCallback)((e) => {
        p((t) =>
          t.map((t) => (t.id === e ? { ...t, expanded: !t.expanded } : t)),
        );
      }, []),
      G = (0, z.useMemo)(() => (N >= 0 ? f[N] : null), [N, f]),
      Ee = (0, z.useCallback)(
        (e) => {
          let t = f.findIndex((t) => t.id === e.id);
          t < 0 || (re(t), P(!1), ce(``), j(!0));
        },
        [f],
      ),
      De = (0, z.useCallback)(
        (e) => {
          re((t) => {
            let n = t + e;
            return n < 0 || n > f.length - 1 ? t : (P(!1), ce(``), n);
          });
        },
        [f.length],
      ),
      Oe = (0, z.useCallback)(() => {
        G && (P(!0), ce(G.content));
      }, [G]),
      ke = (0, z.useCallback)(() => {
        (P(!1), ce(``));
      }, []),
      Ae = (0, z.useCallback)(async () => {
        if (G) {
          ue(!0);
          try {
            let { code: e } = await de({
              segmentId: Number(G.segmentId),
              content: F,
            });
            if (e !== 0) return;
            (M.success(`保存成功`),
              p((e) =>
                e.map((e) =>
                  e.id === G.id ? { ...e, content: F, charCount: F.length } : e,
                ),
              ),
              P(!1),
              r?.());
          } finally {
            ue(!1);
          }
        }
      }, [G, F, r]),
      K = (0, z.useCallback)(() => {
        if (ie && F !== G?.content) {
          ne.confirm({
            title: `提示`,
            content: `内容已修改但未保存，是否放弃修改？`,
            onOk: () => {
              (j(!1), ke());
            },
          });
          return;
        }
        (j(!1), ke());
      }, [G?.content, ie, F, ke]),
      je = (0, z.useCallback)(async () => {
        if (o) {
          O(!0);
          try {
            let {
              code: e,
              words: t,
              result: r,
              map: i,
            } = await ye(I ? n?.map((e) => e.docId) || [] : [o]);
            if (e === 101) {
              A(t);
              let e = I
                  ? (n || []).map((e) => ({
                      docId: e.docId,
                      docName: e.docName,
                    }))
                  : [{ docId: o, docName: _e }],
                i = r.map((e) => e.reduce((e, t) => e + t.list.length, 0)),
                a = ne.confirm({
                  title: null,
                  icon: null,
                  footer: null,
                  width: 800,
                  centered: !0,
                  closable: !0,
                  maskClosable: !0,
                  styles: { body: { padding: 0 } },
                  content: (0, z.createElement)(xe, {
                    data: r,
                    total: i,
                    docList: e,
                    closed: () => a.destroy(),
                  }),
                });
            }
          } finally {
            O(!1);
          }
        }
      }, [o, _e, I, n]),
      q = (0, z.useCallback)(
        async (e, t) => {
          if (f.length === be) {
            let e = await oe({ segmentId: Number(t) });
            e.code === 0 &&
              e.data &&
              ((g.current.position = e.data.segmentOrder + 1),
              p((t) => {
                let n = Pt(e.data, o);
                return t.some((e) => e.id === n.id) ? t : [...t, n];
              }));
          }
          r?.();
        },
        [o, f.length, be, r],
      );
    return {
      activeFileDocId: o,
      statusFilter: c,
      keyword: u,
      segments: f,
      filteredSegments: ge,
      listLoading: m,
      sentinelRef: _,
      diagnosing: ee,
      redWords: k,
      detailModalVisible: te,
      detailIndex: N,
      detailSegment: G,
      editing: ie,
      editingContent: F,
      saving: le,
      segmentModalRef: pe,
      disabled: L,
      isAllFiles: I,
      allFilesReady: me,
      activeFileName: _e,
      activeFileSuffix: ve,
      totalSegments: be,
      currentDocStep: Se,
      currentDocStatus: Ce,
      currentDocStepMsg: B,
      groupedSegments: we,
      fileSelectOptions: V,
      handleChangeFile: U,
      setStatusFilter: l,
      setKeyword: d,
      handleToggleExpand: Te,
      handleOpenDetail: Ee,
      handleStepDetail: De,
      handleStartEdit: Oe,
      handleCancelEdit: ke,
      setEditingContent: ce,
      handleToggleStatus: W,
      handleSaveEdit: Ae,
      handleCloseDetail: K,
      handleAiDiagnosis: je,
      handleStartAdd: (0, z.useCallback)(() => {
        pe.current?.open(
          { docId: o, baseId: t?.baseId, segmentOrder: be || 0 },
          q,
        );
      }, [o, t?.baseId, be, q]),
    };
  };
v();
var Rt = (e) => {
    if (!e || isNaN(e)) return `00:00`;
    let t = Math.floor(e / 60),
      n = Math.floor(e % 60);
    return `${String(t).padStart(2, `0`)}:${String(n).padStart(2, `0`)}`;
  },
  zt = (0, z.memo)(
    ({
      docId: e,
      docDetail: t,
      docIdList: n,
      readonly: r = !1,
      getInfo: i,
      setStopParentPolling: s,
      onReadyStateChange: l,
    }) => {
      let {
          activeFileDocId: u,
          statusFilter: d,
          keyword: f,
          segments: g,
          filteredSegments: v,
          listLoading: y,
          sentinelRef: b,
          diagnosing: S,
          redWords: C,
          detailModalVisible: w,
          detailIndex: E,
          detailSegment: D,
          editing: ee,
          editingContent: k,
          saving: te,
          segmentModalRef: M,
          disabled: N,
          isAllFiles: F,
          activeFileName: ae,
          activeFileSuffix: oe,
          totalSegments: se,
          currentDocStep: ce,
          currentDocStatus: le,
          currentDocStepMsg: ue,
          groupedSegments: de,
          fileSelectOptions: fe,
          handleChangeFile: pe,
          setStatusFilter: I,
          setKeyword: me,
          handleToggleExpand: L,
          handleOpenDetail: R,
          handleStepDetail: he,
          handleStartEdit: ge,
          handleCancelEdit: _e,
          setEditingContent: ve,
          handleToggleStatus: ye,
          handleSaveEdit: xe,
          handleCloseDetail: Se,
          handleAiDiagnosis: Ce,
          handleStartAdd: B,
        } = Lt({
          docId: e,
          docDetail: t,
          docIdList: n,
          getInfo: i,
          setStopParentPolling: s,
          onReadyStateChange: l,
        }),
        [we, V] = (0, z.useState)(!1),
        [U, Te] = (0, z.useState)(null),
        [G, Ee] = (0, z.useState)(0),
        De = (0, z.useRef)(null),
        Oe = (0, z.useCallback)((e, t = 0) => {
          (Te(e), Ee(t), V(!0));
        }, []),
        ke = (0, z.useCallback)(() => {
          (De.current && De.current.pause(), V(!1), Te(null), Ee(0));
        }, []),
        Ae = (0, z.useCallback)(
          (e) => {
            if (!U) return;
            let t = U.videoUrls.length;
            Ee((n) =>
              e === `prev` ? Math.max(0, n - 1) : Math.min(t - 1, n + 1),
            );
          },
          [U],
        ),
        [K, je] = (0, z.useState)(``),
        q = (0, z.useRef)(new Map()),
        Me = (0, z.useRef)(new Map()),
        [Ne, Pe] = (0, z.useState)(new Map()),
        [Fe, Ie] = (0, z.useState)(new Map()),
        [Le, Re] = (0, z.useState)(new Map()),
        ze = (0, z.useCallback)(
          (e, t) => {
            let n = Me.current.get(e);
            if ((n && (n(), Me.current.delete(e)), t)) {
              q.current.set(e, t);
              let n = Le.get(e);
              n !== void 0 && (t.volume = n);
              let r = () => {
                  Pe((n) => new Map(n).set(e, t.currentTime));
                },
                i = () => {
                  let n = t.duration;
                  typeof n == `number` &&
                    isFinite(n) &&
                    n > 0 &&
                    Ie((t) => new Map(t).set(e, n));
                },
                a = () => {
                  je((t) => (t === e ? `` : t));
                },
                o = () => {
                  je((t) => (t === e ? `` : t));
                },
                s = () => {
                  Re((n) => new Map(n).set(e, t.volume));
                };
              (t.addEventListener(`timeupdate`, r),
                t.addEventListener(`loadedmetadata`, i),
                t.addEventListener(`ended`, a),
                t.addEventListener(`pause`, o),
                t.addEventListener(`volumechange`, s),
                Me.current.set(e, () => {
                  (t.removeEventListener(`timeupdate`, r),
                    t.removeEventListener(`loadedmetadata`, i),
                    t.removeEventListener(`ended`, a),
                    t.removeEventListener(`pause`, o),
                    t.removeEventListener(`volumechange`, s));
                }));
            } else q.current.delete(e);
          },
          [Le],
        ),
        Be = (0, z.useCallback)(
          (e, t) => {
            let n = `${e}-${t}`,
              r = q.current.get(n);
            if (r) {
              if (K === n) {
                r.pause();
                return;
              }
              if (K) {
                let e = q.current.get(K);
                e && e.pause();
              }
              (r.play().catch(() => {}), je(n));
            }
          },
          [K],
        ),
        Ve = (0, z.useCallback)((e, t, n) => {
          let r = `${e}-${t}`,
            i = q.current.get(r);
          i && ((i.currentTime = n), Pe((e) => new Map(e).set(r, n)));
        }, []),
        He = (0, z.useCallback)((e, t, n) => {
          let r = `${e}-${t}`,
            i = q.current.get(r);
          (i && ((i.volume = n), (i.muted = n === 0)),
            Re((e) => new Map(e).set(r, n)));
        }, []),
        [Y, Ue] = (0, z.useState)(new Map()),
        X = (0, z.useRef)(new Set()),
        We = (0, z.useRef)(new Map()),
        Ge = (0, z.useCallback)(
          (e, t, n) => {
            let r = `${e}-${t}`;
            if (Y.has(r) || X.current.has(r)) return;
            X.current.add(r);
            let i = We.current.get(r);
            i ||
              ((i = document.createElement(`video`)),
              (i.preload = `metadata`),
              (i.muted = !0),
              (i.style.display = `none`),
              (i.crossOrigin = `anonymous`),
              We.current.set(r, i));
            let a = () => {
                (i.removeEventListener(`loadedmetadata`, o),
                  i.removeEventListener(`durationchange`, s),
                  i.removeEventListener(`error`, c));
              },
              o = () => {
                l(i.duration);
              },
              s = () => {
                l(i.duration);
              },
              c = () => {
                (a(), X.current.delete(r));
              },
              l = (e) => {
                if (typeof e == `number` && isFinite(e) && e > 0)
                  Ue((t) => new Map(t).set(r, e));
                else if (i.seekable && i.seekable.length > 0) {
                  let e = i.seekable.end(i.seekable.length - 1);
                  typeof e == `number` &&
                    isFinite(e) &&
                    e > 0 &&
                    Ue((t) => new Map(t).set(r, e));
                }
                (a(), X.current.delete(r));
              };
            (i.addEventListener(`loadedmetadata`, o),
              i.addEventListener(`durationchange`, s),
              i.addEventListener(`error`, c),
              (i.src = n));
          },
          [Y],
        );
      return (0, J.jsxs)(`div`, {
        className: Q[`step3-wrapper`],
        children: [
          (0, J.jsxs)(`div`, {
            className: Q[`file-review-section`],
            children: [
              (0, J.jsx)(Mt, {
                activeFileDocId: u,
                fileSelectOptions: fe,
                statusFilter: d,
                keyword: f,
                totalSegments: se,
                diagnosing: S,
                disabled: N,
                handleChangeFile: pe,
                setStatusFilter: I,
                setKeyword: me,
                onAiDiagnosis: () => void Ce(),
              }),
              N
                ? (0, J.jsx)(`div`, {
                    className: `global-text-center ${Q[`loading-block-large`]}`,
                    children: (0, J.jsxs)(p.Text, {
                      type: `secondary`,
                      children: [
                        (0, J.jsx)(A, { spin: !0 }),
                        F
                          ? `文件正在处理中，请稍后`
                          : ` 文档正在${t?.step === 1 ? `分段` : `打标签`}，请稍后`,
                      ],
                    }),
                  })
                : (0, J.jsxs)(`div`, {
                    className: Q[`segment-list`],
                    children: [
                      F
                        ? de.map((e) =>
                            (0, J.jsx)(
                              `div`,
                              {
                                className: Q[`file-group`],
                                children:
                                  e.segments.length === 0 && !y
                                    ? (0, J.jsx)(c, {
                                        description:
                                          e.step === 7
                                            ? kt(e.stepMsg) || `分段处理失败`
                                            : `暂无分段数据`,
                                      })
                                    : e.segments.map((t) =>
                                        (0, J.jsxs)(
                                          `div`,
                                          {
                                            className: Q[`segment-card`],
                                            onClick: () => R(t),
                                            children: [
                                              (0, J.jsxs)(`div`, {
                                                className: Q[`segment-header`],
                                                children: [
                                                  (0, J.jsxs)(`div`, {
                                                    className:
                                                      Q[`segment-header-left`],
                                                    children: [
                                                      (0, J.jsx)(`span`, {
                                                        className:
                                                          Q[`segment-index`],
                                                        children: Dt(t.index),
                                                      }),
                                                      (0, J.jsxs)(`span`, {
                                                        className:
                                                          Q[
                                                            `segment-char-count`
                                                          ],
                                                        children: [
                                                          t.charCount,
                                                          `字符`,
                                                        ],
                                                      }),
                                                      (() => {
                                                        let e =
                                                          t.status ===
                                                          H.Enabled;
                                                        return (0, J.jsx)(o, {
                                                          status: e
                                                            ? `success`
                                                            : `default`,
                                                          text: e
                                                            ? `已启用`
                                                            : `已禁用`,
                                                        });
                                                      })(),
                                                    ],
                                                  }),
                                                  (0, J.jsx)(`div`, {
                                                    className:
                                                      Q[`segment-header-right`],
                                                    children: (0, J.jsx)(x, {
                                                      type: `link`,
                                                      size: `small`,
                                                      onClick: (e) => {
                                                        (e.stopPropagation(),
                                                          L(t.id));
                                                      },
                                                      children: t.expanded
                                                        ? `收起`
                                                        : `展开`,
                                                    }),
                                                  }),
                                                ],
                                              }),
                                              (0, J.jsxs)(`div`, {
                                                className:
                                                  Q[`segment-card-body`],
                                                children: [
                                                  t.imageUrls[0]
                                                    ? (0, J.jsx)(`div`, {
                                                        className:
                                                          Q[
                                                            `segment-thumbnail`
                                                          ],
                                                        children: (0, J.jsx)(
                                                          `img`,
                                                          {
                                                            src: t.imageUrls[0],
                                                            alt: `切片缩略图`,
                                                          },
                                                        ),
                                                      })
                                                    : t.videoUrls[0]
                                                      ? (0, J.jsx)(h, {
                                                          title: (0, J.jsxs)(
                                                            `div`,
                                                            {
                                                              className:
                                                                Q[
                                                                  `video-tooltip`
                                                                ],
                                                              onClick: (e) => {
                                                                (e.stopPropagation(),
                                                                  Oe(t, 0));
                                                              },
                                                              children: [
                                                                (0, J.jsxs)(
                                                                  `div`,
                                                                  {
                                                                    className:
                                                                      Q[
                                                                        `video-tooltip-thumb`
                                                                      ],
                                                                    children: [
                                                                      (0,
                                                                      J.jsx)(
                                                                        `video`,
                                                                        {
                                                                          src: t
                                                                            .videoUrls[0],
                                                                          preload: `metadata`,
                                                                          muted:
                                                                            !0,
                                                                        },
                                                                      ),
                                                                      (0,
                                                                      J.jsx)(
                                                                        `div`,
                                                                        {
                                                                          className:
                                                                            Q[
                                                                              `video-tooltip-mask`
                                                                            ],
                                                                          children:
                                                                            (0,
                                                                            J.jsx)(
                                                                              _,
                                                                              {},
                                                                            ),
                                                                        },
                                                                      ),
                                                                      (0,
                                                                      J.jsx)(
                                                                        `span`,
                                                                        {
                                                                          className:
                                                                            Q[
                                                                              `video-tooltip-duration`
                                                                            ],
                                                                          children:
                                                                            Y.has(
                                                                              `${t.id}-0`,
                                                                            )
                                                                              ? Rt(
                                                                                  Y.get(
                                                                                    `${t.id}-0`,
                                                                                  ),
                                                                                )
                                                                              : `...`,
                                                                        },
                                                                      ),
                                                                    ],
                                                                  },
                                                                ),
                                                                (0, J.jsxs)(
                                                                  `div`,
                                                                  {
                                                                    className:
                                                                      Q[
                                                                        `video-tooltip-text`
                                                                      ],
                                                                    children: [
                                                                      `共 `,
                                                                      t
                                                                        .videoUrls
                                                                        .length,
                                                                      ` `,
                                                                      `个分片视频，点击播放`,
                                                                    ],
                                                                  },
                                                                ),
                                                              ],
                                                            },
                                                          ),
                                                          color: `#fff`,
                                                          placement: `bottom`,
                                                          overlayInnerStyle: {
                                                            padding: 8,
                                                            borderRadius: 8,
                                                          },
                                                          onVisibleChange: (
                                                            e,
                                                          ) => {
                                                            e &&
                                                              t.videoUrls.forEach(
                                                                (e, n) => {
                                                                  Ge(
                                                                    t.id,
                                                                    n,
                                                                    e,
                                                                  );
                                                                },
                                                              );
                                                          },
                                                          children: (0, J.jsxs)(
                                                            `div`,
                                                            {
                                                              className:
                                                                Q[
                                                                  `segment-thumbnail`
                                                                ],
                                                              onClick: (e) => {
                                                                (e.stopPropagation(),
                                                                  Oe(t, 0));
                                                              },
                                                              style: {
                                                                cursor: `pointer`,
                                                              },
                                                              children: [
                                                                (0, J.jsx)(
                                                                  `video`,
                                                                  {
                                                                    src: t
                                                                      .videoUrls[0],
                                                                    preload: `metadata`,
                                                                    muted: !0,
                                                                  },
                                                                ),
                                                                (0, J.jsx)(
                                                                  `span`,
                                                                  {
                                                                    className:
                                                                      Q[
                                                                        `segment-thumbnail-mask`
                                                                      ],
                                                                    children:
                                                                      (0,
                                                                      J.jsx)(
                                                                        _,
                                                                        {},
                                                                      ),
                                                                  },
                                                                ),
                                                              ],
                                                            },
                                                          ),
                                                        })
                                                      : t.audioUrls[0]
                                                        ? (0, J.jsx)(h, {
                                                            title: (0, J.jsxs)(
                                                              `div`,
                                                              {
                                                                className:
                                                                  Q[
                                                                    `audio-tooltip`
                                                                  ],
                                                                onClick: (e) =>
                                                                  e.stopPropagation(),
                                                                children: [
                                                                  (0, J.jsx)(
                                                                    `div`,
                                                                    {
                                                                      className:
                                                                        Q[
                                                                          `audio-tooltip-title`
                                                                        ],
                                                                      children: `音频预览`,
                                                                    },
                                                                  ),
                                                                  (0, J.jsx)(
                                                                    `div`,
                                                                    {
                                                                      className:
                                                                        Q[
                                                                          `audio-tooltip-list`
                                                                        ],
                                                                      children:
                                                                        t.audioUrls.map(
                                                                          (
                                                                            e,
                                                                            n,
                                                                          ) => {
                                                                            let r = `${t.id}-${n}`,
                                                                              i =
                                                                                K ===
                                                                                r,
                                                                              o =
                                                                                Ne.get(
                                                                                  r,
                                                                                ) ??
                                                                                0,
                                                                              s =
                                                                                Fe.get(
                                                                                  r,
                                                                                ) ??
                                                                                0,
                                                                              c =
                                                                                Le.get(
                                                                                  r,
                                                                                ) ??
                                                                                0.5,
                                                                              l =
                                                                                s >
                                                                                0
                                                                                  ? (o /
                                                                                      s) *
                                                                                    100
                                                                                  : 0;
                                                                            return (0,
                                                                            J.jsxs)(
                                                                              `div`,
                                                                              {
                                                                                className: `${Q[`audio-tooltip-item`]} ${i ? Q[`audio-tooltip-item-active`] : ``}`,
                                                                                children:
                                                                                  [
                                                                                    (0,
                                                                                    J.jsx)(
                                                                                      `div`,
                                                                                      {
                                                                                        className:
                                                                                          Q[
                                                                                            `audio-tooltip-icon`
                                                                                          ],
                                                                                        children:
                                                                                          (0,
                                                                                          J.jsx)(
                                                                                            re,
                                                                                            {},
                                                                                          ),
                                                                                      },
                                                                                    ),
                                                                                    (0,
                                                                                    J.jsx)(
                                                                                      `div`,
                                                                                      {
                                                                                        className:
                                                                                          Q[
                                                                                            `audio-tooltip-play`
                                                                                          ],
                                                                                        onClick:
                                                                                          () =>
                                                                                            Be(
                                                                                              t.id,
                                                                                              n,
                                                                                            ),
                                                                                        children:
                                                                                          i
                                                                                            ? (0,
                                                                                              J.jsx)(
                                                                                                a,
                                                                                                {},
                                                                                              )
                                                                                            : (0,
                                                                                              J.jsx)(
                                                                                                _,
                                                                                                {},
                                                                                              ),
                                                                                      },
                                                                                    ),
                                                                                    (0,
                                                                                    J.jsx)(
                                                                                      `div`,
                                                                                      {
                                                                                        className:
                                                                                          Q[
                                                                                            `audio-tooltip-progress`
                                                                                          ],
                                                                                        children:
                                                                                          (0,
                                                                                          J.jsx)(
                                                                                            `input`,
                                                                                            {
                                                                                              type: `range`,
                                                                                              className:
                                                                                                Q[
                                                                                                  `audio-tooltip-range`
                                                                                                ],
                                                                                              min: 0,
                                                                                              max:
                                                                                                s ||
                                                                                                100,
                                                                                              step: 0.1,
                                                                                              value:
                                                                                                o,
                                                                                              onChange:
                                                                                                (
                                                                                                  e,
                                                                                                ) =>
                                                                                                  Ve(
                                                                                                    t.id,
                                                                                                    n,
                                                                                                    Number(
                                                                                                      e
                                                                                                        .target
                                                                                                        .value,
                                                                                                    ),
                                                                                                  ),
                                                                                              style:
                                                                                                {
                                                                                                  "--progress": `${l}%`,
                                                                                                },
                                                                                            },
                                                                                          ),
                                                                                      },
                                                                                    ),
                                                                                    (0,
                                                                                    J.jsxs)(
                                                                                      `span`,
                                                                                      {
                                                                                        className:
                                                                                          Q[
                                                                                            `audio-tooltip-time`
                                                                                          ],
                                                                                        children:
                                                                                          [
                                                                                            Rt(
                                                                                              Math.floor(
                                                                                                o,
                                                                                              ),
                                                                                            ),
                                                                                            (0,
                                                                                            J.jsx)(
                                                                                              `span`,
                                                                                              {
                                                                                                className:
                                                                                                  Q[
                                                                                                    `audio-tooltip-time-sep`
                                                                                                  ],
                                                                                                children: `/`,
                                                                                              },
                                                                                            ),
                                                                                            Rt(
                                                                                              Math.floor(
                                                                                                s,
                                                                                              ),
                                                                                            ),
                                                                                          ],
                                                                                      },
                                                                                    ),
                                                                                    (0,
                                                                                    J.jsxs)(
                                                                                      `div`,
                                                                                      {
                                                                                        className:
                                                                                          Q[
                                                                                            `audio-tooltip-volume-wrap`
                                                                                          ],
                                                                                        children:
                                                                                          [
                                                                                            (0,
                                                                                            J.jsx)(
                                                                                              ie,
                                                                                              {
                                                                                                className:
                                                                                                  Q[
                                                                                                    `audio-tooltip-volume-icon`
                                                                                                  ],
                                                                                                onClick:
                                                                                                  () =>
                                                                                                    He(
                                                                                                      t.id,
                                                                                                      n,
                                                                                                      c >
                                                                                                        0
                                                                                                        ? 0
                                                                                                        : 0.5,
                                                                                                    ),
                                                                                              },
                                                                                            ),
                                                                                            (0,
                                                                                            J.jsx)(
                                                                                              `input`,
                                                                                              {
                                                                                                type: `range`,
                                                                                                className:
                                                                                                  Q[
                                                                                                    `audio-tooltip-range-volume`
                                                                                                  ],
                                                                                                min: 0,
                                                                                                max: 1,
                                                                                                step: 0.01,
                                                                                                value:
                                                                                                  c,
                                                                                                onChange:
                                                                                                  (
                                                                                                    e,
                                                                                                  ) =>
                                                                                                    He(
                                                                                                      t.id,
                                                                                                      n,
                                                                                                      Number(
                                                                                                        e
                                                                                                          .target
                                                                                                          .value,
                                                                                                      ),
                                                                                                    ),
                                                                                                style:
                                                                                                  {
                                                                                                    "--volume": `${c * 100}%`,
                                                                                                  },
                                                                                              },
                                                                                            ),
                                                                                          ],
                                                                                      },
                                                                                    ),
                                                                                    (0,
                                                                                    J.jsx)(
                                                                                      `audio`,
                                                                                      {
                                                                                        ref: (
                                                                                          e,
                                                                                        ) =>
                                                                                          ze(
                                                                                            r,
                                                                                            e,
                                                                                          ),
                                                                                        src: e,
                                                                                        preload: `metadata`,
                                                                                      },
                                                                                    ),
                                                                                  ],
                                                                              },
                                                                              r,
                                                                            );
                                                                          },
                                                                        ),
                                                                    },
                                                                  ),
                                                                ],
                                                              },
                                                            ),
                                                            color: `#fff`,
                                                            placement: `bottom`,
                                                            overlayInnerStyle: {
                                                              padding: 0,
                                                              borderRadius: 8,
                                                            },
                                                            overlayStyle: {
                                                              maxWidth: 580,
                                                            },
                                                            destroyTooltipOnHide:
                                                              !0,
                                                            children: (0,
                                                            J.jsx)(`div`, {
                                                              className:
                                                                Q[
                                                                  `segment-thumbnail-placeholder`
                                                                ],
                                                              children: (0,
                                                              J.jsx)(re, {}),
                                                            }),
                                                          })
                                                        : null,
                                                  (0, J.jsx)(`div`, {
                                                    className:
                                                      Q[`segment-content`],
                                                    children: (0, J.jsxs)(
                                                      `div`,
                                                      {
                                                        className:
                                                          Q[`segment-preview`],
                                                        children: [
                                                          At(
                                                            Ot(
                                                              t.content,
                                                              !!t.expanded,
                                                            ),
                                                            C,
                                                            Q[`sensitive-word`],
                                                          ),
                                                          (0, J.jsx)(x, {
                                                            type: `link`,
                                                            size: `small`,
                                                            className:
                                                              Q[
                                                                `segment-expand-btn`
                                                              ],
                                                            onClick: (e) => {
                                                              (e.stopPropagation(),
                                                                L(t.id));
                                                            },
                                                            children: t.expanded
                                                              ? `收起`
                                                              : `展开`,
                                                          }),
                                                        ],
                                                      },
                                                    ),
                                                  }),
                                                ],
                                              }),
                                              (0, J.jsxs)(`div`, {
                                                className:
                                                  Q[`segment-card-footer`],
                                                children: [
                                                  (0, J.jsx)(`img`, {
                                                    src: `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/${e.suffix && W.includes(`.${e.suffix}`) ? `video-icon.svg` : `audio-icon.svg`}`,
                                                    alt:
                                                      e.suffix &&
                                                      W.includes(`.${e.suffix}`)
                                                        ? `视频`
                                                        : `音频`,
                                                    className:
                                                      Q[`footer-file-icon`],
                                                  }),
                                                  (0, J.jsx)(p.Text, {
                                                    className:
                                                      Q[`segment-file-name`],
                                                    children: e.docName,
                                                  }),
                                                ],
                                              }),
                                            ],
                                          },
                                          t.id,
                                        ),
                                      ),
                              },
                              e.docId,
                            ),
                          )
                        : (0, J.jsx)(J.Fragment, {
                            children:
                              v.length === 0 && !y
                                ? (0, J.jsx)(c, {
                                    description:
                                      ce === 7
                                        ? kt(ue) || `分段处理失败`
                                        : `暂无分段数据`,
                                  })
                                : v.map((e) =>
                                    (0, J.jsxs)(
                                      `div`,
                                      {
                                        className: Q[`segment-card`],
                                        onClick: () => R(e),
                                        children: [
                                          (0, J.jsxs)(`div`, {
                                            className: Q[`segment-header`],
                                            children: [
                                              (0, J.jsxs)(`div`, {
                                                className:
                                                  Q[`segment-header-left`],
                                                children: [
                                                  (0, J.jsx)(`span`, {
                                                    className:
                                                      Q[`segment-index`],
                                                    children: Dt(e.index),
                                                  }),
                                                  (0, J.jsxs)(`span`, {
                                                    className:
                                                      Q[`segment-char-count`],
                                                    children: [
                                                      e.charCount,
                                                      `字符`,
                                                    ],
                                                  }),
                                                ],
                                              }),
                                              (0, J.jsx)(`div`, {
                                                className:
                                                  Q[`segment-header-right`],
                                                children: (0, J.jsx)(`div`, {
                                                  className:
                                                    Q[`segment-status-hover`],
                                                  children: (() => {
                                                    let t =
                                                      e.status === H.Enabled;
                                                    return (0, J.jsxs)(
                                                      J.Fragment,
                                                      {
                                                        children: [
                                                          (0, J.jsx)(o, {
                                                            status: t
                                                              ? `success`
                                                              : `default`,
                                                            text: t
                                                              ? `已启用`
                                                              : `已禁用`,
                                                          }),
                                                          (0, J.jsx)(P, {
                                                            checked: t,
                                                            size: `small`,
                                                            onChange: (
                                                              t,
                                                              n,
                                                            ) => {
                                                              (n.stopPropagation(),
                                                                ye(e));
                                                            },
                                                            onClick: (e, t) =>
                                                              t.stopPropagation(),
                                                          }),
                                                        ],
                                                      },
                                                    );
                                                  })(),
                                                }),
                                              }),
                                            ],
                                          }),
                                          (0, J.jsxs)(`div`, {
                                            className: Q[`segment-card-body`],
                                            children: [
                                              e.imageUrls[0]
                                                ? (0, J.jsx)(`div`, {
                                                    className:
                                                      Q[`segment-thumbnail`],
                                                    children: (0, J.jsx)(
                                                      `img`,
                                                      {
                                                        src: e.imageUrls[0],
                                                        alt: `切片缩略图`,
                                                      },
                                                    ),
                                                  })
                                                : e.videoUrls[0]
                                                  ? (0, J.jsx)(h, {
                                                      title: (0, J.jsxs)(
                                                        `div`,
                                                        {
                                                          className:
                                                            Q[`video-tooltip`],
                                                          onClick: (t) => {
                                                            (t.stopPropagation(),
                                                              Oe(e, 0));
                                                          },
                                                          children: [
                                                            (0, J.jsxs)(`div`, {
                                                              className:
                                                                Q[
                                                                  `video-tooltip-thumb`
                                                                ],
                                                              children: [
                                                                (0, J.jsx)(
                                                                  `video`,
                                                                  {
                                                                    src: e
                                                                      .videoUrls[0],
                                                                    preload: `metadata`,
                                                                    muted: !0,
                                                                  },
                                                                ),
                                                                (0, J.jsx)(
                                                                  `div`,
                                                                  {
                                                                    className:
                                                                      Q[
                                                                        `video-tooltip-mask`
                                                                      ],
                                                                    children:
                                                                      (0,
                                                                      J.jsx)(
                                                                        _,
                                                                        {},
                                                                      ),
                                                                  },
                                                                ),
                                                                (0, J.jsx)(
                                                                  `span`,
                                                                  {
                                                                    className:
                                                                      Q[
                                                                        `video-tooltip-duration`
                                                                      ],
                                                                    children:
                                                                      Y.has(
                                                                        `${e.id}-0`,
                                                                      )
                                                                        ? Rt(
                                                                            Y.get(
                                                                              `${e.id}-0`,
                                                                            ),
                                                                          )
                                                                        : `...`,
                                                                  },
                                                                ),
                                                              ],
                                                            }),
                                                            (0, J.jsxs)(`div`, {
                                                              className:
                                                                Q[
                                                                  `video-tooltip-text`
                                                                ],
                                                              children: [
                                                                `共 `,
                                                                e.videoUrls
                                                                  .length,
                                                                ` `,
                                                                `个分片视频，点击播放`,
                                                              ],
                                                            }),
                                                          ],
                                                        },
                                                      ),
                                                      color: `#fff`,
                                                      placement: `bottom`,
                                                      overlayInnerStyle: {
                                                        padding: 8,
                                                        borderRadius: 8,
                                                      },
                                                      onVisibleChange: (t) => {
                                                        t &&
                                                          e.videoUrls.forEach(
                                                            (t, n) => {
                                                              Ge(e.id, n, t);
                                                            },
                                                          );
                                                      },
                                                      children: (0, J.jsxs)(
                                                        `div`,
                                                        {
                                                          className:
                                                            Q[
                                                              `segment-thumbnail`
                                                            ],
                                                          onClick: (t) => {
                                                            (t.stopPropagation(),
                                                              Oe(e, 0));
                                                          },
                                                          style: {
                                                            cursor: `pointer`,
                                                          },
                                                          children: [
                                                            (0, J.jsx)(
                                                              `video`,
                                                              {
                                                                src: e
                                                                  .videoUrls[0],
                                                                preload: `metadata`,
                                                                muted: !0,
                                                              },
                                                            ),
                                                            (0, J.jsx)(`span`, {
                                                              className:
                                                                Q[
                                                                  `segment-thumbnail-mask`
                                                                ],
                                                              children: (0,
                                                              J.jsx)(_, {}),
                                                            }),
                                                          ],
                                                        },
                                                      ),
                                                    })
                                                  : e.audioUrls[0]
                                                    ? (0, J.jsx)(h, {
                                                        title: (0, J.jsxs)(
                                                          `div`,
                                                          {
                                                            className:
                                                              Q[
                                                                `audio-tooltip`
                                                              ],
                                                            onClick: (e) =>
                                                              e.stopPropagation(),
                                                            children: [
                                                              (0, J.jsx)(
                                                                `div`,
                                                                {
                                                                  className:
                                                                    Q[
                                                                      `audio-tooltip-title`
                                                                    ],
                                                                  children: `音频预览`,
                                                                },
                                                              ),
                                                              (0, J.jsx)(
                                                                `div`,
                                                                {
                                                                  className:
                                                                    Q[
                                                                      `audio-tooltip-list`
                                                                    ],
                                                                  children:
                                                                    e.audioUrls.map(
                                                                      (
                                                                        t,
                                                                        n,
                                                                      ) => {
                                                                        let r = `${e.id}-${n}`,
                                                                          i =
                                                                            K ===
                                                                            r,
                                                                          o =
                                                                            Ne.get(
                                                                              r,
                                                                            ) ??
                                                                            0,
                                                                          s =
                                                                            Fe.get(
                                                                              r,
                                                                            ) ??
                                                                            0,
                                                                          c =
                                                                            Le.get(
                                                                              r,
                                                                            ) ??
                                                                            0.5,
                                                                          l =
                                                                            s >
                                                                            0
                                                                              ? (o /
                                                                                  s) *
                                                                                100
                                                                              : 0;
                                                                        return (0,
                                                                        J.jsxs)(
                                                                          `div`,
                                                                          {
                                                                            className: `${Q[`audio-tooltip-item`]} ${i ? Q[`audio-tooltip-item-active`] : ``}`,
                                                                            children:
                                                                              [
                                                                                (0,
                                                                                J.jsx)(
                                                                                  `div`,
                                                                                  {
                                                                                    className:
                                                                                      Q[
                                                                                        `audio-tooltip-icon`
                                                                                      ],
                                                                                    children:
                                                                                      (0,
                                                                                      J.jsx)(
                                                                                        re,
                                                                                        {},
                                                                                      ),
                                                                                  },
                                                                                ),
                                                                                (0,
                                                                                J.jsx)(
                                                                                  `div`,
                                                                                  {
                                                                                    className:
                                                                                      Q[
                                                                                        `audio-tooltip-play`
                                                                                      ],
                                                                                    onClick:
                                                                                      () =>
                                                                                        Be(
                                                                                          e.id,
                                                                                          n,
                                                                                        ),
                                                                                    children:
                                                                                      i
                                                                                        ? (0,
                                                                                          J.jsx)(
                                                                                            a,
                                                                                            {},
                                                                                          )
                                                                                        : (0,
                                                                                          J.jsx)(
                                                                                            _,
                                                                                            {},
                                                                                          ),
                                                                                  },
                                                                                ),
                                                                                (0,
                                                                                J.jsx)(
                                                                                  `div`,
                                                                                  {
                                                                                    className:
                                                                                      Q[
                                                                                        `audio-tooltip-progress`
                                                                                      ],
                                                                                    children:
                                                                                      (0,
                                                                                      J.jsx)(
                                                                                        `input`,
                                                                                        {
                                                                                          type: `range`,
                                                                                          className:
                                                                                            Q[
                                                                                              `audio-tooltip-range`
                                                                                            ],
                                                                                          min: 0,
                                                                                          max:
                                                                                            s ||
                                                                                            100,
                                                                                          step: 0.1,
                                                                                          value:
                                                                                            o,
                                                                                          onChange:
                                                                                            (
                                                                                              t,
                                                                                            ) =>
                                                                                              Ve(
                                                                                                e.id,
                                                                                                n,
                                                                                                Number(
                                                                                                  t
                                                                                                    .target
                                                                                                    .value,
                                                                                                ),
                                                                                              ),
                                                                                          style:
                                                                                            {
                                                                                              "--progress": `${l}%`,
                                                                                            },
                                                                                        },
                                                                                      ),
                                                                                  },
                                                                                ),
                                                                                (0,
                                                                                J.jsxs)(
                                                                                  `span`,
                                                                                  {
                                                                                    className:
                                                                                      Q[
                                                                                        `audio-tooltip-time`
                                                                                      ],
                                                                                    children:
                                                                                      [
                                                                                        Rt(
                                                                                          Math.floor(
                                                                                            o,
                                                                                          ),
                                                                                        ),
                                                                                        (0,
                                                                                        J.jsx)(
                                                                                          `span`,
                                                                                          {
                                                                                            className:
                                                                                              Q[
                                                                                                `audio-tooltip-time-sep`
                                                                                              ],
                                                                                            children: `/`,
                                                                                          },
                                                                                        ),
                                                                                        Rt(
                                                                                          Math.floor(
                                                                                            s,
                                                                                          ),
                                                                                        ),
                                                                                      ],
                                                                                  },
                                                                                ),
                                                                                (0,
                                                                                J.jsxs)(
                                                                                  `div`,
                                                                                  {
                                                                                    className:
                                                                                      Q[
                                                                                        `audio-tooltip-volume-wrap`
                                                                                      ],
                                                                                    children:
                                                                                      [
                                                                                        (0,
                                                                                        J.jsx)(
                                                                                          ie,
                                                                                          {
                                                                                            className:
                                                                                              Q[
                                                                                                `audio-tooltip-volume-icon`
                                                                                              ],
                                                                                            onClick:
                                                                                              () =>
                                                                                                He(
                                                                                                  e.id,
                                                                                                  n,
                                                                                                  c >
                                                                                                    0
                                                                                                    ? 0
                                                                                                    : 0.5,
                                                                                                ),
                                                                                          },
                                                                                        ),
                                                                                        (0,
                                                                                        J.jsx)(
                                                                                          `input`,
                                                                                          {
                                                                                            type: `range`,
                                                                                            className:
                                                                                              Q[
                                                                                                `audio-tooltip-range-volume`
                                                                                              ],
                                                                                            min: 0,
                                                                                            max: 1,
                                                                                            step: 0.01,
                                                                                            value:
                                                                                              c,
                                                                                            onChange:
                                                                                              (
                                                                                                t,
                                                                                              ) =>
                                                                                                He(
                                                                                                  e.id,
                                                                                                  n,
                                                                                                  Number(
                                                                                                    t
                                                                                                      .target
                                                                                                      .value,
                                                                                                  ),
                                                                                                ),
                                                                                            style:
                                                                                              {
                                                                                                "--volume": `${c * 100}%`,
                                                                                              },
                                                                                          },
                                                                                        ),
                                                                                      ],
                                                                                  },
                                                                                ),
                                                                                (0,
                                                                                J.jsx)(
                                                                                  `audio`,
                                                                                  {
                                                                                    ref: (
                                                                                      e,
                                                                                    ) =>
                                                                                      ze(
                                                                                        r,
                                                                                        e,
                                                                                      ),
                                                                                    src: t,
                                                                                    preload: `metadata`,
                                                                                  },
                                                                                ),
                                                                              ],
                                                                          },
                                                                          r,
                                                                        );
                                                                      },
                                                                    ),
                                                                },
                                                              ),
                                                            ],
                                                          },
                                                        ),
                                                        color: `#fff`,
                                                        placement: `bottom`,
                                                        overlayInnerStyle: {
                                                          padding: 0,
                                                          borderRadius: 8,
                                                        },
                                                        overlayStyle: {
                                                          maxWidth: 580,
                                                        },
                                                        destroyTooltipOnHide:
                                                          !0,
                                                        children: (0, J.jsx)(
                                                          `div`,
                                                          {
                                                            className:
                                                              Q[
                                                                `segment-thumbnail-placeholder`
                                                              ],
                                                            children: (0,
                                                            J.jsx)(re, {}),
                                                          },
                                                        ),
                                                      })
                                                    : null,
                                              (0, J.jsx)(`div`, {
                                                className: Q[`segment-content`],
                                                children: (0, J.jsx)(`div`, {
                                                  className:
                                                    Q[`segment-preview`],
                                                  children: At(
                                                    Ot(e.content, !!e.expanded),
                                                    C,
                                                    Q[`sensitive-word`],
                                                  ),
                                                }),
                                              }),
                                            ],
                                          }),
                                          (0, J.jsxs)(`div`, {
                                            className: Q[`segment-card-footer`],
                                            children: [
                                              (0, J.jsx)(`img`, {
                                                src: `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/${oe && W.includes(`.${oe}`) ? `video-icon.png` : `audio-icon.png`}`,
                                                alt:
                                                  oe && W.includes(`.${oe}`)
                                                    ? `视频`
                                                    : `音频`,
                                                className:
                                                  Q[`footer-file-icon`],
                                              }),
                                              (0, J.jsx)(p.Text, {
                                                className:
                                                  Q[`segment-file-name`],
                                                children: ae,
                                              }),
                                            ],
                                          }),
                                        ],
                                      },
                                      e.id,
                                    ),
                                  ),
                          }),
                      (0, J.jsx)(`div`, { ref: b, className: Q.sentinel }),
                      y &&
                        (0, J.jsx)(`div`, {
                          className: `global-text-center ${Q[`loading-block-small`]}`,
                          children: (0, J.jsxs)(p.Text, {
                            type: `secondary`,
                            children: [(0, J.jsx)(A, { spin: !0 }), ` 加载中`],
                          }),
                        }),
                    ],
                  }),
            ],
          }),
          (0, J.jsx)(jt, {
            open: w,
            detailSegment: D,
            detailIndex: E,
            totalCount: g.length,
            editing: ee,
            editingContent: k,
            saving: te,
            readonly: r,
            handleCloseDetail: Se,
            handleStartEdit: ge,
            handleCancelEdit: _e,
            setEditingContent: ve,
            handleToggleStatus: (e) => void ye(e),
            handleStepDetail: he,
            handleSaveEdit: () => void xe(),
          }),
          (0, J.jsx)(be, {
            ref: M,
            docState: t?.docStatus,
            sensitiveWords: void 0,
            platformDisabled: !1,
          }),
          (0, J.jsx)(ne, {
            title: `视频预览`,
            open: we,
            onCancel: ke,
            width: 900,
            footer: null,
            destroyOnClose: !0,
            centered: !0,
            className: Q[`video-preview-modal`],
            children:
              U &&
              U.videoUrls.length > 0 &&
              (0, J.jsxs)(`div`, {
                className: Q[`video-preview-wrapper`],
                children: [
                  U.videoUrls.length > 1 &&
                    G > 0 &&
                    (0, J.jsx)(`div`, {
                      className: `${Q[`video-arrow`]} ${Q[`video-arrow-left`]}`,
                      onClick: () => Ae(`prev`),
                      children: (0, J.jsx)(O, {}),
                    }),
                  (0, J.jsxs)(`div`, {
                    className: Q[`video-player-container`],
                    children: [
                      (0, J.jsx)(
                        `video`,
                        {
                          ref: De,
                          controls: !0,
                          autoPlay: !0,
                          src: U.videoUrls[G],
                          children: `您的浏览器不支持视频播放`,
                        },
                        G,
                      ),
                      (0, J.jsx)(`div`, {
                        className: Q[`video-player-info`],
                        children: (0, J.jsxs)(m, {
                          children: [
                            (0, J.jsxs)(j, {
                              color: `blue`,
                              children: [
                                `分片 `,
                                G + 1,
                                ` /`,
                                ` `,
                                U.videoUrls.length,
                              ],
                            }),
                            (0, J.jsx)(j, {
                              color: `default`,
                              children: Dt(U.index),
                            }),
                            Y.has(`${U.id}-${G}`) &&
                              (0, J.jsxs)(j, {
                                color: `orange`,
                                children: [
                                  `时长`,
                                  ` `,
                                  Rt(Y.get(`${U.id}-${G}`)),
                                ],
                              }),
                          ],
                        }),
                      }),
                    ],
                  }),
                  U.videoUrls.length > 1 &&
                    G < U.videoUrls.length - 1 &&
                    (0, J.jsx)(`div`, {
                      className: `${Q[`video-arrow`]} ${Q[`video-arrow-right`]}`,
                      onClick: () => Ae(`next`),
                      children: (0, J.jsx)(T, {}),
                    }),
                ],
              }),
          }),
        ],
      });
    },
  ),
  $ = {
    "step4-wrapper": `_step4-wrapper_12gi9_2`,
    result: `_result_12gi9_11`,
    "result-title": `_result-title_12gi9_17`,
    actions: `_actions_12gi9_20`,
  };
v();
var Bt = (e, t) =>
    (e === 4 || e === 5 || e === 7) && t === we.Completed
      ? `success`
      : `processing`,
  Vt = (0, z.memo)(
    ({ docId: e, docDetail: t, baseId: n, baseName: r, getInfo: i }) => {
      let a = ge(),
        [o, s] = (0, z.useState)(!1),
        c = (0, z.useMemo)(
          () => (o ? `processing` : Bt(t?.step, t?.docStatus)),
          [o, t?.step, t?.docStatus],
        );
      ((0, z.useEffect)(() => {
        e && i?.();
      }, [e, i]),
        (0, z.useEffect)(() => {
          o && c !== `processing` && s(!1);
        }, [o, c]));
      let l = () => {
        a(R.AGENT_KNOWLEDGE_AUDIO_VIDEO, {
          state: { baseId: n, baseName: r || `音视频知识库` },
        });
      };
      return c === `processing`
        ? (0, J.jsx)(`div`, {
            className: $[`step4-wrapper`],
            children: (0, J.jsx)(k, {
              className: $.result,
              icon: (0, J.jsx)(w, { size: `large` }),
              title: (0, J.jsx)(p.Text, {
                strong: !0,
                className: $[`result-title`],
                children: `音视频发布中`,
              }),
              subTitle: `音视频资料正在处理并建立索引，完成后您可以在列表中找到它`,
            }),
          })
        : c === `fail`
          ? (0, J.jsx)(`div`, {
              className: $[`step4-wrapper`],
              children: (0, J.jsx)(k, {
                className: $.result,
                status: `error`,
                title: (0, J.jsx)(p.Text, {
                  strong: !0,
                  className: $[`result-title`],
                  children: `发布失败`,
                }),
                subTitle:
                  t?.step === 7
                    ? `音视频文档处理异常，无法发布，请返回列表`
                    : `音视频发布过程中出现异常，请稍后重试`,
                extra: (0, J.jsxs)(`div`, {
                  className: $.actions,
                  children: [
                    (0, J.jsx)(x, { onClick: l, children: `返回列表` }),
                    t?.step !== 7 &&
                      (0, J.jsx)(x, {
                        type: `primary`,
                        onClick: async () => {
                          if (e) {
                            if (t?.step === 7) {
                              M.info(`异常文档不支持重试发布`);
                              return;
                            }
                            (s(!0), (await Se(e))?.code === 0 ? i?.() : s(!1));
                          }
                        },
                        children: `重新发布`,
                      }),
                  ],
                }),
              }),
            })
          : (0, J.jsx)(`div`, {
              className: $[`step4-wrapper`],
              children: (0, J.jsx)(k, {
                className: $.result,
                status: `success`,
                title: (0, J.jsx)(p.Text, {
                  strong: !0,
                  className: $[`result-title`],
                  children: `音视频已发布`,
                }),
                subTitle: `音视频资料已成功发布，您可以在列表中找到它`,
                extra: (0, J.jsx)(`div`, {
                  className: $.actions,
                  children: (0, J.jsx)(x, {
                    type: `primary`,
                    onClick: l,
                    children: `前往音视频列表 →`,
                  }),
                }),
              }),
            });
    },
  ),
  Ht = {
    section: `_section_1g3dy_6`,
    "steps-wrapper": `_steps-wrapper_1g3dy_17`,
    tabs: `_tabs_1g3dy_54`,
  };
v();
var Ut = `audio_video_import`,
  Wt = 5 * 1e3,
  Gt = (e) => ({
    step: Number(e?.step ?? 0),
    docStatus: Number(e?.docStatus ?? we.Unprocessed),
  }),
  Kt = (e, t) =>
    e === 7
      ? !1
      : ([1, 2].includes(e) && t !== we.Completed) ||
        (e === 4 && [0, 1].includes(t)),
  qt = (e) =>
    e === 0
      ? V.Step2
      : [1, 2, 3, 4, 6, 7].includes(e ?? -1)
        ? V.Step3
        : e === 5
          ? V.Step4
          : V.Step1,
  Jt = () => {
    let e = ge(),
      t = me(),
      n = t.pathname,
      r = t.state ?? null,
      {
        docId: i,
        baseId: a,
        baseName: o,
        docIdList: s = [],
        step: c,
      } = r || {},
      l = (0, z.useRef)(null),
      u = (0, z.useRef)(null),
      d = (0, z.useRef)([]),
      f = (0, z.useRef)(!1),
      p = (0, z.useRef)(!1),
      m = (0, z.useRef)(!1),
      h = (0, z.useRef)(),
      g = (0, z.useRef)(!1),
      _ = (0, z.useRef)([]),
      v = (0, z.useRef)([]),
      [y, b] = (0, z.useState)(qt(c)),
      [x, S] = (0, z.useState)(!1),
      [C, w] = (0, z.useState)(!1),
      [T, E] = (0, z.useState)(!1),
      [D, ee] = (0, z.useState)({}),
      [O, k] = (0, z.useState)(i),
      [A, te] = (0, z.useState)(s),
      [j, re] = ne.useModal(),
      ie = D.step === 4,
      P = (0, z.useCallback)(
        async (e, t) => {
          let n = t || O;
          if (n) {
            (window.clearTimeout(h.current), S(!0));
            try {
              let { code: r, data: i } = await ve.queryBaseInfo(
                  { docId: n },
                  { _cancelToken: Ut },
                ),
                a = r === 0 && i ? { ...i } : null,
                { step: o, docStatus: s } = Gt(
                  a ?? e ?? { step: 4, docStatus: 1 },
                ),
                c = Kt(o, s);
              if (
                (m.current &&
                  ((c = ![5, 6, 7].includes(o)), c || (m.current = !1)),
                a && ee(a),
                A.length > 1 && [1, 2, 3, 4].includes(o))
              ) {
                let e = await ve.getDocListStatus({
                  docIds:
                    v.current.length > 0 ? v.current : A.map((e) => e.docId),
                });
                v.current = (e?.data || [])
                  .filter((e) => Gt(e).step !== 7)
                  .map((e) => String(e.docId));
                let t = (e) =>
                  m.current
                    ? [5, 6, 7].includes(e.step)
                    : !Kt(e.step, e.docStatus);
                c = !(
                  v.current.length === 0 ||
                  v.current.every((n) => {
                    let r = (e?.data || []).find((e) => String(e.docId) === n);
                    return r ? t(Gt(r)) : !0;
                  })
                );
              }
              if ((w(c), !c)) {
                S(!1);
                return;
              }
              if (g.current) {
                (w(!1), S(!1));
                return;
              }
              let l = { step: o, docStatus: s };
              h.current = setTimeout(() => {
                P(l, t);
              }, Wt);
            } catch (e) {
              (console.error(`获取音视频文档详情失败:`, e), w(!1), S(!1));
            }
          }
        },
        [O, A],
      ),
      F = (0, z.useCallback)(
        async (e) =>
          new Promise((t) => {
            j.confirm({
              title: `提示`,
              icon: (0, z.createElement)(N),
              width: 520,
              content: (0, z.createElement)(
                `div`,
                { style: { fontSize: 14, lineHeight: 1.6 } },
                e,
              ),
              okText: `确定发布`,
              cancelText: `取消`,
              onOk: (e) => {
                (e(), t(!0));
              },
              onCancel: () => t(!1),
            });
          }),
        [j],
      ),
      ae = (0, z.useCallback)(async () => {
        if (O) return !0;
        let e = await l.current?.send();
        return !e?.success || !e.ossResults?.length
          ? !1
          : ((d.current = e.ossResults), !0);
      }, [O]),
      oe = (0, z.useCallback)(async () => {
        if (O) return !0;
        let t = await u.current?.sendNext();
        if (!t?.success || !t.values) return !1;
        if (!d.current.length) return (M.error(`文件不存在，请重新上传`), !1);
        if (!a) return (M.error(`知识库 ID 不存在`), !1);
        let i = await ue({
          baseId: a,
          fileDetails: d.current.map((e) => ({
            ossKey: e.ossKey,
            fileName: e.fileName,
            totalSpace: e.size,
            ...t.values,
          })),
        });
        if (i.code !== 0) return (M.error(`创建文档记录失败`), !1);
        let o = (i.data?.docIds || []).map((e) => String(e)),
          s = o[0];
        if (!s) return (M.error(`创建文档记录失败`), !1);
        let c = o.map((e, t) => ({
          docId: e,
          docName: d.current[t]?.fileName || ``,
          suffix: d.current[t]?.fileName?.split(`.`).pop(),
        }));
        return (await ce({ docIds: o }))?.code === 0
          ? ((d.current = []),
            e(n, { state: { ...r, docId: s, docIdList: c }, replace: !0 }),
            te(c),
            k(s),
            !0)
          : !1;
      }, [a, O, e, n, r]),
      se = (0, z.useCallback)(async () => {
        S(!0);
        try {
          let e = !1;
          (y === V.Step1 ? (e = await ae()) : y === V.Step2 && (e = await oe()),
            e && b((e) => e + 1));
        } finally {
          S(!1);
        }
      }, [y, ae, oe]),
      le = (0, z.useCallback)(() => {
        b((e) => Math.max(V.Step1, e - 1));
      }, []),
      de = (0, z.useCallback)(async () => {
        if (!f.current) {
          if (!O) {
            M.info(`参数异常，请刷新或退出重试`);
            return;
          }
          f.current = !0;
          try {
            if (!(await F(`确定要发布吗？`))) return;
            ((p.current = !0), (m.current = !0));
            let e = () => {
              (b(V.Step4), (g.current = !1));
              let e = _.current.length > 0 ? _.current : A;
              (e.length > 0 && fe({ docIds: e.map((e) => e.docId) }), P());
            };
            S(!0);
            let t = A.length
              ? A
              : [{ docId: O, docName: String(D.docName ?? ``) }];
            if (A.length === 0) {
              if (D.step === 7) {
                (M.info(`异常文档不支持发布`), S(!1));
                return;
              }
              if (!(D.docStatus === 2 && [3, 6].includes(D.step ?? -1))) {
                (M.info(`文档尚未处理完成，无法发布`), S(!1));
                return;
              }
            }
            if (A.length > 0) {
              let e = await fe({ docIds: A.map((e) => e.docId) }),
                n = e.data;
              if (e.code === 0 && Array.isArray(n)) {
                let e = new Set(
                  n
                    .filter(
                      (e) =>
                        e.step !== 7 &&
                        e.docStatus === 2 &&
                        [3, 6].includes(e.step ?? -1),
                    )
                    .map((e) => String(e.docId)),
                );
                t = t.filter((t) => e.has(t.docId));
              } else t = [];
            }
            if (t.length === 0) {
              (M.info(`所有文档均为异常状态，无法发布`), S(!1));
              return;
            }
            _.current = t;
            let { code: n } = await Ce(O, !0, e, void 0, t);
            n === 0 && e();
          } finally {
            ((f.current = !1), S(!1));
          }
        }
      }, [F, D.docName, O, A, P]),
      pe = (0, z.useCallback)(() => {
        e(-1);
      }, [e]);
    return (
      (0, z.useEffect)(
        () => (
          L(O) || P(),
          () => {
            (window.clearTimeout(h.current), he.cancel(Ut));
          }
        ),
        [O],
      ),
      (0, z.useEffect)(() => {
        if (p.current) {
          p.current = !1;
          return;
        }
        if (m.current) return;
        let e = D.step;
        if (L(e)) {
          L(O) && b(V.Step1);
          return;
        }
        e === 0
          ? b(V.Step2)
          : [1, 2, 3, 4, 6, 7].includes(e)
            ? b(V.Step3)
            : [5].includes(e) && b(V.Step4);
      }, [D.step, O]),
      {
        step1Ref: l,
        step2Ref: u,
        current: y,
        loading: x,
        loop: C,
        readonly: ie,
        existFile: T,
        docId: O,
        baseId: a,
        baseName: o,
        docDetail: D,
        docIdList: A,
        handleFileChange: E,
        handleNextStep: se,
        handlePrevStep: le,
        handleCancel: pe,
        handleRelease: de,
        getInfo: P,
        setStopParentPolling: (e) => {
          g.current = e;
        },
        contextHolder: re,
      }
    );
  };
v();
var Yt = [
    { title: `音视频上传` },
    { title: `音视频分段选择` },
    { title: `内容审核` },
    { title: `处理并发布` },
  ],
  Xt = (0, z.memo)(() => {
    let {
        step1Ref: e,
        step2Ref: t,
        current: n,
        loading: r,
        existFile: i,
        docId: a,
        baseId: o,
        baseName: s,
        docDetail: c,
        docIdList: l,
        handleFileChange: u,
        handleNextStep: d,
        handlePrevStep: f,
        handleCancel: p,
        handleRelease: h,
        readonly: g,
        getInfo: _,
        setStopParentPolling: v,
        contextHolder: y,
      } = Jt(),
      [b, S] = (0, z.useState)(!1),
      w = (0, z.useMemo)(
        () => [
          {
            key: String(V.Step1),
            label: `音视频上传`,
            children: (0, J.jsx)(ht, {
              ref: e,
              docId: a,
              baseId: o,
              docDetail: c,
              onFileChange: u,
            }),
          },
          {
            key: String(V.Step2),
            label: `音视频分段选择`,
            children: (0, J.jsx)(Et, {
              ref: t,
              docId: a,
              docDetail: c,
              baseId: o,
            }),
          },
          {
            key: String(V.Step3),
            label: `内容审核`,
            children: (0, J.jsx)(zt, {
              docId: a,
              docDetail: c,
              docIdList: l,
              readonly: g,
              getInfo: _,
              setStopParentPolling: v,
              onReadyStateChange: S,
            }),
          },
          {
            key: String(V.Step4),
            label: `处理并发布`,
            children: (0, J.jsx)(Vt, {
              docId: a,
              docDetail: c,
              baseId: o,
              baseName: s,
              getInfo: _,
            }),
          },
        ],
        [o, s, c, a, l, _, v, u, e, t],
      ),
      T = (0, z.useMemo)(() => {
        if (n === V.Step4) return [];
        if (g)
          return [
            (0, J.jsx)(
              m,
              { children: (0, J.jsx)(x, { onClick: p, children: `取消` }) },
              `footer`,
            ),
          ];
        let e = n > V.Step1 && n !== V.Step3;
        return [
          (0, J.jsxs)(
            m,
            {
              children: [
                (0, J.jsx)(x, { onClick: p, children: `取消` }),
                e && (0, J.jsx)(x, { onClick: f, children: `上一步` }),
                [V.Step1, V.Step2].includes(n) &&
                  (0, J.jsx)(x, {
                    type: `primary`,
                    onClick: () => void d(),
                    loading: r,
                    disabled: n === V.Step1 && !i,
                    children: `下一步`,
                  }),
                n === V.Step3 &&
                  b &&
                  (0, J.jsx)(x, {
                    type: `primary`,
                    loading: r,
                    onClick: () => void h(),
                    children: `确认并发布`,
                  }),
              ],
            },
            `footer`,
          ),
        ];
      }, [n, g, i, p, d, f, h, r, b]);
    return (0, J.jsxs)(_e, {
      title: `知识导入`,
      showBack: !0,
      onBack: p,
      showFooter: T.length > 0,
      footerButtons: T,
      contentClassName: Ht.section,
      children: [
        (0, J.jsx)(`div`, {
          className: Ht[`steps-wrapper`],
          children: (0, J.jsx)(ee, { current: n, items: Yt }),
        }),
        (0, J.jsx)(C, {
          className: Ht.tabs,
          items: w,
          activeKey: String(n),
          renderTabBar: () => (0, J.jsx)(J.Fragment, {}),
        }),
        y,
      ],
    });
  });
export { Xt as default };
