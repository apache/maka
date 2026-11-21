import { i as e, n as t, r as n } from "./agent-C0JAlTor.js";
var r = (function (e) {
    return (
      (e[(e.DISABLE = 0)] = `DISABLE`),
      (e[(e.ENABLE = 1)] = `ENABLE`),
      (e[(e.DELETE = 2)] = `DELETE`),
      e
    );
  })({}),
  i = (function (e) {
    return (
      (e[(e.READ_WRITE_DELETE = 0)] = `READ_WRITE_DELETE`),
      (e[(e.READ_WRITE = 1)] = `READ_WRITE`),
      (e[(e.READ_ONLY = 2)] = `READ_ONLY`),
      e
    );
  })({}),
  a = {
    OK: `#52C41A`,
    ERROR: `#F5222D`,
    WARNING: `#FAAD14`,
    REJECTED: `#D32029`,
  },
  o = {
    OK: `#E6FFFB`,
    ERROR: `#FFF1F0`,
    WARNING: `#FFF7E6`,
    REJECTED: `#FFF1F0`,
  },
  s = [
    { label: `启用`, value: r.ENABLE, color: a.OK },
    { label: `禁用`, value: r.DISABLE, color: a.ERROR },
  ],
  c = [
    {
      label: `未发布`,
      value: t.NOT_RELEASED,
      color: a.ERROR,
      backgroundColor: o.ERROR,
    },
    {
      label: `审核中`,
      value: t.UNDER_REVIEW,
      color: a.WARNING,
      backgroundColor: o.WARNING,
    },
    { label: `已发布`, value: t.RELEASED, color: a.OK, backgroundColor: o.OK },
    {
      label: `已驳回`,
      value: t.REJECTED,
      color: a.REJECTED,
      backgroundColor: o.REJECTED,
    },
  ],
  l = [
    { label: `智能体`, value: n.AGENT, key: e.AGENT, disabled: !0 },
    { label: `工作流`, value: n.WORKFLOW, key: e.WORKFLOW, disabled: !1 },
    { label: `对话型`, value: n.DIALOGUE, key: e.DIALOGUE, disabled: !1 },
    { label: `工具型`, value: n.TOOL, key: e.TOOL, disabled: !1 },
    { label: `任务型`, value: n.TASK, key: e.TASK, disabled: !1 },
    {
      label: `超级智能体`,
      value: n.SUPER_AGENT,
      key: e.SUPER_AGENT,
      disabled: !1,
    },
  ],
  u = { [r.ENABLE]: a.OK, [r.DISABLE]: a.ERROR, [r.DELETE]: a.WARNING };
export { i as a, c as i, u as n, r as o, s as r, l as t };
