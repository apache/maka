import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  K as r,
  Vt as i,
  Yi as a,
  nn as o,
  or as s,
  rr as c,
} from "./vendor-antd.QfSgOu5e.js";
import { t as l } from "./dateUtils-BwspljNz.js";
import { r as u } from "./fileUtils-BjWnOXhL.js";
import { c as d } from "./knowledge-B15iS6D5.js";
import { t as f } from "./AgentTable-DMLUccn2.js";
import { D as p, J as m, Tt as h, Y as g } from "./index.B_LPe2F7.js";
import { t as _ } from "./ListLayout-B8lj_6O3.js";
import { t as v } from "./doc.api-VLu_TcYx.js";
import { t as y } from "./onDeployConfirm-LfJr7a5N.js";
import {
  a as b,
  i as x,
  n as S,
  o as C,
  r as w,
  t as T,
} from "./utils-Diwvqo7L.js";
var E = e(t(), 1);
i();
var D = {
    "search-select": `_search-select_1u0by_2`,
    "doc-name-cell": `_doc-name-cell_1u0by_6`,
    "doc-name-icon": `_doc-name-icon_1u0by_11`,
    "status-dot": `_status-dot_1u0by_16`,
    dot: `_dot_1u0by_21`,
    "dot-with-shadow": `_dot-with-shadow_1u0by_28`,
    "status-text": `_status-text_1u0by_36`,
  },
  O = n(),
  k = ({
    handleViewEdit: e,
    handlePublish: t,
    handleDownload: n,
    handleOffline: r,
    handleDelete: i,
  }) => [
    {
      hideInTable: !0,
      title: `文档名称`,
      dataIndex: `docName`,
      ellipsis: !0,
      fieldProps: { placeholder: `请输入` },
    },
    {
      hideInTable: !0,
      title: `文档类型`,
      dataIndex: `docType`,
      valueType: `select`,
      fieldProps: {
        options: [
          { label: `全部`, value: `` },
          { label: `音频`, value: C.AUDIO },
          { label: `视频`, value: C.VIDEO },
        ],
        allowClear: !1,
        className: D[`search-select`],
      },
    },
    {
      hideInTable: !0,
      title: `状态`,
      dataIndex: `status`,
      valueType: `select`,
      fieldProps: {
        options: [
          { label: `全部`, value: `` },
          { label: `审核中`, value: b.REVIEWING },
          { label: `发布中`, value: b.PUBLISHING },
          { label: `已发布`, value: b.PUBLISHED },
          { label: `已下架`, value: b.OFFLINE },
          { label: `异常`, value: b.ERROR },
        ],
        allowClear: !1,
        className: D[`search-select`],
      },
    },
    {
      title: `文档名称`,
      dataIndex: `docName`,
      width: 220,
      ellipsis: !0,
      hideInSearch: !0,
      render: (e, t) =>
        (0, O.jsxs)(`span`, {
          className: D[`doc-name-cell`],
          children: [
            (0, O.jsx)(`img`, {
              src: `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/${t.docType === C.AUDIO ? `audio-icon.svg` : `video-icon.svg`}`,
              alt: t.docType === C.AUDIO ? `音频` : `视频`,
              className: D[`doc-name-icon`],
            }),
            t.docName,
          ],
        }),
    },
    {
      title: `文档类型`,
      dataIndex: `docType`,
      width: 100,
      hideInSearch: !0,
      render: (e, t) => {
        let n = t.docType === C.AUDIO;
        return (0, O.jsx)(o, {
          color: n ? `orange` : `blue`,
          children: n ? `音频` : `视频`,
        });
      },
    },
    {
      title: `文件大小`,
      dataIndex: `fileSize`,
      width: 100,
      hideInSearch: !0,
      render: (e, t) => S(t.fileSize),
    },
    {
      title: `上传时间`,
      dataIndex: `createTime`,
      width: 180,
      hideInSearch: !0,
      render: (e, t) => l(t.createTime, `YYYY-MM-DD HH:mm:ss`),
    },
    {
      title: `最新编辑`,
      dataIndex: `modifyTime`,
      width: 180,
      hideInSearch: !0,
      render: (e, t) => l(t.modifyTime, `YYYY-MM-DD HH:mm:ss`),
    },
    {
      title: `状态`,
      dataIndex: `status`,
      width: 120,
      hideInSearch: !0,
      render: (e, t) => {
        let n = T[t.status];
        if (!n) return `-`;
        let r = !!n.shadowColor;
        return (0, O.jsxs)(`span`, {
          className: D[`status-dot`],
          style: { "--status-text-color": n.textColor },
          children: [
            (0, O.jsx)(`span`, {
              className: r ? D[`dot-with-shadow`] : D.dot,
              style: {
                backgroundColor: n.dotColor,
                ...(r ? { "--shadow-color": n.shadowColor } : {}),
              },
            }),
            (0, O.jsx)(`span`, {
              className: D[`status-text`],
              children: n.label,
            }),
          ],
        });
      },
    },
    {
      title: `异常信息`,
      dataIndex: `errorMsg`,
      width: 180,
      ellipsis: !0,
      hideInSearch: !0,
      render: (e, t) => t.errorMsg || `-`,
    },
    {
      title: `操作`,
      valueType: `option`,
      width: 280,
      fixed: `right`,
      actionButtonsMax: 2,
      actionButtons: (a) => {
        let o = a.status === b.PUBLISHING,
          s = a.status === b.PUBLISHED,
          c = a.status === b.ERROR,
          l = a.status === b.REVIEWING || a.status === b.COMPLETED,
          u = a.status === b.OFFLINE,
          d = a.status === b.REVIEWING,
          f = l || u,
          m = [];
        return (
          m.push({
            key: `viewEdit`,
            menuCode: p.AUDIO_VIDEO_KNOWLEDGE_VIEW_EDIT,
            label: `查看与编辑`,
            disabled: o,
            onClick: () => e(a),
          }),
          s ||
            (f || c
              ? m.push({
                  key: `publish`,
                  menuCode: p.AUDIO_VIDEO_KNOWLEDGE_RELEASE,
                  label: u ? `重新发布` : `发布`,
                  disabled: c,
                  onClick: () => t(a),
                })
              : m.push({
                  key: `publish`,
                  menuCode: p.AUDIO_VIDEO_KNOWLEDGE_RELEASE,
                  label: `发布`,
                  disabled: !0,
                  onClick: () => {},
                })),
          m.push({
            key: `download`,
            menuCode: p.AUDIO_VIDEO_KNOWLEDGE_DOWNLOAD,
            label: `下载`,
            onClick: () => n(a),
          }),
          s &&
            m.push({
              key: `offline`,
              menuCode: p.AUDIO_VIDEO_KNOWLEDGE_REMOVE,
              label: `下架`,
              onClick: () => r(a),
            }),
          (s || d || u || c) &&
            m.push({
              key: `delete`,
              menuCode: p.AUDIO_VIDEO_KNOWLEDGE_DELETE,
              label: `删除`,
              disabled: s,
              onClick: () => i(a),
            }),
          m
        );
      },
    },
  ];
i();
var A = 8 * 1e3,
  j = (0, E.memo)(({ baseId: e }) => {
    let t = g(),
      n = (0, E.useRef)(),
      [i, a] = (0, E.useState)(!1),
      o = (0, E.useRef)(!1),
      l = (0, E.useRef)(null),
      p = (0, E.useCallback)(() => {
        ((o.current = !1), n.current?.reload());
      }, []),
      m = (0, E.useCallback)(
        async (t) => {
          let { docName: r, docType: i, status: s } = t;
          (l.current && window.clearTimeout(l.current), o.current || a(!0));
          let c = await d({ baseId: String(e ?? ``), name: r, status: w(s) }),
            u = [],
            f = !1;
          return (
            c.code === 0
              ? ((u = (c.data || []).map((e, t) => x(e, t))),
                i && (u = u.filter((e) => e.docType === i)),
                (f = u.some((e) => e.status === b.PUBLISHING)))
              : (f = o.current),
            f &&
              (l.current = setTimeout(() => {
                ((o.current = !0), n.current?.reload());
              }, A)),
            a(!1),
            { data: u, success: !0, total: u.length }
          );
        },
        [e],
      ),
      _ = (0, E.useCallback)(
        async (n) => {
          a(!0);
          try {
            let { code: r, data: i } = await v.queryBaseInfo(
                { docId: n.docId },
                { _hidden: !0 },
              ),
              a = r === 0 ? i?.step : void 0;
            t(h.AGENT_KNOWLEDGE_AUDIO_VIDEO_EDIT, {
              state: {
                baseId: e,
                docId: n.docId,
                docName: n.docName,
                docType: n.docType,
                status: n.status,
                step: a,
              },
            });
          } catch {
            t(h.AGENT_KNOWLEDGE_AUDIO_VIDEO_EDIT, {
              state: {
                baseId: e,
                docId: n.docId,
                docName: n.docName,
                docType: n.docType,
                status: n.status,
              },
            });
          } finally {
            a(!1);
          }
        },
        [t, e],
      ),
      S = (0, E.useCallback)(
        (n) => {
          c.confirm({
            title: `提示`,
            icon: (0, O.jsx)(r, {}),
            content: `确定要发布吗？`,
            onOk: async () => {
              (
                await y(
                  n.docId,
                  !0,
                  p,
                  () => {
                    t(h.AGENT_KNOWLEDGE_AUDIO_VIDEO_EDIT, {
                      state: {
                        baseId: e,
                        docId: n.docId,
                        docName: n.docName,
                        docType: n.docType,
                        status: n.status,
                      },
                    });
                  },
                  [{ docId: n.docId, docName: n.docName }],
                )
              )?.code === 0 && p();
            },
          });
        },
        [t, e, p],
      ),
      C = (0, E.useCallback)(async (e) => {
        try {
          u((await v.queryLoadFile({ docId: e.docId }, {})).data, e.docName);
        } catch (e) {
          (console.error(`下载失败:`, e), s.error(`下载失败，请重试`));
        }
      }, []),
      T = (0, E.useCallback)(
        (e) => {
          c.confirm({
            title: `确认要下架该知识吗？`,
            icon: (0, O.jsx)(r, {}),
            content: `下架后该内容将不再被检索召回，但原始文件仍保留。`,
            okText: `确定`,
            cancelText: `取消`,
            onOk: async () => {
              (await v.unline({ docId: e.docId })).code === 0 &&
                (s.success(`下架成功`), p());
            },
          });
        },
        [p],
      ),
      D = (0, E.useCallback)(
        (e) => {
          c.confirm({
            title: `确认要删除该知识吗？`,
            icon: (0, O.jsx)(r, {}),
            content: `删除后不能恢复，需谨慎操作！`,
            okText: `确定`,
            cancelText: `取消`,
            onOk: async () => {
              (await v.delete({ docId: e.docId })).code === 0 &&
                (s.success(`删除成功`), p());
            },
          });
        },
        [p],
      ),
      j = (0, E.useMemo)(
        () =>
          k({
            handleViewEdit: _,
            handlePublish: S,
            handleDownload: C,
            handleOffline: T,
            handleDelete: D,
          }),
        [_, S, C, T, D],
      );
    return (
      (0, E.useEffect)(
        () => () => {
          l.current && window.clearTimeout(l.current);
        },
        [],
      ),
      (0, O.jsx)(f, {
        actionRef: n,
        rowKey: `docId`,
        columns: j,
        request: m,
        loading: i,
        scrollY: { type: `flex` },
        options: { reload: !1 },
      })
    );
  });
i();
var M = (0, E.memo)(() => {
  let e = g(),
    { state: t } = m(),
    { baseName: n = `音视频知识库`, baseId: r } = t || {};
  return (0, O.jsx)(_, {
    mode: `list`,
    title: n,
    showBack: !0,
    extra: (0, O.jsx)(a, {
      type: `primary`,
      onClick: () =>
        e(h.AGENT_KNOWLEDGE_AUDIO_VIDEO_EDIT, {
          state: { baseId: r, baseName: n },
        }),
      children: `知识导入`,
    }),
    onBack: () => e(h.AGENT_KNOWLEDGE),
    children: (0, O.jsx)(j, { baseId: r }),
  });
});
export { M as default };
