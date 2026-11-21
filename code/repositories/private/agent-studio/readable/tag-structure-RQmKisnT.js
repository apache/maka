import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Br as r,
  K as i,
  Kt as a,
  Or as o,
  Vt as s,
  Yi as c,
  or as l,
  rr as u,
  yr as d,
} from "./vendor-antd.QfSgOu5e.js";
import {
  J as f,
  Tt as p,
  Y as m,
  a as h,
  j as g,
  ut as _,
} from "./index.B_LPe2F7.js";
import { t as v } from "./ListPage-Dda3HptU.js";
import { t as y } from "./structure.api-D1Wp2_Ly.js";
import { t as b } from "./components2-DnLGrzOm.js";
s();
var x = e(t(), 1),
  S = n(),
  C = () =>
    (0, S.jsxs)(S.Fragment, {
      children: [
        (0, S.jsx)(d.Item, {
          name: `structureName`,
          label: `名称`,
          rules: [
            h.required,
            h.whitespace,
            h.textReg,
            { type: `string`, max: 10, message: `最多可输入10个字符` },
            { type: `string`, min: 3, message: `至少输入3个字符` },
          ],
          children: (0, S.jsx)(r, {
            placeholder: `3-10字以内，支持中英文、数字、中/下划线`,
          }),
        }),
        (0, S.jsx)(d.Item, {
          name: `remark`,
          label: `描述`,
          rules: [
            h.whitespace,
            {
              type: `string`,
              max: 100,
              message: `已超限制字数，请删减后重新输入`,
            },
          ],
          children: (0, S.jsx)(r.TextArea, {
            className: `global-textarea-show-count`,
            placeholder: `请描述创建目的、修改内容等，100字以内`,
            showCount: { formatter: (e) => `${e?.count ?? 0}/100` },
            autoSize: { minRows: 6, maxRows: 8 },
          }),
        }),
      ],
    }),
  w = (e) => e.filter((e) => e.readOnly === 1).map((e) => `《${e.baseName}》`),
  T = (e, t) => {
    let n = Object.keys(e)[0];
    if (n) {
      let r = e[n];
      return { ...t, column: n, isAsc: r !== `descend` };
    }
    return t;
  };
s();
var E = () => {
  let e = (0, x.useRef)(),
    { pageButtonMap: t, update: n } = g(),
    { form: r, open: s } = _(),
    { state: d } = f(),
    h = (0, x.useRef)(null),
    E = m(),
    D = (0, x.useCallback)(async (e) => {
      let t = await y.getTableData(e);
      if (t.code === 0) {
        let { total: e, list: n } = t.data || {};
        return { data: n || [], success: !0, total: e || 0 };
      }
      return { data: [], success: !1, total: 0 };
    }, []),
    O = (0, x.useCallback)(
      async (t) => {
        n({ loading: !0 });
        try {
          let n = await y.getDeployDataBaseNames({
            structureId: String(t.structureId),
          });
          if (n.code === 0) {
            let r = w(n.data || []);
            if (r.length > 0) {
              l.warning({
                key: `readOnly`,
                content: `该标签体系中的标签，已经关联了知识库中已发布或发布中的文档，不允许删除。该标签体系关联的知识库：${r.join(`、`)}`,
                duration: 5,
              });
              return;
            }
            u.confirm({
              title: `删除`,
              icon: (0, S.jsx)(i, {}),
              content: (0, S.jsxs)(o, {
                direction: `vertical`,
                size: 12,
                children: [
                  (0, S.jsx)(a.Text, {
                    strong: !0,
                    children: `确定删除当前标签体系吗`,
                  }),
                  (0, S.jsx)(a.Text, {
                    type: `secondary`,
                    children: `删除标签体系是不可逆的，请谨慎操作。删除后，所关联的子节点标签也同步删除，且知识库中文档绑定的相关标签会全部删除。`,
                  }),
                ],
              }),
              okText: `确认`,
              cancelText: `取消`,
              onOk: () =>
                y
                  .delete({ structureId: String(t.structureId) })
                  .then(
                    (t) => (
                      t.code === 0 &&
                        (l.success(`删除成功`), e.current?.reset?.()),
                      t
                    ),
                  ),
            });
          }
        } finally {
          n({ loading: !1 });
        }
      },
      [n],
    ),
    k = (0, x.useCallback)(
      (t) => {
        s(
          {
            title: t ? `编辑知识体系` : `创建知识体系`,
            onOk: (e) =>
              t ? ((e.structureId = t.structureId), y.update(e)) : y.create(e),
            successTip: t ? `更新成功` : `创建成功`,
            children: (0, S.jsx)(C, {}),
            formConfig: { labelCol: { style: { minWidth: `80px` } } },
            callback: () => {
              e.current?.reset?.();
            },
          },
          () => {
            t && r.setFieldsValue(t);
          },
        );
      },
      [r, s],
    ),
    A = (0, x.useCallback)(async (e, t) => D(T(t, e)), [D]);
  (0, x.useEffect)(() => {
    (typeof h.current != `boolean` && (h.current = !!d?.openModal),
      h.current && k(),
      d?.openModal &&
        E(p.AGENT_KNOWLEDGE_TAG_STRUCTURE, {
          state: { openModal: !1 },
          replace: !0,
        }));
  }, [E, k, d?.openModal]);
  let j = (0, x.useMemo)(
    () => [
      {
        dataIndex: `structureName`,
        width: 180,
        title: `体系名称`,
        ellipsis: !0,
      },
      {
        dataIndex: `remark`,
        title: `描述`,
        width: 180,
        hideInSearch: !0,
        ellipsis: !0,
      },
      {
        dataIndex: `createTime`,
        title: `创建时间`,
        hideInSearch: !0,
        width: 180,
        sorter: !0,
      },
      {
        dataIndex: `modifyTime`,
        title: `更新时间`,
        hideInSearch: !0,
        width: 180,
        sorter: !0,
      },
      {
        dataIndex: `option`,
        title: `操作`,
        valueType: `option`,
        width: 150,
        fixed: `right`,
        hideInTable: !(t[1135] || t[1136]),
        actionButtons: (e) => [
          { menuCode: `1135`, key: `1135`, label: `编辑`, onClick: () => k(e) },
          { menuCode: `1136`, key: `1136`, label: `删除`, onClick: () => O(e) },
        ],
      },
    ],
    [t, k, O],
  );
  return (0, S.jsx)(v, {
    title: `标签体系`,
    showBack: !0,
    extra: (0, x.useMemo)(
      () => [
        (0, S.jsx)(
          b,
          {
            menuCode: `1133`,
            children: (0, S.jsx)(c, {
              type: `primary`,
              onClick: () => k(),
              children: `+ 创建知识体系`,
            }),
          },
          `1133`,
        ),
      ],
      [k],
    ),
    columns: j,
    rowKey: `structureId`,
    actionRef: e,
    pagination: { defaultPageSize: 10 },
    tableProps: { request: A, form: { initialValues: { status: 0 } } },
  });
};
export { E as default };
