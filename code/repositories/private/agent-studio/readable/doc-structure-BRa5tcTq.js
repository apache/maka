import { o as e, t } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as n, t as r } from "./vendor-react.CV1S_bb1.js";
import {
  A as i,
  Ar as a,
  Er as o,
  Hi as s,
  Ii as c,
  Kt as l,
  Or as u,
  Pi as d,
  R as f,
  Vt as p,
  Yi as m,
  cn as h,
  dr as g,
  hn as _,
  or as v,
  yr as y,
} from "./vendor-antd.QfSgOu5e.js";
import { c as ee } from "./src-_hjT3BN9.js";
import { J as b, a as x, ut as te } from "./index.B_LPe2F7.js";
import { t as ne } from "./DetailLayout-139jNxZs.js";
import { t as re } from "./structure.api-D1Wp2_Ly.js";
import { t as ie } from "./database.api-D6ax5Omz.js";
p();
var S = e(n(), 1),
  C = r();
function ae({ currentStructureId: e }) {
  let [t, n] = (0, S.useState)([]),
    [r, i] = (0, S.useState)(!1),
    a = async () => {
      i(!0);
      try {
        let { code: e, data: t } = await re.getList();
        e === 0 && n(t || []);
      } finally {
        i(!1);
      }
    };
  (0, S.useEffect)(() => {
    a();
  }, []);
  let o = (0, S.useMemo)(
    () =>
      t.map(({ structureId: t, structureName: n }) => ({
        label:
          e === t
            ? (0, C.jsxs)(C.Fragment, { children: [n, `（当前标签体系）`] })
            : n,
        value: t,
        disabled: e === t,
      })),
    [e, t],
  );
  return (0, C.jsxs)(g, {
    spinning: r,
    children: [
      (0, C.jsx)(y.Item, {
        label: `标签体系`,
        name: `structureId`,
        rules: x.default.select,
        children: (0, C.jsx)(c, {
          placeholder: `请选择`,
          allowClear: !0,
          options: o,
          getPopupContainer: () => document.body,
          showSearch: !0,
          showArrow: !0,
          optionFilterProp: `label`,
        }),
      }),
      (0, C.jsxs)(l.Paragraph, {
        children: [
          (0, C.jsx)(l.Text, { type: `danger`, children: `注：` }),
          (0, C.jsx)(l.Text, {
            type: `secondary`,
            children: `知识标签体系应用是不可逆的，请谨慎操作。应用后，现有标签体系会被删除，对应知识库中文档绑定的相关标签会全部删除。`,
          }),
        ],
      }),
    ],
  });
}
var oe = (0, S.memo)(ae),
  se = {
    wrapper: `_wrapper_1diib_1`,
    "delete-tip": `_delete-tip_1diib_4`,
    "body-wrapper": `_body-wrapper_1diib_12`,
    header: `_header_1diib_24`,
    body: `_body_1diib_12`,
    "body-nodata": `_body-nodata_1diib_41`,
    "mind-map": `_mind-map_1diib_52`,
    "contextmenu-container": `_contextmenu-container_1diib_57`,
  };
p();
var ce = (0, S.memo)(
    (0, S.forwardRef)((e, t) => {
      let [n, r] = (0, S.useState)(!1),
        [i, o] = (0, S.useState)({}),
        s = (e) => {
          (o(e), r(!0));
        },
        c = () => {
          r(!1);
        },
        l = (0, S.useMemo)(() => {
          if (JSON.stringify(i) === `{}` || !i) return [];
          let e = [i],
            t = (e) => {
              for (let n = 0; n < e.length; n++) {
                let { text: r, uid: i } = e[n].data;
                ((e[n].title = r),
                  (e[n].key = i),
                  e[n]?.children?.length && t(e[n].children));
              }
            };
          return (t(e), e);
        }, [i]);
      return (
        (0, S.useImperativeHandle)(t, () => ({ open: s })),
        (0, C.jsx)(a, {
          open: n,
          title: `大纲`,
          className: se.drawer,
          onClose: c,
          children: (0, C.jsx)(h, {
            treeData: l,
            defaultExpandAll: !0,
            showLine: !0,
          }),
        })
      );
    }),
  ),
  w = {
    CHANGE_THEME: `changeTheme`,
    CHANGE_LAYOUT: `changeLayout`,
    MODE: { READONLY: `readonly`, EDIT: `edit` },
    LAYOUT: {
      LOGICAL_STRUCTURE: `logicalStructure`,
      LOGICAL_STRUCTURE_LEFT: `logicalStructureLeft`,
      MIND_MAP: `mindMap`,
      ORGANIZATION_STRUCTURE: `organizationStructure`,
      CATALOG_ORGANIZATION: `catalogOrganization`,
      TIMELINE: `timeline`,
      TIMELINE2: `timeline2`,
      FISHBONE: `fishbone`,
      FISHBONE2: `fishbone2`,
      RIGHT_FISHBONE: `rightFishbone`,
      RIGHT_FISHBONE2: `rightFishbone2`,
      VERTICAL_TIMELINE: `verticalTimeline`,
      VERTICAL_TIMELINE2: `verticalTimeline2`,
      VERTICAL_TIMELINE3: `verticalTimeline3`,
    },
    DIR: { UP: `up`, LEFT: `left`, DOWN: `down`, RIGHT: `right` },
    KEY_DIR: { LEFT: `Left`, UP: `Up`, RIGHT: `Right`, DOWN: `Down` },
    SHAPE: {
      RECTANGLE: `rectangle`,
      DIAMOND: `diamond`,
      PARALLELOGRAM: `parallelogram`,
      ROUNDED_RECTANGLE: `roundedRectangle`,
      OCTAGONAL_RECTANGLE: `octagonalRectangle`,
      OUTER_TRIANGULAR_RECTANGLE: `outerTriangularRectangle`,
      INNER_TRIANGULAR_RECTANGLE: `innerTriangularRectangle`,
      ELLIPSE: `ellipse`,
      CIRCLE: `circle`,
    },
    MOUSE_WHEEL_ACTION: { ZOOM: `zoom`, MOVE: `move` },
    INIT_ROOT_NODE_POSITION: {
      LEFT: `left`,
      TOP: `top`,
      RIGHT: `right`,
      BOTTOM: `bottom`,
      CENTER: `center`,
    },
    LAYOUT_GROW_DIR: {
      LEFT: `left`,
      TOP: `top`,
      RIGHT: `right`,
      BOTTOM: `bottom`,
    },
    PASTE_TYPE: { CLIP_BOARD: `clipBoard`, CANVAS: `canvas` },
    SCROLL_BAR_DIR: { VERTICAL: `vertical`, HORIZONTAL: `horizontal` },
    CREATE_NEW_NODE_BEHAVIOR: {
      DEFAULT: `default`,
      NOT_ACTIVE: `notActive`,
      ACTIVE_ONLY: `activeOnly`,
    },
    TAG_PLACEMENT: { RIGHT: `right`, BOTTOM: `bottom` },
    IMG_PLACEMENT: {
      LEFT: `left`,
      TOP: `top`,
      RIGHT: `right`,
      BOTTOM: `bottom`,
    },
  },
  le = {
    [w.INIT_ROOT_NODE_POSITION.LEFT]: 0,
    [w.INIT_ROOT_NODE_POSITION.TOP]: 0,
    [w.INIT_ROOT_NODE_POSITION.RIGHT]: 1,
    [w.INIT_ROOT_NODE_POSITION.BOTTOM]: 1,
    [w.INIT_ROOT_NODE_POSITION.CENTER]: 0.5,
  };
(w.LAYOUT.LOGICAL_STRUCTURE,
  w.LAYOUT.LOGICAL_STRUCTURE_LEFT,
  w.LAYOUT.MIND_MAP,
  w.LAYOUT.ORGANIZATION_STRUCTURE,
  w.LAYOUT.CATALOG_ORGANIZATION,
  w.LAYOUT.TIMELINE,
  w.LAYOUT.TIMELINE2,
  w.LAYOUT.VERTICAL_TIMELINE,
  w.LAYOUT.VERTICAL_TIMELINE2,
  w.LAYOUT.VERTICAL_TIMELINE3,
  w.LAYOUT.FISHBONE,
  w.LAYOUT.FISHBONE2,
  w.LAYOUT.RIGHT_FISHBONE,
  w.LAYOUT.RIGHT_FISHBONE2);
var ue = [
    w.LAYOUT.LOGICAL_STRUCTURE,
    w.LAYOUT.LOGICAL_STRUCTURE_LEFT,
    w.LAYOUT.MIND_MAP,
    w.LAYOUT.CATALOG_ORGANIZATION,
    w.LAYOUT.ORGANIZATION_STRUCTURE,
    w.LAYOUT.TIMELINE,
    w.LAYOUT.TIMELINE2,
    w.LAYOUT.VERTICAL_TIMELINE,
    w.LAYOUT.VERTICAL_TIMELINE2,
    w.LAYOUT.VERTICAL_TIMELINE3,
    w.LAYOUT.FISHBONE,
    w.LAYOUT.FISHBONE2,
    w.LAYOUT.RIGHT_FISHBONE,
    w.LAYOUT.RIGHT_FISHBONE2,
  ],
  de =
    `text.image.imageTitle.imageSize.icon.tag.hyperlink.hyperlinkTitle.note.expand.isActive.generalization.richText.resetRichText.uid.activeStyle.associativeLineTargets.associativeLineTargetControlOffsets.associativeLinePoint.associativeLineText.attachmentUrl.attachmentName.notation.outerFrame.number.range.customLeft.customTop.customTextWidth.checkbox.dir.needUpdate.imgMap.nodeLink`.split(
      `.`,
    ),
  fe = {
    READ_CLIPBOARD_ERROR: `read_clipboard_error`,
    PARSE_PASTE_DATA_ERROR: `parse_paste_data_error`,
    CUSTOM_HANDLE_CLIPBOARD_TEXT_ERROR: `custom_handle_clipboard_text_error`,
    LOAD_CLIPBOARD_IMAGE_ERROR: `load_clipboard_image_error`,
    BEFORE_TEXT_EDIT_ERROR: `before_text_edit_error`,
    EXPORT_ERROR: `export_error`,
    EXPORT_LOAD_IMAGE_ERROR: `export_load_image_error`,
    DATA_CHANGE_DETAIL_EVENT_ERROR: `data_change_detail_event_error`,
  },
  pe = `
  /* 鼠标hover和激活时渲染的矩形 */
  .smm-hover-node{
    display: none;
    opacity: 0.6;
    stroke-width: 1;
  }

  .smm-node:not(.smm-node-dragging):hover .smm-hover-node{
    display: block;
  }

  .smm-node.active .smm-hover-node, .smm-node-highlight .smm-hover-node{
    display: block;
    opacity: 1;
    stroke-width: 2;
  }

  .smm-text-node-wrap, .smm-expand-btn-text {
    user-select: none;
  }
`,
  T = 1.2,
  me = [
    `fontFamily`,
    `fontSize`,
    `fontWeight`,
    `fontStyle`,
    `textDecoration`,
    `color`,
    `textAlign`,
  ],
  he = class {
    constructor(e = {}) {
      ((this.opt = e),
        (this.mindMap = this.opt.mindMap),
        (this.scale = 1),
        (this.sx = 0),
        (this.sy = 0),
        (this.x = 0),
        (this.y = 0),
        (this.firstDrag = !0),
        this.setTransformData(this.mindMap.opt.viewData),
        this.bind());
    }
    bind() {
      (this.mindMap.keyCommand.addShortcut(`Control+=`, () => {
        this.enlarge();
      }),
        this.mindMap.keyCommand.addShortcut(`Control+-`, () => {
          this.narrow();
        }),
        this.mindMap.keyCommand.addShortcut(`Control+i`, () => {
          this.fit();
        }),
        this.mindMap.event.on(`mousedown`, (e) => {
          let { isDisableDrag: t, mousedownEventPreventDefault: n } =
            this.mindMap.opt;
          t ||
            (n && e.preventDefault(), (this.sx = this.x), (this.sy = this.y));
        }),
        this.mindMap.event.on(`drag`, (e, t) => {
          e.ctrlKey ||
            e.metaKey ||
            this.mindMap.opt.isDisableDrag ||
            (this.firstDrag &&
              ((this.firstDrag = !1),
              this.mindMap.renderer.activeNodeList.length > 0 &&
                this.mindMap.execCommand(`CLEAR_ACTIVE_NODE`)),
            (this.x = this.sx + t.mousemoveOffset.x),
            (this.y = this.sy + t.mousemoveOffset.y),
            this.transform());
        }),
        this.mindMap.event.on(`mouseup`, () => {
          this.firstDrag = !0;
        }),
        this.mindMap.event.on(`mousewheel`, (e, t, n, r) => {
          let {
            customHandleMousewheel: i,
            mousewheelAction: a,
            mouseScaleCenterUseMousePosition: o,
            mousewheelMoveStep: s,
            mousewheelZoomActionReverse: c,
            disableMouseWheelZoom: l,
            translateRatio: u,
          } = this.mindMap.opt;
          if (i && typeof i == `function`) return i(e);
          if (a === w.MOUSE_WHEEL_ACTION.ZOOM || e.ctrlKey || e.metaKey) {
            if (l) return;
            let { x: n, y: i } = this.mindMap.toPos(e.clientX, e.clientY),
              a = o ? n : void 0,
              s = o ? i : void 0;
            switch (
              (r &&
                (t.includes(w.DIR.LEFT) || t.includes(w.DIR.RIGHT)) &&
                (t = t.filter((e) => ![w.DIR.LEFT, w.DIR.RIGHT].includes(e))),
              !0)
            ) {
              case t.includes(w.DIR.UP || w.DIR.LEFT):
                c ? this.enlarge(a, s, r) : this.narrow(a, s, r);
                break;
              case t.includes(w.DIR.DOWN || w.DIR.RIGHT):
                c ? this.narrow(a, s, r) : this.enlarge(a, s, r);
                break;
            }
          } else {
            let n = 0,
              i = 0;
            r
              ? ((n = Math.abs(e.wheelDeltaX)), (i = Math.abs(e.wheelDeltaY)))
              : (n = i = s);
            let a = 0,
              o = 0;
            (t.includes(w.DIR.DOWN) && (o = -i),
              t.includes(w.DIR.UP) && (o = i),
              t.includes(w.DIR.LEFT) && (a = n),
              t.includes(w.DIR.RIGHT) && (a = -n),
              this.translateXY(a * u, o * u));
          }
        }),
        this.mindMap.on(`resize`, () => {
          this.checkNeedMindMapInCanvas() && this.transform();
        }));
    }
    getTransformData() {
      return {
        transform: this.mindMap.draw.transform(),
        state: {
          scale: this.scale,
          x: this.x,
          y: this.y,
          sx: this.sx,
          sy: this.sy,
        },
      };
    }
    setTransformData(e) {
      e &&
        (Object.keys(e.state).forEach((t) => {
          this[t] = e.state[t];
        }),
        this.mindMap.draw.transform({ ...e.transform }),
        this.mindMap.emit(`view_data_change`, this.getTransformData()),
        this.emitEvent(`scale`),
        this.emitEvent(`translate`));
    }
    translateXY(e, t) {
      (e === 0 && t === 0) ||
        ((this.x += e),
        (this.y += t),
        this.transform(),
        this.emitEvent(`translate`));
    }
    translateX(e) {
      e !== 0 && ((this.x += e), this.transform(), this.emitEvent(`translate`));
    }
    translateXTo(e) {
      ((this.x = e), this.transform(), this.emitEvent(`translate`));
    }
    translateY(e) {
      e !== 0 && ((this.y += e), this.transform(), this.emitEvent(`translate`));
    }
    translateYTo(e) {
      ((this.y = e), this.transform(), this.emitEvent(`translate`));
    }
    transform() {
      try {
        this.limitMindMapInCanvas();
      } catch {}
      (this.mindMap.draw.transform({
        origin: [0, 0],
        scale: this.scale,
        translate: [this.x, this.y],
      }),
        this.mindMap.emit(`view_data_change`, this.getTransformData()));
    }
    reset() {
      let e = this.scale !== 1,
        t = this.x !== 0 || this.y !== 0;
      ((this.scale = 1),
        (this.x = 0),
        (this.y = 0),
        this.transform(),
        e && this.emitEvent(`scale`),
        t && this.emitEvent(`translate`));
    }
    narrow(e, t, n) {
      let { scaleRatio: r, minZoomRatio: i } = this.mindMap.opt;
      r /= n ? 5 : 1;
      let a = Math.max(this.scale - r, i / 100);
      (this.scaleInCenter(a, e, t), this.transform(), this.emitEvent(`scale`));
    }
    enlarge(e, t, n) {
      let { scaleRatio: r, maxZoomRatio: i } = this.mindMap.opt;
      r /= n ? 5 : 1;
      let a = 0;
      ((a = i === -1 ? this.scale + r : Math.min(this.scale + r, i / 100)),
        this.scaleInCenter(a, e, t),
        this.transform(),
        this.emitEvent(`scale`));
    }
    scaleInCenter(e, t, n) {
      (t === void 0 || n === void 0) &&
        ((t = this.mindMap.width / 2), (n = this.mindMap.height / 2));
      let r = 1 - e / this.scale,
        i = (t - this.x) * r,
        a = (n - this.y) * r;
      ((this.x += i), (this.y += a), (this.scale = e));
    }
    setScale(e, t, n) {
      (t !== void 0 && n !== void 0
        ? this.scaleInCenter(e, t, n)
        : (this.scale = e),
        this.transform(),
        this.emitEvent(`scale`));
    }
    fit(e = () => {}, t = !1, n) {
      n = n === void 0 ? this.mindMap.opt.fitPadding : n;
      let r = this.mindMap.draw,
        i = r.transform(),
        a = e() || r.rbox(),
        o = a.width / i.scaleX,
        s = a.height / i.scaleY,
        c = o / s,
        { width: l, height: u } = this.mindMap.elRect;
      ((l -= n * 2), (u -= n * 2));
      let d = l / u,
        f = 0,
        p = ``;
      if (o <= l && s <= u && !t) ((f = 1), (p = 1));
      else {
        let e = 0;
        (c > d ? ((e = l), l / c, (p = 2)) : ((e = u * c), (p = 3)),
          (f = e / o));
      }
      this.setScale(f);
      let m = e() || r.rbox();
      ((m.x -= this.mindMap.elRect.left), (m.y -= this.mindMap.elRect.top));
      let h = 0,
        g = 0;
      (p === 1
        ? ((h = -m.x + n + (l - m.width) / 2),
          (g = -m.y + n + (u - m.height) / 2))
        : p === 2
          ? ((h = -m.x + n), (g = -m.y + n + (u - m.height) / 2))
          : p === 3 && ((h = -m.x + n + (l - m.width) / 2), (g = -m.y + n)),
        this.translateXY(h, g));
    }
    checkNeedMindMapInCanvas() {
      if (this.mindMap.demonstrate && this.mindMap.demonstrate.isInDemonstrate)
        return !1;
      let {
        isLimitMindMapInCanvasWhenHasScrollbar: e,
        isLimitMindMapInCanvas: t,
      } = this.mindMap.opt;
      return this.mindMap.scrollbar ? e : t;
    }
    limitMindMapInCanvas() {
      if (!this.checkNeedMindMapInCanvas()) return;
      let {
          scale: e,
          left: t,
          top: n,
          right: r,
          bottom: i,
        } = this.getPositionLimit(),
        a = ((this.mindMap.width - this.mindMap.initWidth) / 2) * e,
        o = ((this.mindMap.height - this.mindMap.initHeight) / 2) * e,
        s = this.scale / e;
      ((t *= s), (r *= s), (n *= s), (i *= s));
      let c = this.mindMap.width / 2,
        l = this.mindMap.height / 2,
        u = this.scale - 1;
      ((t -= u * c - a),
        (r -= u * c - a),
        (n -= u * l - o),
        (i -= u * l - o),
        this.x > t && (this.x = t),
        this.x < r && (this.x = r),
        this.y > n && (this.y = n),
        this.y < i && (this.y = i));
    }
    getPositionLimit() {
      let { scaleX: e, scaleY: t } = this.mindMap.draw.transform(),
        n = this.mindMap.draw.rbox(),
        r = this.mindMap.renderer.root.group.rbox(),
        i = this.mindMap.renderer.layout.getRootCenterOffset(r.width, r.height);
      return {
        scale: e,
        left: r.x - n.x - i.x * e,
        right: r.x - n.x2 - i.x * e,
        top: r.y - n.y - i.y * t,
        bottom: r.y - n.y2 - i.y * t,
      };
    }
    emitEvent(e) {
      switch (e) {
        case `scale`:
          this.mindMap.emit(`scale`, this.scale);
        case `translate`:
          this.mindMap.emit(`translate`, this.x, this.y);
      }
    }
  },
  ge = e(
    t((e, t) => {
      var n = Object.prototype.hasOwnProperty,
        r = `~`;
      function i() {}
      Object.create &&
        ((i.prototype = Object.create(null)), new i().__proto__ || (r = !1));
      function a(e, t, n) {
        ((this.fn = e), (this.context = t), (this.once = n || !1));
      }
      function o(e, t, n, i, o) {
        if (typeof n != `function`)
          throw TypeError(`The listener must be a function`);
        var s = new a(n, i || e, o),
          c = r ? r + t : t;
        return (
          e._events[c]
            ? e._events[c].fn
              ? (e._events[c] = [e._events[c], s])
              : e._events[c].push(s)
            : ((e._events[c] = s), e._eventsCount++),
          e
        );
      }
      function s(e, t) {
        --e._eventsCount === 0 ? (e._events = new i()) : delete e._events[t];
      }
      function c() {
        ((this._events = new i()), (this._eventsCount = 0));
      }
      ((c.prototype.eventNames = function () {
        var e = [],
          t,
          i;
        if (this._eventsCount === 0) return e;
        for (i in (t = this._events))
          n.call(t, i) && e.push(r ? i.slice(1) : i);
        return Object.getOwnPropertySymbols
          ? e.concat(Object.getOwnPropertySymbols(t))
          : e;
      }),
        (c.prototype.listeners = function (e) {
          var t = r ? r + e : e,
            n = this._events[t];
          if (!n) return [];
          if (n.fn) return [n.fn];
          for (var i = 0, a = n.length, o = Array(a); i < a; i++)
            o[i] = n[i].fn;
          return o;
        }),
        (c.prototype.listenerCount = function (e) {
          var t = r ? r + e : e,
            n = this._events[t];
          return n ? (n.fn ? 1 : n.length) : 0;
        }),
        (c.prototype.emit = function (e, t, n, i, a, o) {
          var s = r ? r + e : e;
          if (!this._events[s]) return !1;
          var c = this._events[s],
            l = arguments.length,
            u,
            d;
          if (c.fn) {
            switch ((c.once && this.removeListener(e, c.fn, void 0, !0), l)) {
              case 1:
                return (c.fn.call(c.context), !0);
              case 2:
                return (c.fn.call(c.context, t), !0);
              case 3:
                return (c.fn.call(c.context, t, n), !0);
              case 4:
                return (c.fn.call(c.context, t, n, i), !0);
              case 5:
                return (c.fn.call(c.context, t, n, i, a), !0);
              case 6:
                return (c.fn.call(c.context, t, n, i, a, o), !0);
            }
            for (d = 1, u = Array(l - 1); d < l; d++) u[d - 1] = arguments[d];
            c.fn.apply(c.context, u);
          } else {
            var f = c.length,
              p;
            for (d = 0; d < f; d++)
              switch (
                (c[d].once && this.removeListener(e, c[d].fn, void 0, !0), l)
              ) {
                case 1:
                  c[d].fn.call(c[d].context);
                  break;
                case 2:
                  c[d].fn.call(c[d].context, t);
                  break;
                case 3:
                  c[d].fn.call(c[d].context, t, n);
                  break;
                case 4:
                  c[d].fn.call(c[d].context, t, n, i);
                  break;
                default:
                  if (!u)
                    for (p = 1, u = Array(l - 1); p < l; p++)
                      u[p - 1] = arguments[p];
                  c[d].fn.apply(c[d].context, u);
              }
          }
          return !0;
        }),
        (c.prototype.on = function (e, t, n) {
          return o(this, e, t, n, !1);
        }),
        (c.prototype.once = function (e, t, n) {
          return o(this, e, t, n, !0);
        }),
        (c.prototype.removeListener = function (e, t, n, i) {
          var a = r ? r + e : e;
          if (!this._events[a]) return this;
          if (!t) return (s(this, a), this);
          var o = this._events[a];
          if (o.fn)
            o.fn === t &&
              (!i || o.once) &&
              (!n || o.context === n) &&
              s(this, a);
          else {
            for (var c = 0, l = [], u = o.length; c < u; c++)
              (o[c].fn !== t ||
                (i && !o[c].once) ||
                (n && o[c].context !== n)) &&
                l.push(o[c]);
            l.length
              ? (this._events[a] = l.length === 1 ? l[0] : l)
              : s(this, a);
          }
          return this;
        }),
        (c.prototype.removeAllListeners = function (e) {
          var t;
          return (
            e
              ? ((t = r ? r + e : e), this._events[t] && s(this, t))
              : ((this._events = new i()), (this._eventsCount = 0)),
            this
          );
        }),
        (c.prototype.off = c.prototype.removeListener),
        (c.prototype.addListener = c.prototype.on),
        (c.prefixed = r),
        (c.EventEmitter = c),
        t !== void 0 && (t.exports = c));
    })(),
  ),
  _e = class extends ge.default {
    constructor(e = {}) {
      (super(),
        (this.opt = e),
        (this.mindMap = e.mindMap),
        (this.isLeftMousedown = !1),
        (this.isRightMousedown = !1),
        (this.isMiddleMousedown = !1),
        (this.mousedownPos = { x: 0, y: 0 }),
        (this.mousemovePos = { x: 0, y: 0 }),
        (this.mousemoveOffset = { x: 0, y: 0 }),
        this.bindFn(),
        this.bind());
    }
    bindFn() {
      ((this.onBodyMousedown = this.onBodyMousedown.bind(this)),
        (this.onBodyClick = this.onBodyClick.bind(this)),
        (this.onDrawClick = this.onDrawClick.bind(this)),
        (this.onMousedown = this.onMousedown.bind(this)),
        (this.onMousemove = this.onMousemove.bind(this)),
        (this.onMouseup = this.onMouseup.bind(this)),
        (this.onNodeMouseup = this.onNodeMouseup.bind(this)),
        (this.onMousewheel = this.onMousewheel.bind(this)),
        (this.onContextmenu = this.onContextmenu.bind(this)),
        (this.onSvgMousedown = this.onSvgMousedown.bind(this)),
        (this.onKeyup = this.onKeyup.bind(this)),
        (this.onMouseenter = this.onMouseenter.bind(this)),
        (this.onMouseleave = this.onMouseleave.bind(this)));
    }
    bind() {
      (document.body.addEventListener(`mousedown`, this.onBodyMousedown),
        document.body.addEventListener(`click`, this.onBodyClick),
        this.mindMap.svg.on(`click`, this.onDrawClick),
        this.mindMap.el.addEventListener(`mousedown`, this.onMousedown),
        this.mindMap.svg.on(`mousedown`, this.onSvgMousedown),
        window.addEventListener(`mousemove`, this.onMousemove),
        window.addEventListener(`mouseup`, this.onMouseup),
        this.on(`node_mouseup`, this.onNodeMouseup),
        this.mindMap.el.addEventListener(`wheel`, this.onMousewheel),
        this.mindMap.svg.on(`contextmenu`, this.onContextmenu),
        this.mindMap.svg.on(`mouseenter`, this.onMouseenter),
        this.mindMap.svg.on(`mouseleave`, this.onMouseleave),
        window.addEventListener(`keyup`, this.onKeyup));
    }
    unbind() {
      (document.body.removeEventListener(`mousedown`, this.onBodyMousedown),
        document.body.removeEventListener(`click`, this.onBodyClick),
        this.mindMap.svg.off(`click`, this.onDrawClick),
        this.mindMap.el.removeEventListener(`mousedown`, this.onMousedown),
        window.removeEventListener(`mousemove`, this.onMousemove),
        window.removeEventListener(`mouseup`, this.onMouseup),
        this.off(`node_mouseup`, this.onNodeMouseup),
        this.mindMap.el.removeEventListener(`wheel`, this.onMousewheel),
        this.mindMap.svg.off(`contextmenu`, this.onContextmenu),
        this.mindMap.svg.off(`mouseenter`, this.onMouseenter),
        this.mindMap.svg.off(`mouseleave`, this.onMouseleave),
        window.removeEventListener(`keyup`, this.onKeyup));
    }
    onDrawClick(e) {
      this.emit(`draw_click`, e);
    }
    onBodyMousedown(e) {
      this.emit(`body_mousedown`, e);
    }
    onBodyClick(e) {
      this.emit(`body_click`, e);
    }
    onSvgMousedown(e) {
      this.emit(`svg_mousedown`, e);
    }
    onMousedown(e) {
      (e.which === 1
        ? (this.isLeftMousedown = !0)
        : e.which === 3
          ? (this.isRightMousedown = !0)
          : e.which === 2 && (this.isMiddleMousedown = !0),
        (this.mousedownPos.x = e.clientX),
        (this.mousedownPos.y = e.clientY),
        this.emit(`mousedown`, e, this));
    }
    onMousemove(e) {
      let { useLeftKeySelectionRightKeyDrag: t } = this.mindMap.opt;
      ((this.mousemovePos.x = e.clientX),
        (this.mousemovePos.y = e.clientY),
        (this.mousemoveOffset.x = e.clientX - this.mousedownPos.x),
        (this.mousemoveOffset.y = e.clientY - this.mousedownPos.y),
        this.emit(`mousemove`, e, this),
        (this.isMiddleMousedown ||
          (t ? this.isRightMousedown : this.isLeftMousedown)) &&
          (e.preventDefault(), this.emit(`drag`, e, this)));
    }
    onMouseup(e) {
      (this.onNodeMouseup(), this.emit(`mouseup`, e, this));
    }
    onNodeMouseup() {
      ((this.isLeftMousedown = !1),
        (this.isRightMousedown = !1),
        (this.isMiddleMousedown = !1));
    }
    onMousewheel(e) {
      (e.stopPropagation(), e.preventDefault());
      let t = [];
      (e.deltaY < 0 && t.push(w.DIR.UP),
        e.deltaY > 0 && t.push(w.DIR.DOWN),
        e.deltaX < 0 && t.push(w.DIR.LEFT),
        e.deltaX > 0 && t.push(w.DIR.RIGHT));
      let n = !1,
        { customCheckIsTouchPad: r } = this.mindMap.opt;
      ((n = typeof r == `function` ? r(e) : Math.abs(e.deltaY) <= 10),
        this.emit(`mousewheel`, e, t, this, n));
    }
    onContextmenu(e) {
      (e.preventDefault(), !e.ctrlKey && this.emit(`contextmenu`, e));
    }
    onKeyup(e) {
      this.emit(`keyup`, e);
    }
    onMouseenter(e) {
      this.emit(`svg_mouseenter`, e);
    }
    onMouseleave(e) {
      this.emit(`svg_mouseleave`, e);
    }
  },
  ve = t((e, t) => {
    var n = function (e) {
      return r(e) && !i(e);
    };
    function r(e) {
      return !!e && typeof e == `object`;
    }
    function i(e) {
      var t = Object.prototype.toString.call(e);
      return t === `[object RegExp]` || t === `[object Date]` || o(e);
    }
    var a =
      typeof Symbol == `function` && Symbol.for
        ? Symbol.for(`react.element`)
        : 60103;
    function o(e) {
      return e.$$typeof === a;
    }
    function s(e) {
      return Array.isArray(e) ? [] : {};
    }
    function c(e, t) {
      return t && t.clone === !0 && n(e) ? d(s(e), e, t) : e;
    }
    function l(e, t, r) {
      var i = e.slice();
      return (
        t.forEach(function (t, a) {
          i[a] === void 0
            ? (i[a] = c(t, r))
            : n(t)
              ? (i[a] = d(e[a], t, r))
              : e.indexOf(t) === -1 && i.push(c(t, r));
        }),
        i
      );
    }
    function u(e, t, r) {
      var i = {};
      return (
        n(e) &&
          Object.keys(e).forEach(function (t) {
            i[t] = c(e[t], r);
          }),
        Object.keys(t).forEach(function (a) {
          !n(t[a]) || !e[a] ? (i[a] = c(t[a], r)) : (i[a] = d(e[a], t[a], r));
        }),
        i
      );
    }
    function d(e, t, n) {
      var r = Array.isArray(t);
      return r === Array.isArray(e)
        ? r
          ? ((n || { arrayMerge: l }).arrayMerge || l)(e, t, n)
          : u(e, t, n)
        : c(t, n);
    }
    ((d.all = function (e, t) {
      if (!Array.isArray(e) || e.length < 2)
        throw Error(
          `first argument should be an array with at least two elements`,
        );
      return e.reduce(function (e, n) {
        return d(e, n, t);
      });
    }),
      (t.exports = d));
  }),
  ye,
  be = new Uint8Array(16);
function xe() {
  if (
    !ye &&
    ((ye =
      typeof crypto < `u` &&
      crypto.getRandomValues &&
      crypto.getRandomValues.bind(crypto)),
    !ye)
  )
    throw Error(
      `crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported`,
    );
  return ye(be);
}
var E = [];
for (let e = 0; e < 256; ++e) E.push((e + 256).toString(16).slice(1));
function Se(e, t = 0) {
  return (
    E[e[t + 0]] +
    E[e[t + 1]] +
    E[e[t + 2]] +
    E[e[t + 3]] +
    `-` +
    E[e[t + 4]] +
    E[e[t + 5]] +
    `-` +
    E[e[t + 6]] +
    E[e[t + 7]] +
    `-` +
    E[e[t + 8]] +
    E[e[t + 9]] +
    `-` +
    E[e[t + 10]] +
    E[e[t + 11]] +
    E[e[t + 12]] +
    E[e[t + 13]] +
    E[e[t + 14]] +
    E[e[t + 15]]
  );
}
var Ce = {
  randomUUID:
    typeof crypto < `u` && crypto.randomUUID && crypto.randomUUID.bind(crypto),
};
function we(e, t, n) {
  if (Ce.randomUUID && !t && !e) return Ce.randomUUID();
  e ||= {};
  let r = e.random || (e.rng || xe)();
  if (((r[6] = (r[6] & 15) | 64), (r[8] = (r[8] & 63) | 128), t)) {
    n ||= 0;
    for (let e = 0; e < 16; ++e) t[n + e] = r[e];
    return t;
  }
  return Se(r);
}
var Te = e(ve());
function Ee(e) {
  ((this.N = 624),
    (this.M = 397),
    (this.MATRIX_A = 2567483615),
    (this.UPPER_MASK = 2147483648),
    (this.LOWER_MASK = 2147483647),
    (this.mt = Array(this.N)),
    (this.mti = this.N + 1),
    this.init_genrand(e));
}
((Ee.prototype.init_genrand = function (e) {
  for (this.mt[0] = e >>> 0, this.mti = 1; this.mti < this.N; this.mti++)
    ((e = this.mt[this.mti - 1] ^ (this.mt[this.mti - 1] >>> 30)),
      (this.mt[this.mti] =
        ((((e & 4294901760) >>> 16) * 1812433253) << 16) +
        (e & 65535) * 1812433253 +
        this.mti),
      (this.mt[this.mti] >>>= 0));
}),
  (Ee.prototype.genrand_int32 = function () {
    var e,
      t = [0, this.MATRIX_A];
    if (this.mti >= this.N) {
      var n;
      for (
        this.mti == this.N + 1 && this.init_genrand(5489), n = 0;
        n < this.N - this.M;
        n++
      )
        ((e =
          (this.mt[n] & this.UPPER_MASK) | (this.mt[n + 1] & this.LOWER_MASK)),
          (this.mt[n] = this.mt[n + this.M] ^ (e >>> 1) ^ t[e & 1]));
      for (; n < this.N - 1; n++)
        ((e =
          (this.mt[n] & this.UPPER_MASK) | (this.mt[n + 1] & this.LOWER_MASK)),
          (this.mt[n] = this.mt[n + (this.M - this.N)] ^ (e >>> 1) ^ t[e & 1]));
      ((e =
        (this.mt[this.N - 1] & this.UPPER_MASK) |
        (this.mt[0] & this.LOWER_MASK)),
        (this.mt[this.N - 1] = this.mt[this.M - 1] ^ (e >>> 1) ^ t[e & 1]),
        (this.mti = 0));
    }
    return (
      (e = this.mt[this.mti++]),
      (e ^= e >>> 11),
      (e ^= (e << 7) & 2636928640),
      (e ^= (e << 15) & 4022730752),
      (e ^= e >>> 18),
      e >>> 0
    );
  }));
var De = {},
  Oe = [];
function D(e, t) {
  if (Array.isArray(e)) {
    for (let n of e) D(n, t);
    return;
  }
  if (typeof e == `object`) {
    for (let t in e) D(t, e[t]);
    return;
  }
  (Ae(Object.getOwnPropertyNames(t)), (De[e] = Object.assign(De[e] || {}, t)));
}
function O(e) {
  return De[e] || {};
}
function ke() {
  return [...new Set(Oe)];
}
function Ae(e) {
  Oe.push(...e);
}
function je(e, t) {
  let n,
    r = e.length,
    i = [];
  for (n = 0; n < r; n++) i.push(t(e[n]));
  return i;
}
function Me(e, t) {
  let n,
    r = e.length,
    i = [];
  for (n = 0; n < r; n++) t(e[n]) && i.push(e[n]);
  return i;
}
function Ne(e) {
  return ((e % 360) * Math.PI) / 180;
}
function Pe(e) {
  return e.toLowerCase().replace(/-(.)/g, function (e, t) {
    return t.toUpperCase();
  });
}
function Fe(e) {
  return e.replace(/([A-Z])/g, function (e, t) {
    return `-` + t.toLowerCase();
  });
}
function Ie(e) {
  return e.charAt(0).toUpperCase() + e.slice(1);
}
function Le(e, t, n, r) {
  return (
    (t == null || n == null) &&
      ((r ||= e.bbox()),
      t == null
        ? (t = (r.width / r.height) * n)
        : (n ??= (r.height / r.width) * t)),
    { width: t, height: n }
  );
}
function Re(e, t) {
  let n = e.origin,
    r = e.ox == null ? (e.originX == null ? `center` : e.originX) : e.ox,
    i = e.oy == null ? (e.originY == null ? `center` : e.originY) : e.oy;
  n != null &&
    ([r, i] = Array.isArray(n)
      ? n
      : typeof n == `object`
        ? [n.x, n.y]
        : [n, n]);
  let a = typeof r == `string`,
    o = typeof i == `string`;
  if (a || o) {
    let { height: e, width: n, x: s, y: c } = t.bbox();
    (a &&
      (r = r.includes(`left`) ? s : r.includes(`right`) ? s + n : s + n / 2),
      o &&
        (i = i.includes(`top`) ? c : i.includes(`bottom`) ? c + e : c + e / 2));
  }
  return [r, i];
}
var ze = `http://www.w3.org/2000/svg`,
  Be = `http://www.w3.org/1999/xhtml`,
  Ve = `http://www.w3.org/2000/xmlns/`,
  He = `http://www.w3.org/1999/xlink`,
  Ue = `http://svgjs.dev/svgjs`,
  k = {
    window: typeof window > `u` ? null : window,
    document: typeof document > `u` ? null : document,
  },
  We = class {},
  Ge = {},
  Ke = `___SYMBOL___ROOT___`;
function qe(e, t = ze) {
  return k.document.createElementNS(t, e);
}
function A(e, t = !1) {
  if (e instanceof We) return e;
  if (typeof e == `object`) return Je(e);
  if (e == null) return new Ge[Ke]();
  if (typeof e == `string` && e.charAt(0) !== `<`)
    return Je(k.document.querySelector(e));
  let n = t ? k.document.createElement(`div`) : qe(`svg`);
  return (
    (n.innerHTML = e),
    (e = Je(n.firstChild)),
    n.removeChild(n.firstChild),
    e
  );
}
function j(e, t) {
  return t && t.ownerDocument && t instanceof t.ownerDocument.defaultView.Node
    ? t
    : qe(e);
}
function M(e) {
  if (!e) return null;
  if (e.instance instanceof We) return e.instance;
  if (e.nodeName === `#document-fragment`) return new Ge.Fragment(e);
  let t = Ie(e.nodeName || `Dom`);
  return (
    t === `LinearGradient` || t === `RadialGradient`
      ? (t = `Gradient`)
      : Ge[t] || (t = `Dom`),
    new Ge[t](e)
  );
}
var Je = M;
function N(e, t = e.name, n = !1) {
  return (
    (Ge[t] = e),
    n && (Ge[Ke] = e),
    Ae(Object.getOwnPropertyNames(e.prototype)),
    e
  );
}
function Ye(e) {
  return Ge[e];
}
var Xe = 1e3;
function Ze(e) {
  return `Svgjs` + Ie(e) + Xe++;
}
function Qe(e) {
  for (let t = e.children.length - 1; t >= 0; t--) Qe(e.children[t]);
  return ((e.id &&= Ze(e.nodeName)), e);
}
function P(e, t) {
  let n, r;
  for (e = Array.isArray(e) ? e : [e], r = e.length - 1; r >= 0; r--)
    for (n in t) e[r].prototype[n] = t[n];
}
function F(e) {
  return function (...t) {
    let n = t[t.length - 1];
    return n && n.constructor === Object && !(n instanceof Array)
      ? e.apply(this, t.slice(0, -1)).attr(n)
      : e.apply(this, t);
  };
}
function $e() {
  return this.parent().children();
}
function et() {
  return this.parent().index(this);
}
function tt() {
  return this.siblings()[this.position() + 1];
}
function nt() {
  return this.siblings()[this.position() - 1];
}
function rt() {
  let e = this.position();
  return (this.parent().add(this.remove(), e + 1), this);
}
function it() {
  let e = this.position();
  return (this.parent().add(this.remove(), e ? e - 1 : 0), this);
}
function at() {
  return (this.parent().add(this.remove()), this);
}
function ot() {
  return (this.parent().add(this.remove(), 0), this);
}
function st(e) {
  ((e = A(e)), e.remove());
  let t = this.position();
  return (this.parent().add(e, t), this);
}
function ct(e) {
  ((e = A(e)), e.remove());
  let t = this.position();
  return (this.parent().add(e, t + 1), this);
}
function lt(e) {
  return ((e = A(e)), e.before(this), this);
}
function ut(e) {
  return ((e = A(e)), e.after(this), this);
}
D(`Dom`, {
  siblings: $e,
  position: et,
  next: tt,
  prev: nt,
  forward: rt,
  backward: it,
  front: at,
  back: ot,
  before: st,
  after: ct,
  insertBefore: lt,
  insertAfter: ut,
});
var dt = /^([+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?)([a-z%]*)$/i,
  ft = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i,
  pt = /rgb\((\d+),(\d+),(\d+)\)/,
  mt = /(#[a-z_][a-z0-9\-_]*)/i,
  ht = /\)\s*,?\s*/,
  gt = /\s/g,
  _t = /^#[a-f0-9]{3}$|^#[a-f0-9]{6}$/i,
  vt = /^rgb\(/,
  yt = /^(\s+)?$/,
  bt = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i,
  xt = /\.(jpg|jpeg|png|gif|svg)(\?[^=]+.*)?/i,
  St = /[\s,]+/,
  Ct = /[MLHVCSQTAZ]/i;
function wt() {
  let e = this.attr(`class`);
  return e == null ? [] : e.trim().split(St);
}
function Tt(e) {
  return this.classes().indexOf(e) !== -1;
}
function Et(e) {
  if (!this.hasClass(e)) {
    let t = this.classes();
    (t.push(e), this.attr(`class`, t.join(` `)));
  }
  return this;
}
function Dt(e) {
  return (
    this.hasClass(e) &&
      this.attr(
        `class`,
        this.classes()
          .filter(function (t) {
            return t !== e;
          })
          .join(` `),
      ),
    this
  );
}
function Ot(e) {
  return this.hasClass(e) ? this.removeClass(e) : this.addClass(e);
}
D(`Dom`, {
  classes: wt,
  hasClass: Tt,
  addClass: Et,
  removeClass: Dt,
  toggleClass: Ot,
});
function kt(e, t) {
  let n = {};
  if (arguments.length === 0)
    return (
      this.node.style.cssText
        .split(/\s*;\s*/)
        .filter(function (e) {
          return !!e.length;
        })
        .forEach(function (e) {
          let t = e.split(/\s*:\s*/);
          n[t[0]] = t[1];
        }),
      n
    );
  if (arguments.length < 2) {
    if (Array.isArray(e)) {
      for (let t of e) {
        let e = Pe(t);
        n[t] = this.node.style[e];
      }
      return n;
    }
    if (typeof e == `string`) return this.node.style[Pe(e)];
    if (typeof e == `object`)
      for (let t in e)
        this.node.style[Pe(t)] = e[t] == null || yt.test(e[t]) ? `` : e[t];
  }
  return (
    arguments.length === 2 &&
      (this.node.style[Pe(e)] = t == null || yt.test(t) ? `` : t),
    this
  );
}
function At() {
  return this.css(`display`, ``);
}
function jt() {
  return this.css(`display`, `none`);
}
function Mt() {
  return this.css(`display`) !== `none`;
}
D(`Dom`, { css: kt, show: At, hide: jt, visible: Mt });
function Nt(e, t, n) {
  if (e == null)
    return this.data(
      je(
        Me(this.node.attributes, (e) => e.nodeName.indexOf(`data-`) === 0),
        (e) => e.nodeName.slice(5),
      ),
    );
  if (e instanceof Array) {
    let t = {};
    for (let n of e) t[n] = this.data(n);
    return t;
  } else if (typeof e == `object`) for (t in e) this.data(t, e[t]);
  else if (arguments.length < 2)
    try {
      return JSON.parse(this.attr(`data-` + e));
    } catch {
      return this.attr(`data-` + e);
    }
  else
    this.attr(
      `data-` + e,
      t === null
        ? null
        : n === !0 || typeof t == `string` || typeof t == `number`
          ? t
          : JSON.stringify(t),
    );
  return this;
}
D(`Dom`, { data: Nt });
function Pt(e, t) {
  if (typeof arguments[0] == `object`) for (let t in e) this.remember(t, e[t]);
  else if (arguments.length === 1) return this.memory()[e];
  else this.memory()[e] = t;
  return this;
}
function Ft() {
  if (arguments.length === 0) this._memory = {};
  else
    for (let e = arguments.length - 1; e >= 0; e--)
      delete this.memory()[arguments[e]];
  return this;
}
function It() {
  return (this._memory = this._memory || {});
}
D(`Dom`, { remember: Pt, forget: Ft, memory: It });
function Lt(e) {
  return e.length === 4
    ? [
        `#`,
        e.substring(1, 2),
        e.substring(1, 2),
        e.substring(2, 3),
        e.substring(2, 3),
        e.substring(3, 4),
        e.substring(3, 4),
      ].join(``)
    : e;
}
function Rt(e) {
  let t = Math.max(0, Math.min(255, Math.round(e))).toString(16);
  return t.length === 1 ? `0` + t : t;
}
function zt(e, t) {
  for (let n = t.length; n--;) if (e[t[n]] == null) return !1;
  return !0;
}
function Bt(e, t) {
  let n = zt(e, `rgb`)
    ? { _a: e.r, _b: e.g, _c: e.b, _d: 0, space: `rgb` }
    : zt(e, `xyz`)
      ? { _a: e.x, _b: e.y, _c: e.z, _d: 0, space: `xyz` }
      : zt(e, `hsl`)
        ? { _a: e.h, _b: e.s, _c: e.l, _d: 0, space: `hsl` }
        : zt(e, `lab`)
          ? { _a: e.l, _b: e.a, _c: e.b, _d: 0, space: `lab` }
          : zt(e, `lch`)
            ? { _a: e.l, _b: e.c, _c: e.h, _d: 0, space: `lch` }
            : zt(e, `cmyk`)
              ? { _a: e.c, _b: e.m, _c: e.y, _d: e.k, space: `cmyk` }
              : { _a: 0, _b: 0, _c: 0, space: `rgb` };
  return ((n.space = t || n.space), n);
}
function Vt(e) {
  return e === `lab` || e === `xyz` || e === `lch`;
}
function Ht(e, t, n) {
  return (
    n < 0 && (n += 1),
    n > 1 && --n,
    n < 1 / 6
      ? e + (t - e) * 6 * n
      : n < 1 / 2
        ? t
        : n < 2 / 3
          ? e + (t - e) * (2 / 3 - n) * 6
          : e
  );
}
var I = class e {
    constructor(...e) {
      this.init(...e);
    }
    static isColor(t) {
      return t && (t instanceof e || this.isRgb(t) || this.test(t));
    }
    static isRgb(e) {
      return (
        e &&
        typeof e.r == `number` &&
        typeof e.g == `number` &&
        typeof e.b == `number`
      );
    }
    static random(t = `vibrant`, n, r) {
      let { random: i, round: a, sin: o, PI: s } = Math;
      if (t === `vibrant`)
        return new e(24 * i() + 57, 38 * i() + 45, 360 * i(), `lch`);
      if (t === `sine`)
        return (
          (n ??= i()),
          new e(
            a(80 * o((2 * s * n) / 0.5 + 0.01) + 150),
            a(50 * o((2 * s * n) / 0.5 + 4.6) + 200),
            a(100 * o((2 * s * n) / 0.5 + 2.3) + 150),
          )
        );
      if (t === `pastel`)
        return new e(8 * i() + 86, 17 * i() + 9, 360 * i(), `lch`);
      if (t === `dark`)
        return new e(10 + 10 * i(), 50 * i() + 86, 360 * i(), `lch`);
      if (t === `rgb`) return new e(255 * i(), 255 * i(), 255 * i());
      if (t === `lab`)
        return new e(100 * i(), 256 * i() - 128, 256 * i() - 128, `lab`);
      if (t === `grey`) {
        let t = 255 * i();
        return new e(t, t, t);
      } else throw Error(`Unsupported random color mode`);
    }
    static test(e) {
      return typeof e == `string` && (_t.test(e) || vt.test(e));
    }
    cmyk() {
      let { _a: t, _b: n, _c: r } = this.rgb(),
        [i, a, o] = [t, n, r].map((e) => e / 255),
        s = Math.min(1 - i, 1 - a, 1 - o);
      return s === 1
        ? new e(0, 0, 0, 1, `cmyk`)
        : new e(
            (1 - i - s) / (1 - s),
            (1 - a - s) / (1 - s),
            (1 - o - s) / (1 - s),
            s,
            `cmyk`,
          );
    }
    hsl() {
      let { _a: t, _b: n, _c: r } = this.rgb(),
        [i, a, o] = [t, n, r].map((e) => e / 255),
        s = Math.max(i, a, o),
        c = Math.min(i, a, o),
        l = (s + c) / 2,
        u = s === c,
        d = s - c,
        f = u ? 0 : l > 0.5 ? d / (2 - s - c) : d / (s + c);
      return new e(
        360 *
          (u
            ? 0
            : s === i
              ? ((a - o) / d + (a < o ? 6 : 0)) / 6
              : s === a
                ? ((o - i) / d + 2) / 6
                : s === o
                  ? ((i - a) / d + 4) / 6
                  : 0),
        100 * f,
        100 * l,
        `hsl`,
      );
    }
    init(e = 0, t = 0, n = 0, r = 0, i = `rgb`) {
      if (((e ||= 0), this.space))
        for (let e in this.space) delete this[this.space[e]];
      if (typeof e == `number`)
        ((i = typeof r == `string` ? r : i),
          (r = typeof r == `string` ? 0 : r),
          Object.assign(this, { _a: e, _b: t, _c: n, _d: r, space: i }));
      else if (e instanceof Array)
        ((this.space = t || (typeof e[3] == `string` ? e[3] : e[4]) || `rgb`),
          Object.assign(this, { _a: e[0], _b: e[1], _c: e[2], _d: e[3] || 0 }));
      else if (e instanceof Object) {
        let n = Bt(e, t);
        Object.assign(this, n);
      } else if (typeof e == `string`)
        if (vt.test(e)) {
          let t = e.replace(gt, ``),
            [n, r, i] = pt
              .exec(t)
              .slice(1, 4)
              .map((e) => parseInt(e));
          Object.assign(this, { _a: n, _b: r, _c: i, _d: 0, space: `rgb` });
        } else if (_t.test(e)) {
          let [, t, n, r] = ft.exec(Lt(e)).map((e) => parseInt(e, 16));
          Object.assign(this, { _a: t, _b: n, _c: r, _d: 0, space: `rgb` });
        } else throw Error(`Unsupported string format, can't construct Color`);
      let { _a: a, _b: o, _c: s, _d: c } = this,
        l =
          this.space === `rgb`
            ? { r: a, g: o, b: s }
            : this.space === `xyz`
              ? { x: a, y: o, z: s }
              : this.space === `hsl`
                ? { h: a, s: o, l: s }
                : this.space === `lab`
                  ? { l: a, a: o, b: s }
                  : this.space === `lch`
                    ? { l: a, c: o, h: s }
                    : this.space === `cmyk`
                      ? { c: a, m: o, y: s, k: c }
                      : {};
      Object.assign(this, l);
    }
    lab() {
      let { x: t, y: n, z: r } = this.xyz();
      return new e(116 * n - 16, 500 * (t - n), 200 * (n - r), `lab`);
    }
    lch() {
      let { l: t, a: n, b: r } = this.lab(),
        i = Math.sqrt(n ** 2 + r ** 2),
        a = (180 * Math.atan2(r, n)) / Math.PI;
      return (a < 0 && ((a *= -1), (a = 360 - a)), new e(t, i, a, `lch`));
    }
    rgb() {
      if (this.space === `rgb`) return this;
      if (Vt(this.space)) {
        let { x: t, y: n, z: r } = this;
        if (this.space === `lab` || this.space === `lch`) {
          let { l: e, a: i, b: a } = this;
          if (this.space === `lch`) {
            let { c: e, h: t } = this,
              n = Math.PI / 180;
            ((i = e * Math.cos(n * t)), (a = e * Math.sin(n * t)));
          }
          let o = (e + 16) / 116,
            s = i / 500 + o,
            c = o - a / 200,
            l = 16 / 116,
            u = 0.008856,
            d = 7.787;
          ((t = 0.95047 * (s ** 3 > u ? s ** 3 : (s - l) / d)),
            (n = 1 * (o ** 3 > u ? o ** 3 : (o - l) / d)),
            (r = 1.08883 * (c ** 3 > u ? c ** 3 : (c - l) / d)));
        }
        let i = t * 3.2406 + n * -1.5372 + r * -0.4986,
          a = t * -0.9689 + n * 1.8758 + r * 0.0415,
          o = t * 0.0557 + n * -0.204 + r * 1.057,
          s = Math.pow,
          c = 0.0031308,
          l = i > c ? 1.055 * s(i, 1 / 2.4) - 0.055 : 12.92 * i,
          u = a > c ? 1.055 * s(a, 1 / 2.4) - 0.055 : 12.92 * a,
          d = o > c ? 1.055 * s(o, 1 / 2.4) - 0.055 : 12.92 * o;
        return new e(255 * l, 255 * u, 255 * d);
      } else if (this.space === `hsl`) {
        let { h: t, s: n, l: r } = this;
        if (((t /= 360), (n /= 100), (r /= 100), n === 0))
          return ((r *= 255), new e(r, r, r));
        let i = r < 0.5 ? r * (1 + n) : r + n - r * n,
          a = 2 * r - i;
        return new e(
          255 * Ht(a, i, t + 1 / 3),
          255 * Ht(a, i, t),
          255 * Ht(a, i, t - 1 / 3),
        );
      } else if (this.space === `cmyk`) {
        let { c: t, m: n, y: r, k: i } = this;
        return new e(
          255 * (1 - Math.min(1, t * (1 - i) + i)),
          255 * (1 - Math.min(1, n * (1 - i) + i)),
          255 * (1 - Math.min(1, r * (1 - i) + i)),
        );
      } else return this;
    }
    toArray() {
      let { _a: e, _b: t, _c: n, _d: r, space: i } = this;
      return [e, t, n, r, i];
    }
    toHex() {
      let [e, t, n] = this._clamped().map(Rt);
      return `#${e}${t}${n}`;
    }
    toRgb() {
      let [e, t, n] = this._clamped();
      return `rgb(${e},${t},${n})`;
    }
    toString() {
      return this.toHex();
    }
    xyz() {
      let { _a: t, _b: n, _c: r } = this.rgb(),
        [i, a, o] = [t, n, r].map((e) => e / 255),
        s = i > 0.04045 ? ((i + 0.055) / 1.055) ** 2.4 : i / 12.92,
        c = a > 0.04045 ? ((a + 0.055) / 1.055) ** 2.4 : a / 12.92,
        l = o > 0.04045 ? ((o + 0.055) / 1.055) ** 2.4 : o / 12.92,
        u = (s * 0.4124 + c * 0.3576 + l * 0.1805) / 0.95047,
        d = (s * 0.2126 + c * 0.7152 + l * 0.0722) / 1,
        f = (s * 0.0193 + c * 0.1192 + l * 0.9505) / 1.08883;
      return new e(
        u > 0.008856 ? u ** (1 / 3) : 7.787 * u + 16 / 116,
        d > 0.008856 ? d ** (1 / 3) : 7.787 * d + 16 / 116,
        f > 0.008856 ? f ** (1 / 3) : 7.787 * f + 16 / 116,
        `xyz`,
      );
    }
    _clamped() {
      let { _a: e, _b: t, _c: n } = this.rgb(),
        { max: r, min: i, round: a } = Math;
      return [e, t, n].map((e) => r(0, i(a(e), 255)));
    }
  },
  L = class e {
    constructor(...e) {
      this.init(...e);
    }
    clone() {
      return new e(this);
    }
    init(e, t) {
      let n = { x: 0, y: 0 },
        r = Array.isArray(e)
          ? { x: e[0], y: e[1] }
          : typeof e == `object`
            ? { x: e.x, y: e.y }
            : { x: e, y: t };
      return (
        (this.x = r.x == null ? n.x : r.x),
        (this.y = r.y == null ? n.y : r.y),
        this
      );
    }
    toArray() {
      return [this.x, this.y];
    }
    transform(e) {
      return this.clone().transformO(e);
    }
    transformO(e) {
      R.isMatrixLike(e) || (e = new R(e));
      let { x: t, y: n } = this;
      return (
        (this.x = e.a * t + e.c * n + e.e),
        (this.y = e.b * t + e.d * n + e.f),
        this
      );
    }
  };
function Ut(e, t) {
  return new L(e, t).transformO(this.screenCTM().inverseO());
}
function Wt(e, t, n) {
  return Math.abs(t - e) < (n || 1e-6);
}
var R = class e {
  constructor(...e) {
    this.init(...e);
  }
  static formatTransforms(e) {
    let t = e.flip === `both` || e.flip === !0,
      n = e.flip && (t || e.flip === `x`) ? -1 : 1,
      r = e.flip && (t || e.flip === `y`) ? -1 : 1,
      i =
        e.skew && e.skew.length
          ? e.skew[0]
          : isFinite(e.skew)
            ? e.skew
            : isFinite(e.skewX)
              ? e.skewX
              : 0,
      a =
        e.skew && e.skew.length
          ? e.skew[1]
          : isFinite(e.skew)
            ? e.skew
            : isFinite(e.skewY)
              ? e.skewY
              : 0,
      o =
        e.scale && e.scale.length
          ? e.scale[0] * n
          : isFinite(e.scale)
            ? e.scale * n
            : isFinite(e.scaleX)
              ? e.scaleX * n
              : n,
      s =
        e.scale && e.scale.length
          ? e.scale[1] * r
          : isFinite(e.scale)
            ? e.scale * r
            : isFinite(e.scaleY)
              ? e.scaleY * r
              : r,
      c = e.shear || 0,
      l = e.rotate || e.theta || 0,
      u = new L(e.origin || e.around || e.ox || e.originX, e.oy || e.originY),
      d = u.x,
      f = u.y,
      p = new L(
        e.position || e.px || e.positionX || NaN,
        e.py || e.positionY || NaN,
      ),
      m = p.x,
      h = p.y,
      g = new L(e.translate || e.tx || e.translateX, e.ty || e.translateY),
      _ = g.x,
      v = g.y,
      y = new L(e.relative || e.rx || e.relativeX, e.ry || e.relativeY);
    return {
      scaleX: o,
      scaleY: s,
      skewX: i,
      skewY: a,
      shear: c,
      theta: l,
      rx: y.x,
      ry: y.y,
      tx: _,
      ty: v,
      ox: d,
      oy: f,
      px: m,
      py: h,
    };
  }
  static fromArray(e) {
    return { a: e[0], b: e[1], c: e[2], d: e[3], e: e[4], f: e[5] };
  }
  static isMatrixLike(e) {
    return (
      e.a != null ||
      e.b != null ||
      e.c != null ||
      e.d != null ||
      e.e != null ||
      e.f != null
    );
  }
  static matrixMultiply(e, t, n) {
    let r = e.a * t.a + e.c * t.b,
      i = e.b * t.a + e.d * t.b,
      a = e.a * t.c + e.c * t.d,
      o = e.b * t.c + e.d * t.d,
      s = e.e + e.a * t.e + e.c * t.f,
      c = e.f + e.b * t.e + e.d * t.f;
    return (
      (n.a = r),
      (n.b = i),
      (n.c = a),
      (n.d = o),
      (n.e = s),
      (n.f = c),
      n
    );
  }
  around(e, t, n) {
    return this.clone().aroundO(e, t, n);
  }
  aroundO(e, t, n) {
    let r = e || 0,
      i = t || 0;
    return this.translateO(-r, -i).lmultiplyO(n).translateO(r, i);
  }
  clone() {
    return new e(this);
  }
  decompose(e = 0, t = 0) {
    let n = this.a,
      r = this.b,
      i = this.c,
      a = this.d,
      o = this.e,
      s = this.f,
      c = n * a - r * i,
      l = c > 0 ? 1 : -1,
      u = l * Math.sqrt(n * n + r * r),
      d = Math.atan2(l * r, l * n),
      f = (180 / Math.PI) * d,
      p = Math.cos(d),
      m = Math.sin(d),
      h = (n * i + r * a) / c,
      g = (i * u) / (h * n - r) || (a * u) / (h * r + n);
    return {
      scaleX: u,
      scaleY: g,
      shear: h,
      rotate: f,
      translateX: o - e + e * p * u + t * (h * p * u - m * g),
      translateY: s - t + e * m * u + t * (h * m * u + p * g),
      originX: e,
      originY: t,
      a: this.a,
      b: this.b,
      c: this.c,
      d: this.d,
      e: this.e,
      f: this.f,
    };
  }
  equals(t) {
    if (t === this) return !0;
    let n = new e(t);
    return (
      Wt(this.a, n.a) &&
      Wt(this.b, n.b) &&
      Wt(this.c, n.c) &&
      Wt(this.d, n.d) &&
      Wt(this.e, n.e) &&
      Wt(this.f, n.f)
    );
  }
  flip(e, t) {
    return this.clone().flipO(e, t);
  }
  flipO(e, t) {
    return e === `x`
      ? this.scaleO(-1, 1, t, 0)
      : e === `y`
        ? this.scaleO(1, -1, 0, t)
        : this.scaleO(-1, -1, e, t || e);
  }
  init(t) {
    let n = e.fromArray([1, 0, 0, 1, 0, 0]);
    return (
      (t =
        t instanceof V
          ? t.matrixify()
          : typeof t == `string`
            ? e.fromArray(t.split(St).map(parseFloat))
            : Array.isArray(t)
              ? e.fromArray(t)
              : typeof t == `object` && e.isMatrixLike(t)
                ? t
                : typeof t == `object`
                  ? new e().transform(t)
                  : arguments.length === 6
                    ? e.fromArray([].slice.call(arguments))
                    : n),
      (this.a = t.a == null ? n.a : t.a),
      (this.b = t.b == null ? n.b : t.b),
      (this.c = t.c == null ? n.c : t.c),
      (this.d = t.d == null ? n.d : t.d),
      (this.e = t.e == null ? n.e : t.e),
      (this.f = t.f == null ? n.f : t.f),
      this
    );
  }
  inverse() {
    return this.clone().inverseO();
  }
  inverseO() {
    let e = this.a,
      t = this.b,
      n = this.c,
      r = this.d,
      i = this.e,
      a = this.f,
      o = e * r - t * n;
    if (!o) throw Error(`Cannot invert ` + this);
    let s = r / o,
      c = -t / o,
      l = -n / o,
      u = e / o,
      d = -(s * i + l * a),
      f = -(c * i + u * a);
    return (
      (this.a = s),
      (this.b = c),
      (this.c = l),
      (this.d = u),
      (this.e = d),
      (this.f = f),
      this
    );
  }
  lmultiply(e) {
    return this.clone().lmultiplyO(e);
  }
  lmultiplyO(t) {
    let n = this,
      r = t instanceof e ? t : new e(t);
    return e.matrixMultiply(r, n, this);
  }
  multiply(e) {
    return this.clone().multiplyO(e);
  }
  multiplyO(t) {
    let n = this,
      r = t instanceof e ? t : new e(t);
    return e.matrixMultiply(n, r, this);
  }
  rotate(e, t, n) {
    return this.clone().rotateO(e, t, n);
  }
  rotateO(e, t = 0, n = 0) {
    e = Ne(e);
    let r = Math.cos(e),
      i = Math.sin(e),
      { a, b: o, c: s, d: c, e: l, f: u } = this;
    return (
      (this.a = a * r - o * i),
      (this.b = o * r + a * i),
      (this.c = s * r - c * i),
      (this.d = c * r + s * i),
      (this.e = l * r - u * i + n * i - t * r + t),
      (this.f = u * r + l * i - t * i - n * r + n),
      this
    );
  }
  scale(e, t, n, r) {
    return this.clone().scaleO(...arguments);
  }
  scaleO(e, t = e, n = 0, r = 0) {
    arguments.length === 3 && ((r = n), (n = t), (t = e));
    let { a: i, b: a, c: o, d: s, e: c, f: l } = this;
    return (
      (this.a = i * e),
      (this.b = a * t),
      (this.c = o * e),
      (this.d = s * t),
      (this.e = c * e - n * e + n),
      (this.f = l * t - r * t + r),
      this
    );
  }
  shear(e, t, n) {
    return this.clone().shearO(e, t, n);
  }
  shearO(e, t = 0, n = 0) {
    let { a: r, b: i, c: a, d: o, e: s, f: c } = this;
    return (
      (this.a = r + i * e),
      (this.c = a + o * e),
      (this.e = s + c * e - n * e),
      this
    );
  }
  skew(e, t, n, r) {
    return this.clone().skewO(...arguments);
  }
  skewO(e, t = e, n = 0, r = 0) {
    (arguments.length === 3 && ((r = n), (n = t), (t = e)),
      (e = Ne(e)),
      (t = Ne(t)));
    let i = Math.tan(e),
      a = Math.tan(t),
      { a: o, b: s, c, d: l, e: u, f: d } = this;
    return (
      (this.a = o + s * i),
      (this.b = s + o * a),
      (this.c = c + l * i),
      (this.d = l + c * a),
      (this.e = u + d * i - r * i),
      (this.f = d + u * a - n * a),
      this
    );
  }
  skewX(e, t, n) {
    return this.skew(e, 0, t, n);
  }
  skewY(e, t, n) {
    return this.skew(0, e, t, n);
  }
  toArray() {
    return [this.a, this.b, this.c, this.d, this.e, this.f];
  }
  toString() {
    return (
      `matrix(` +
      this.a +
      `,` +
      this.b +
      `,` +
      this.c +
      `,` +
      this.d +
      `,` +
      this.e +
      `,` +
      this.f +
      `)`
    );
  }
  transform(t) {
    if (e.isMatrixLike(t)) return new e(t).multiplyO(this);
    let n = e.formatTransforms(t),
      r = this,
      { x: i, y: a } = new L(n.ox, n.oy).transform(r),
      o = new e()
        .translateO(n.rx, n.ry)
        .lmultiplyO(r)
        .translateO(-i, -a)
        .scaleO(n.scaleX, n.scaleY)
        .skewO(n.skewX, n.skewY)
        .shearO(n.shear)
        .rotateO(n.theta)
        .translateO(i, a);
    if (isFinite(n.px) || isFinite(n.py)) {
      let e = new L(i, a).transform(o),
        t = isFinite(n.px) ? n.px - e.x : 0,
        r = isFinite(n.py) ? n.py - e.y : 0;
      o.translateO(t, r);
    }
    return (o.translateO(n.tx, n.ty), o);
  }
  translate(e, t) {
    return this.clone().translateO(e, t);
  }
  translateO(e, t) {
    return ((this.e += e || 0), (this.f += t || 0), this);
  }
  valueOf() {
    return { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f };
  }
};
function Gt() {
  return new R(this.node.getCTM());
}
function Kt() {
  if (typeof this.isRoot == `function` && !this.isRoot()) {
    let e = this.rect(1, 1),
      t = e.node.getScreenCTM();
    return (e.remove(), new R(t));
  }
  return new R(this.node.getScreenCTM());
}
N(R, `Matrix`);
function qt() {
  if (!qt.nodes) {
    let e = A().size(2, 0);
    ((e.node.style.cssText = [
      `opacity: 0`,
      `position: absolute`,
      `left: -100%`,
      `top: -100%`,
      `overflow: hidden`,
    ].join(`;`)),
      e.attr(`focusable`, `false`),
      e.attr(`aria-hidden`, `true`),
      (qt.nodes = { svg: e, path: e.path().node }));
  }
  if (!qt.nodes.svg.node.parentNode) {
    let e = k.document.body || k.document.documentElement;
    qt.nodes.svg.addTo(e);
  }
  return qt.nodes;
}
function Jt(e) {
  return !e.width && !e.height && !e.x && !e.y;
}
function Yt(e) {
  return (
    e === k.document ||
    (
      k.document.documentElement.contains ||
      function (e) {
        for (; e.parentNode;) e = e.parentNode;
        return e === k.document;
      }
    ).call(k.document.documentElement, e)
  );
}
var z = class e {
  constructor(...e) {
    this.init(...e);
  }
  addOffset() {
    return (
      (this.x += k.window.pageXOffset),
      (this.y += k.window.pageYOffset),
      new e(this)
    );
  }
  init(e) {
    return (
      (e =
        typeof e == `string`
          ? e.split(St).map(parseFloat)
          : Array.isArray(e)
            ? e
            : typeof e == `object`
              ? [
                  e.left == null ? e.x : e.left,
                  e.top == null ? e.y : e.top,
                  e.width,
                  e.height,
                ]
              : arguments.length === 4
                ? [].slice.call(arguments)
                : [0, 0, 0, 0]),
      (this.x = e[0] || 0),
      (this.y = e[1] || 0),
      (this.width = this.w = e[2] || 0),
      (this.height = this.h = e[3] || 0),
      (this.x2 = this.x + this.w),
      (this.y2 = this.y + this.h),
      (this.cx = this.x + this.w / 2),
      (this.cy = this.y + this.h / 2),
      this
    );
  }
  isNulled() {
    return Jt(this);
  }
  merge(t) {
    let n = Math.min(this.x, t.x),
      r = Math.min(this.y, t.y);
    return new e(
      n,
      r,
      Math.max(this.x + this.width, t.x + t.width) - n,
      Math.max(this.y + this.height, t.y + t.height) - r,
    );
  }
  toArray() {
    return [this.x, this.y, this.width, this.height];
  }
  toString() {
    return this.x + ` ` + this.y + ` ` + this.width + ` ` + this.height;
  }
  transform(t) {
    t instanceof R || (t = new R(t));
    let n = 1 / 0,
      r = -1 / 0,
      i = 1 / 0,
      a = -1 / 0;
    return (
      [
        new L(this.x, this.y),
        new L(this.x2, this.y),
        new L(this.x, this.y2),
        new L(this.x2, this.y2),
      ].forEach(function (e) {
        ((e = e.transform(t)),
          (n = Math.min(n, e.x)),
          (r = Math.max(r, e.x)),
          (i = Math.min(i, e.y)),
          (a = Math.max(a, e.y)));
      }),
      new e(n, i, r - n, a - i)
    );
  }
};
function Xt(e, t, n) {
  let r;
  try {
    if (((r = t(e.node)), Jt(r) && !Yt(e.node)))
      throw Error(`Element not in the dom`);
  } catch {
    r = n(e);
  }
  return r;
}
function Zt() {
  return new z(
    Xt(
      this,
      (e) => e.getBBox(),
      (e) => {
        try {
          let t = e.clone().addTo(qt().svg).show(),
            n = t.node.getBBox();
          return (t.remove(), n);
        } catch (t) {
          throw Error(
            `Getting bbox of element "${e.node.nodeName}" is not possible: ${t.toString()}`,
          );
        }
      },
    ),
  );
}
function Qt(e) {
  let t = new z(
    Xt(
      this,
      (e) => e.getBoundingClientRect(),
      (e) => {
        throw Error(
          `Getting rbox of element "${e.node.nodeName}" is not possible`,
        );
      },
    ),
  );
  return e ? t.transform(e.screenCTM().inverseO()) : t.addOffset();
}
function $t(e, t) {
  let n = this.bbox();
  return e > n.x && t > n.y && e < n.x + n.width && t < n.y + n.height;
}
(D({
  viewbox: {
    viewbox(e, t, n, r) {
      return e == null
        ? new z(this.attr(`viewBox`))
        : this.attr(`viewBox`, new z(e, t, n, r));
    },
    zoom(e, t) {
      let { width: n, height: r } = this.attr([`width`, `height`]);
      if (
        (((!n && !r) || typeof n == `string` || typeof r == `string`) &&
          ((n = this.node.clientWidth), (r = this.node.clientHeight)),
        !n || !r)
      )
        throw Error(
          `Impossible to get absolute width and height. Please provide an absolute width and height attribute on the zooming element`,
        );
      let i = this.viewbox(),
        a = n / i.width,
        o = r / i.height,
        s = Math.min(a, o);
      if (e == null) return s;
      let c = s / e;
      (c === 1 / 0 && (c = (2 ** 53 - 1) / 100),
        (t ||= new L(n / 2 / a + i.x, r / 2 / o + i.y)));
      let l = new z(i).transform(new R({ scale: c, origin: t }));
      return this.viewbox(l);
    },
  },
}),
  N(z, `Box`));
var en = class extends Array {
  constructor(e = [], ...t) {
    if ((super(e, ...t), typeof e == `number`)) return this;
    ((this.length = 0), this.push(...e));
  }
};
P([en], {
  each(e, ...t) {
    return typeof e == `function`
      ? this.map((t, n, r) => e.call(t, t, n, r))
      : this.map((n) => n[e](...t));
  },
  toArray() {
    return Array.prototype.concat.apply([], this);
  },
});
var tn = [`toArray`, `constructor`, `each`];
en.extend = function (e) {
  ((e = e.reduce(
    (e, t) => (
      tn.includes(t) ||
        t[0] === `_` ||
        (e[t] = function (...e) {
          return this.each(t, ...e);
        }),
      e
    ),
    {},
  )),
    P([en], e));
};
function nn(e, t) {
  return new en(
    je((t || k.document).querySelectorAll(e), function (e) {
      return M(e);
    }),
  );
}
function rn(e) {
  return nn(e, this.node);
}
function an(e) {
  return M(this.node.querySelector(e));
}
var on = 0,
  sn = {};
function cn(e) {
  let t = e.getEventHolder();
  return (t === k.window && (t = sn), (t.events ||= {}), t.events);
}
function ln(e) {
  return e.getEventTarget();
}
function un(e) {
  let t = e.getEventHolder();
  (t === k.window && (t = sn), (t.events &&= {}));
}
function dn(e, t, n, r, i) {
  let a = n.bind(r || e),
    o = A(e),
    s = cn(o),
    c = ln(o);
  ((t = Array.isArray(t) ? t : t.split(St)),
    (n._svgjsListenerId ||= ++on),
    t.forEach(function (e) {
      let t = e.split(`.`)[0],
        r = e.split(`.`)[1] || `*`;
      ((s[t] = s[t] || {}),
        (s[t][r] = s[t][r] || {}),
        (s[t][r][n._svgjsListenerId] = a),
        c.addEventListener(t, a, i || !1));
    }));
}
function fn(e, t, n, r) {
  let i = A(e),
    a = cn(i),
    o = ln(i);
  (typeof n == `function` && ((n = n._svgjsListenerId), !n)) ||
    ((t = Array.isArray(t) ? t : (t || ``).split(St)),
    t.forEach(function (e) {
      let t = e && e.split(`.`)[0],
        s = e && e.split(`.`)[1],
        c,
        l;
      if (n)
        a[t] &&
          a[t][s || `*`] &&
          (o.removeEventListener(t, a[t][s || `*`][n], r || !1),
          delete a[t][s || `*`][n]);
      else if (t && s) {
        if (a[t] && a[t][s]) {
          for (l in a[t][s]) fn(o, [t, s].join(`.`), l);
          delete a[t][s];
        }
      } else if (s)
        for (e in a) for (c in a[e]) s === c && fn(o, [e, s].join(`.`));
      else if (t) {
        if (a[t]) {
          for (c in a[t]) fn(o, [t, c].join(`.`));
          delete a[t];
        }
      } else {
        for (e in a) fn(o, e);
        un(i);
      }
    }));
}
function pn(e, t, n, r) {
  let i = ln(e);
  return (
    t instanceof k.window.Event ||
      (t = new k.window.CustomEvent(t, { detail: n, cancelable: !0, ...r })),
    i.dispatchEvent(t),
    t
  );
}
var mn = class extends We {
  addEventListener() {}
  dispatch(e, t, n) {
    return pn(this, e, t, n);
  }
  dispatchEvent(e) {
    let t = this.getEventHolder().events;
    if (!t) return !0;
    let n = t[e.type];
    for (let t in n) for (let r in n[t]) n[t][r](e);
    return !e.defaultPrevented;
  }
  fire(e, t, n) {
    return (this.dispatch(e, t, n), this);
  }
  getEventHolder() {
    return this;
  }
  getEventTarget() {
    return this;
  }
  off(e, t, n) {
    return (fn(this, e, t, n), this);
  }
  on(e, t, n, r) {
    return (dn(this, e, t, n, r), this);
  }
  removeEventListener() {}
};
N(mn, `EventTarget`);
function hn() {}
var gn = { duration: 400, ease: `>`, delay: 0 },
  _n = {
    "fill-opacity": 1,
    "stroke-opacity": 1,
    "stroke-width": 0,
    "stroke-linejoin": `miter`,
    "stroke-linecap": `butt`,
    fill: `#000000`,
    stroke: `#000000`,
    opacity: 1,
    x: 0,
    y: 0,
    cx: 0,
    cy: 0,
    width: 0,
    height: 0,
    r: 0,
    rx: 0,
    ry: 0,
    offset: 0,
    "stop-opacity": 1,
    "stop-color": `#000000`,
    "text-anchor": `start`,
  },
  vn = class extends Array {
    constructor(...e) {
      (super(...e), this.init(...e));
    }
    clone() {
      return new this.constructor(this);
    }
    init(e) {
      return typeof e == `number`
        ? this
        : ((this.length = 0), this.push(...this.parse(e)), this);
    }
    parse(e = []) {
      return e instanceof Array ? e : e.trim().split(St).map(parseFloat);
    }
    toArray() {
      return Array.prototype.concat.apply([], this);
    }
    toSet() {
      return new Set(this);
    }
    toString() {
      return this.join(` `);
    }
    valueOf() {
      let e = [];
      return (e.push(...this), e);
    }
  },
  B = class e {
    constructor(...e) {
      this.init(...e);
    }
    convert(t) {
      return new e(this.value, t);
    }
    divide(t) {
      return ((t = new e(t)), new e(this / t, this.unit || t.unit));
    }
    init(t, n) {
      return (
        (n = Array.isArray(t) ? t[1] : n),
        (t = Array.isArray(t) ? t[0] : t),
        (this.value = 0),
        (this.unit = n || ``),
        typeof t == `number`
          ? (this.value = isNaN(t)
              ? 0
              : isFinite(t)
                ? t
                : t < 0
                  ? -34e37
                  : 34e37)
          : typeof t == `string`
            ? ((n = t.match(dt)),
              n &&
                ((this.value = parseFloat(n[1])),
                n[5] === `%`
                  ? (this.value /= 100)
                  : n[5] === `s` && (this.value *= 1e3),
                (this.unit = n[5])))
            : t instanceof e &&
              ((this.value = t.valueOf()), (this.unit = t.unit)),
        this
      );
    }
    minus(t) {
      return ((t = new e(t)), new e(this - t, this.unit || t.unit));
    }
    plus(t) {
      return ((t = new e(t)), new e(this + t, this.unit || t.unit));
    }
    times(t) {
      return ((t = new e(t)), new e(this * t, this.unit || t.unit));
    }
    toArray() {
      return [this.value, this.unit];
    }
    toJSON() {
      return this.toString();
    }
    toString() {
      return (
        (this.unit === `%`
          ? ~~(this.value * 1e8) / 1e6
          : this.unit === `s`
            ? this.value / 1e3
            : this.value) + this.unit
      );
    }
    valueOf() {
      return this.value;
    }
  },
  yn = [];
function bn(e) {
  yn.push(e);
}
function xn(e, t, n) {
  if (e == null) {
    ((e = {}), (t = this.node.attributes));
    for (let n of t)
      e[n.nodeName] = bt.test(n.nodeValue)
        ? parseFloat(n.nodeValue)
        : n.nodeValue;
    return e;
  } else if (e instanceof Array)
    return e.reduce((e, t) => ((e[t] = this.attr(t)), e), {});
  else if (typeof e == `object` && e.constructor === Object)
    for (t in e) this.attr(t, e[t]);
  else if (t === null) this.node.removeAttribute(e);
  else if (t == null)
    return (
      (t = this.node.getAttribute(e)),
      t == null ? _n[e] : bt.test(t) ? parseFloat(t) : t
    );
  else
    ((t = yn.reduce((t, n) => n(e, t, this), t)),
      typeof t == `number`
        ? (t = new B(t))
        : I.isColor(t)
          ? (t = new I(t))
          : t.constructor === Array && (t = new vn(t)),
      e === `leading`
        ? this.leading && this.leading(t)
        : typeof n == `string`
          ? this.node.setAttributeNS(n, e, t.toString())
          : this.node.setAttribute(e, t.toString()),
      this.rebuild && (e === `font-size` || e === `x`) && this.rebuild());
  return this;
}
var Sn = class e extends mn {
  constructor(e, t) {
    (super(),
      (this.node = e),
      (this.type = e.nodeName),
      t && e !== t && this.attr(t));
  }
  add(e, t) {
    return (
      (e = A(e)),
      e.removeNamespace &&
        this.node instanceof k.window.SVGElement &&
        e.removeNamespace(),
      t == null
        ? this.node.appendChild(e.node)
        : e.node !== this.node.childNodes[t] &&
          this.node.insertBefore(e.node, this.node.childNodes[t]),
      this
    );
  }
  addTo(e, t) {
    return A(e).put(this, t);
  }
  children() {
    return new en(
      je(this.node.children, function (e) {
        return M(e);
      }),
    );
  }
  clear() {
    for (; this.node.hasChildNodes();)
      this.node.removeChild(this.node.lastChild);
    return this;
  }
  clone(e = !0, t = !0) {
    this.writeDataToDom();
    let n = this.node.cloneNode(e);
    return (t && (n = Qe(n)), new this.constructor(n));
  }
  each(e, t) {
    let n = this.children(),
      r,
      i;
    for (r = 0, i = n.length; r < i; r++)
      (e.apply(n[r], [r, n]), t && n[r].each(e, t));
    return this;
  }
  element(t, n) {
    return this.put(new e(qe(t), n));
  }
  first() {
    return M(this.node.firstChild);
  }
  get(e) {
    return M(this.node.childNodes[e]);
  }
  getEventHolder() {
    return this.node;
  }
  getEventTarget() {
    return this.node;
  }
  has(e) {
    return this.index(e) >= 0;
  }
  html(e, t) {
    return this.xml(e, t, Be);
  }
  id(e) {
    return (
      e === void 0 && !this.node.id && (this.node.id = Ze(this.type)),
      this.attr(`id`, e)
    );
  }
  index(e) {
    return [].slice.call(this.node.childNodes).indexOf(e.node);
  }
  last() {
    return M(this.node.lastChild);
  }
  matches(e) {
    let t = this.node,
      n =
        t.matches ||
        t.matchesSelector ||
        t.msMatchesSelector ||
        t.mozMatchesSelector ||
        t.webkitMatchesSelector ||
        t.oMatchesSelector ||
        null;
    return n && n.call(t, e);
  }
  parent(e) {
    let t = this;
    if (!t.node.parentNode) return null;
    if (((t = M(t.node.parentNode)), !e)) return t;
    do if (typeof e == `string` ? t.matches(e) : t instanceof e) return t;
    while ((t = M(t.node.parentNode)));
    return t;
  }
  put(e, t) {
    return ((e = A(e)), this.add(e, t), e);
  }
  putIn(e, t) {
    return A(e).add(this, t);
  }
  remove() {
    return (this.parent() && this.parent().removeElement(this), this);
  }
  removeElement(e) {
    return (this.node.removeChild(e.node), this);
  }
  replace(e) {
    return (
      (e = A(e)),
      this.node.parentNode &&
        this.node.parentNode.replaceChild(e.node, this.node),
      e
    );
  }
  round(e = 2, t = null) {
    let n = 10 ** e,
      r = this.attr(t);
    for (let e in r)
      typeof r[e] == `number` && (r[e] = Math.round(r[e] * n) / n);
    return (this.attr(r), this);
  }
  svg(e, t) {
    return this.xml(e, t, ze);
  }
  toString() {
    return this.id();
  }
  words(e) {
    return ((this.node.textContent = e), this);
  }
  wrap(e) {
    let t = this.parent();
    if (!t) return this.addTo(e);
    let n = t.index(this);
    return t.put(e, n).put(this);
  }
  writeDataToDom() {
    return (
      this.each(function () {
        this.writeDataToDom();
      }),
      this
    );
  }
  xml(e, t, n) {
    if (
      (typeof e == `boolean` && ((n = t), (t = e), (e = null)),
      e == null || typeof e == `function`)
    ) {
      ((t ??= !0), this.writeDataToDom());
      let n = this;
      if (e != null) {
        if (((n = M(n.node.cloneNode(!0))), t)) {
          let t = e(n);
          if (((n = t || n), t === !1)) return ``;
        }
        n.each(function () {
          let t = e(this),
            n = t || this;
          t === !1 ? this.remove() : t && this !== n && this.replace(n);
        }, !0);
      }
      return t ? n.node.outerHTML : n.node.innerHTML;
    }
    t ??= !1;
    let r = qe(`wrapper`, n),
      i = k.document.createDocumentFragment();
    r.innerHTML = e;
    for (let e = r.children.length; e--;) i.appendChild(r.firstElementChild);
    let a = this.parent();
    return t ? this.replace(i) && a : this.add(i);
  }
};
(P(Sn, { attr: xn, find: rn, findOne: an }), N(Sn, `Dom`));
var V = class extends Sn {
  constructor(e, t) {
    (super(e, t),
      (this.dom = {}),
      (this.node.instance = this),
      e.hasAttribute(`svgjs:data`) &&
        this.setData(JSON.parse(e.getAttribute(`svgjs:data`)) || {}));
  }
  center(e, t) {
    return this.cx(e).cy(t);
  }
  cx(e) {
    return e == null
      ? this.x() + this.width() / 2
      : this.x(e - this.width() / 2);
  }
  cy(e) {
    return e == null
      ? this.y() + this.height() / 2
      : this.y(e - this.height() / 2);
  }
  defs() {
    let e = this.root();
    return e && e.defs();
  }
  dmove(e, t) {
    return this.dx(e).dy(t);
  }
  dx(e = 0) {
    return this.x(new B(e).plus(this.x()));
  }
  dy(e = 0) {
    return this.y(new B(e).plus(this.y()));
  }
  getEventHolder() {
    return this;
  }
  height(e) {
    return this.attr(`height`, e);
  }
  move(e, t) {
    return this.x(e).y(t);
  }
  parents(e = this.root()) {
    let t = typeof e == `string`;
    t || (e = A(e));
    let n = new en(),
      r = this;
    for (
      ;
      (r = r.parent()) &&
      r.node !== k.document &&
      r.nodeName !== `#document-fragment` &&
      (n.push(r), !((!t && r.node === e.node) || (t && r.matches(e))));
    )
      if (r.node === this.root().node) return null;
    return n;
  }
  reference(e) {
    if (((e = this.attr(e)), !e)) return null;
    let t = (e + ``).match(mt);
    return t ? A(t[1]) : null;
  }
  root() {
    let e = this.parent(Ye(Ke));
    return e && e.root();
  }
  setData(e) {
    return ((this.dom = e), this);
  }
  size(e, t) {
    let n = Le(this, e, t);
    return this.width(new B(n.width)).height(new B(n.height));
  }
  width(e) {
    return this.attr(`width`, e);
  }
  writeDataToDom() {
    return (
      this.node.removeAttribute(`svgjs:data`),
      Object.keys(this.dom).length &&
        this.node.setAttribute(`svgjs:data`, JSON.stringify(this.dom)),
      super.writeDataToDom()
    );
  }
  x(e) {
    return this.attr(`x`, e);
  }
  y(e) {
    return this.attr(`y`, e);
  }
};
(P(V, { bbox: Zt, rbox: Qt, inside: $t, point: Ut, ctm: Gt, screenCTM: Kt }),
  N(V, `Element`));
var Cn = {
  stroke: [
    `color`,
    `width`,
    `opacity`,
    `linecap`,
    `linejoin`,
    `miterlimit`,
    `dasharray`,
    `dashoffset`,
  ],
  fill: [`color`, `opacity`, `rule`],
  prefix: function (e, t) {
    return t === `color` ? e : e + `-` + t;
  },
};
([`fill`, `stroke`].forEach(function (e) {
  let t = {},
    n;
  ((t[e] = function (t) {
    if (t === void 0) return this.attr(e);
    if (typeof t == `string` || t instanceof I || I.isRgb(t) || t instanceof V)
      this.attr(e, t);
    else
      for (n = Cn[e].length - 1; n >= 0; n--)
        t[Cn[e][n]] != null && this.attr(Cn.prefix(e, Cn[e][n]), t[Cn[e][n]]);
    return this;
  }),
    D([`Element`, `Runner`], t));
}),
  D([`Element`, `Runner`], {
    matrix: function (e, t, n, r, i, a) {
      return e == null
        ? new R(this)
        : this.attr(`transform`, new R(e, t, n, r, i, a));
    },
    rotate: function (e, t, n) {
      return this.transform({ rotate: e, ox: t, oy: n }, !0);
    },
    skew: function (e, t, n, r) {
      return arguments.length === 1 || arguments.length === 3
        ? this.transform({ skew: e, ox: t, oy: n }, !0)
        : this.transform({ skew: [e, t], ox: n, oy: r }, !0);
    },
    shear: function (e, t, n) {
      return this.transform({ shear: e, ox: t, oy: n }, !0);
    },
    scale: function (e, t, n, r) {
      return arguments.length === 1 || arguments.length === 3
        ? this.transform({ scale: e, ox: t, oy: n }, !0)
        : this.transform({ scale: [e, t], ox: n, oy: r }, !0);
    },
    translate: function (e, t) {
      return this.transform({ translate: [e, t] }, !0);
    },
    relative: function (e, t) {
      return this.transform({ relative: [e, t] }, !0);
    },
    flip: function (e = `both`, t = `center`) {
      return (
        `xybothtrue`.indexOf(e) === -1 && ((t = e), (e = `both`)),
        this.transform({ flip: e, origin: t }, !0)
      );
    },
    opacity: function (e) {
      return this.attr(`opacity`, e);
    },
  }),
  D(`radius`, {
    radius: function (e, t = e) {
      return (this._element || this).type === `radialGradient`
        ? this.attr(`r`, new B(e))
        : this.rx(e).ry(t);
    },
  }),
  D(`Path`, {
    length: function () {
      return this.node.getTotalLength();
    },
    pointAt: function (e) {
      return new L(this.node.getPointAtLength(e));
    },
  }),
  D([`Element`, `Runner`], {
    font: function (e, t) {
      if (typeof e == `object`) {
        for (t in e) this.font(t, e[t]);
        return this;
      }
      return e === `leading`
        ? this.leading(t)
        : e === `anchor`
          ? this.attr(`text-anchor`, t)
          : e === `size` ||
              e === `family` ||
              e === `weight` ||
              e === `stretch` ||
              e === `variant` ||
              e === `style`
            ? this.attr(`font-` + e, t)
            : this.attr(e, t);
    },
  }),
  D(
    `Element`,
    [
      `click`,
      `dblclick`,
      `mousedown`,
      `mouseup`,
      `mouseover`,
      `mouseout`,
      `mousemove`,
      `mouseenter`,
      `mouseleave`,
      `touchstart`,
      `touchmove`,
      `touchleave`,
      `touchend`,
      `touchcancel`,
    ].reduce(function (e, t) {
      return (
        (e[t] = function (e) {
          return (e === null ? this.off(t) : this.on(t, e), this);
        }),
        e
      );
    }, {}),
  ));
function wn() {
  return this.attr(`transform`, null);
}
function Tn() {
  return (this.attr(`transform`) || ``)
    .split(ht)
    .slice(0, -1)
    .map(function (e) {
      let t = e.trim().split(`(`);
      return [
        t[0],
        t[1].split(St).map(function (e) {
          return parseFloat(e);
        }),
      ];
    })
    .reverse()
    .reduce(function (e, t) {
      return t[0] === `matrix`
        ? e.lmultiply(R.fromArray(t[1]))
        : e[t[0]].apply(e, t[1]);
    }, new R());
}
function En(e, t) {
  if (this === e) return this;
  let n = this.screenCTM(),
    r = e.screenCTM().inverse();
  return (this.addTo(e, t).untransform().transform(r.multiply(n)), this);
}
function Dn(e) {
  return this.toParent(this.root(), e);
}
function On(e, t) {
  if (e == null || typeof e == `string`) {
    let t = new R(this).decompose();
    return e == null ? t : t[e];
  }
  R.isMatrixLike(e) || (e = { ...e, origin: Re(e, this) });
  let n = new R(t === !0 ? this : t || !1).transform(e);
  return this.attr(`transform`, n);
}
D(`Element`, {
  untransform: wn,
  matrixify: Tn,
  toParent: En,
  toRoot: Dn,
  transform: On,
});
var H = class e extends V {
  flatten(t = this, n) {
    return (
      this.each(function () {
        if (this instanceof e) return this.flatten().ungroup();
      }),
      this
    );
  }
  ungroup(e = this.parent(), t = e.index(this)) {
    return (
      (t = t === -1 ? e.children().length : t),
      this.each(function (n, r) {
        return r[r.length - n - 1].toParent(e, t);
      }),
      this.remove()
    );
  }
};
N(H, `Container`);
var kn = class extends H {
  constructor(e, t = e) {
    super(j(`defs`, e), t);
  }
  flatten() {
    return this;
  }
  ungroup() {
    return this;
  }
};
N(kn, `Defs`);
var U = class extends V {};
N(U, `Shape`);
function An(e) {
  return this.attr(`rx`, e);
}
function jn(e) {
  return this.attr(`ry`, e);
}
function Mn(e) {
  return e == null ? this.cx() - this.rx() : this.cx(e + this.rx());
}
function Nn(e) {
  return e == null ? this.cy() - this.ry() : this.cy(e + this.ry());
}
function Pn(e) {
  return this.attr(`cx`, e);
}
function Fn(e) {
  return this.attr(`cy`, e);
}
function In(e) {
  return e == null ? this.rx() * 2 : this.rx(new B(e).divide(2));
}
function Ln(e) {
  return e == null ? this.ry() * 2 : this.ry(new B(e).divide(2));
}
var Rn = {
    __proto__: null,
    rx: An,
    ry: jn,
    x: Mn,
    y: Nn,
    cx: Pn,
    cy: Fn,
    width: In,
    height: Ln,
  },
  zn = class extends U {
    constructor(e, t = e) {
      super(j(`ellipse`, e), t);
    }
    size(e, t) {
      let n = Le(this, e, t);
      return this.rx(new B(n.width).divide(2)).ry(new B(n.height).divide(2));
    }
  };
(P(zn, Rn),
  D(`Container`, {
    ellipse: F(function (e = 0, t = e) {
      return this.put(new zn()).size(e, t).move(0, 0);
    }),
  }),
  N(zn, `Ellipse`));
var Bn = class extends Sn {
  constructor(e = k.document.createDocumentFragment()) {
    super(e);
  }
  xml(e, t, n) {
    if (
      (typeof e == `boolean` && ((n = t), (t = e), (e = null)),
      e == null || typeof e == `function`)
    ) {
      let e = new Sn(qe(`wrapper`, n));
      return (e.add(this.node.cloneNode(!0)), e.xml(!1, n));
    }
    return super.xml(e, !1, n);
  }
};
N(Bn, `Fragment`);
function Vn(e, t) {
  return (this._element || this).type === `radialGradient`
    ? this.attr({ fx: new B(e), fy: new B(t) })
    : this.attr({ x1: new B(e), y1: new B(t) });
}
function Hn(e, t) {
  return (this._element || this).type === `radialGradient`
    ? this.attr({ cx: new B(e), cy: new B(t) })
    : this.attr({ x2: new B(e), y2: new B(t) });
}
var Un = { __proto__: null, from: Vn, to: Hn },
  Wn = class extends H {
    constructor(e, t) {
      super(j(e + `Gradient`, typeof e == `string` ? null : e), t);
    }
    attr(e, t, n) {
      return (
        e === `transform` && (e = `gradientTransform`),
        super.attr(e, t, n)
      );
    }
    bbox() {
      return new z();
    }
    targets() {
      return nn(`svg [fill*=` + this.id() + `]`);
    }
    toString() {
      return this.url();
    }
    update(e) {
      return (this.clear(), typeof e == `function` && e.call(this, this), this);
    }
    url() {
      return `url(#` + this.id() + `)`;
    }
  };
(P(Wn, Un),
  D({
    Container: {
      gradient(...e) {
        return this.defs().gradient(...e);
      },
    },
    Defs: {
      gradient: F(function (e, t) {
        return this.put(new Wn(e)).update(t);
      }),
    },
  }),
  N(Wn, `Gradient`));
var Gn = class extends H {
  constructor(e, t = e) {
    super(j(`pattern`, e), t);
  }
  attr(e, t, n) {
    return (e === `transform` && (e = `patternTransform`), super.attr(e, t, n));
  }
  bbox() {
    return new z();
  }
  targets() {
    return nn(`svg [fill*=` + this.id() + `]`);
  }
  toString() {
    return this.url();
  }
  update(e) {
    return (this.clear(), typeof e == `function` && e.call(this, this), this);
  }
  url() {
    return `url(#` + this.id() + `)`;
  }
};
(D({
  Container: {
    pattern(...e) {
      return this.defs().pattern(...e);
    },
  },
  Defs: {
    pattern: F(function (e, t, n) {
      return this.put(new Gn())
        .update(n)
        .attr({
          x: 0,
          y: 0,
          width: e,
          height: t,
          patternUnits: `userSpaceOnUse`,
        });
    }),
  },
}),
  N(Gn, `Pattern`));
var Kn = class extends U {
  constructor(e, t = e) {
    super(j(`image`, e), t);
  }
  load(e, t) {
    if (!e) return this;
    let n = new k.window.Image();
    return (
      dn(
        n,
        `load`,
        function (e) {
          let r = this.parent(Gn);
          (this.width() === 0 &&
            this.height() === 0 &&
            this.size(n.width, n.height),
            r instanceof Gn &&
              r.width() === 0 &&
              r.height() === 0 &&
              r.size(this.width(), this.height()),
            typeof t == `function` && t.call(this, e));
        },
        this,
      ),
      dn(n, `load error`, function () {
        fn(n);
      }),
      this.attr(`href`, (n.src = e), He)
    );
  }
};
(bn(function (e, t, n) {
  return (
    (e === `fill` || e === `stroke`) &&
      xt.test(t) &&
      (t = n.root().defs().image(t)),
    t instanceof Kn &&
      (t = n
        .root()
        .defs()
        .pattern(0, 0, (e) => {
          e.add(t);
        })),
    t
  );
}),
  D({
    Container: {
      image: F(function (e, t) {
        return this.put(new Kn()).size(0, 0).load(e, t);
      }),
    },
  }),
  N(Kn, `Image`));
var qn = class extends vn {
    bbox() {
      let e = -1 / 0,
        t = -1 / 0,
        n = 1 / 0,
        r = 1 / 0;
      return (
        this.forEach(function (i) {
          ((e = Math.max(i[0], e)),
            (t = Math.max(i[1], t)),
            (n = Math.min(i[0], n)),
            (r = Math.min(i[1], r)));
        }),
        new z(n, r, e - n, t - r)
      );
    }
    move(e, t) {
      let n = this.bbox();
      if (((e -= n.x), (t -= n.y), !isNaN(e) && !isNaN(t)))
        for (let n = this.length - 1; n >= 0; n--)
          this[n] = [this[n][0] + e, this[n][1] + t];
      return this;
    }
    parse(e = [0, 0]) {
      let t = [];
      ((e =
        e instanceof Array
          ? Array.prototype.concat.apply([], e)
          : e.trim().split(St).map(parseFloat)),
        e.length % 2 != 0 && e.pop());
      for (let n = 0, r = e.length; n < r; n += 2) t.push([e[n], e[n + 1]]);
      return t;
    }
    size(e, t) {
      let n,
        r = this.bbox();
      for (n = this.length - 1; n >= 0; n--)
        (r.width && (this[n][0] = ((this[n][0] - r.x) * e) / r.width + r.x),
          r.height && (this[n][1] = ((this[n][1] - r.y) * t) / r.height + r.y));
      return this;
    }
    toLine() {
      return { x1: this[0][0], y1: this[0][1], x2: this[1][0], y2: this[1][1] };
    }
    toString() {
      let e = [];
      for (let t = 0, n = this.length; t < n; t++) e.push(this[t].join(`,`));
      return e.join(` `);
    }
    transform(e) {
      return this.clone().transformO(e);
    }
    transformO(e) {
      R.isMatrixLike(e) || (e = new R(e));
      for (let t = this.length; t--;) {
        let [n, r] = this[t];
        ((this[t][0] = e.a * n + e.c * r + e.e),
          (this[t][1] = e.b * n + e.d * r + e.f));
      }
      return this;
    }
  },
  Jn = qn;
function Yn(e) {
  return e == null ? this.bbox().x : this.move(e, this.bbox().y);
}
function Xn(e) {
  return e == null ? this.bbox().y : this.move(this.bbox().x, e);
}
function Zn(e) {
  let t = this.bbox();
  return e == null ? t.width : this.size(e, t.height);
}
function Qn(e) {
  let t = this.bbox();
  return e == null ? t.height : this.size(t.width, e);
}
var $n = {
    __proto__: null,
    MorphArray: Jn,
    x: Yn,
    y: Xn,
    width: Zn,
    height: Qn,
  },
  er = class extends U {
    constructor(e, t = e) {
      super(j(`line`, e), t);
    }
    array() {
      return new qn([
        [this.attr(`x1`), this.attr(`y1`)],
        [this.attr(`x2`), this.attr(`y2`)],
      ]);
    }
    move(e, t) {
      return this.attr(this.array().move(e, t).toLine());
    }
    plot(e, t, n, r) {
      return e == null
        ? this.array()
        : ((e =
            t === void 0 ? new qn(e).toLine() : { x1: e, y1: t, x2: n, y2: r }),
          this.attr(e));
    }
    size(e, t) {
      let n = Le(this, e, t);
      return this.attr(this.array().size(n.width, n.height).toLine());
    }
  };
(P(er, $n),
  D({
    Container: {
      line: F(function (...e) {
        return er.prototype.plot.apply(
          this.put(new er()),
          e[0] == null ? [0, 0, 0, 0] : e,
        );
      }),
    },
  }),
  N(er, `Line`));
var tr = class extends H {
  constructor(e, t = e) {
    super(j(`marker`, e), t);
  }
  height(e) {
    return this.attr(`markerHeight`, e);
  }
  orient(e) {
    return this.attr(`orient`, e);
  }
  ref(e, t) {
    return this.attr(`refX`, e).attr(`refY`, t);
  }
  toString() {
    return `url(#` + this.id() + `)`;
  }
  update(e) {
    return (this.clear(), typeof e == `function` && e.call(this, this), this);
  }
  width(e) {
    return this.attr(`markerWidth`, e);
  }
};
(D({
  Container: {
    marker(...e) {
      return this.defs().marker(...e);
    },
  },
  Defs: {
    marker: F(function (e, t, n) {
      return this.put(new tr())
        .size(e, t)
        .ref(e / 2, t / 2)
        .viewbox(0, 0, e, t)
        .attr(`orient`, `auto`)
        .update(n);
    }),
  },
  marker: {
    marker(e, t, n, r) {
      let i = [`marker`];
      return (
        e !== `all` && i.push(e),
        (i = i.join(`-`)),
        (e =
          arguments[1] instanceof tr
            ? arguments[1]
            : this.defs().marker(t, n, r)),
        this.attr(i, e)
      );
    },
  },
}),
  N(tr, `Marker`));
function nr(e, t) {
  return function (n) {
    return n == null ? this[e] : ((this[e] = n), t && t.call(this), this);
  };
}
var rr = {
    "-": function (e) {
      return e;
    },
    "<>": function (e) {
      return -Math.cos(e * Math.PI) / 2 + 0.5;
    },
    ">": function (e) {
      return Math.sin((e * Math.PI) / 2);
    },
    "<": function (e) {
      return -Math.cos((e * Math.PI) / 2) + 1;
    },
    bezier: function (e, t, n, r) {
      return function (i) {
        return i < 0
          ? e > 0
            ? (t / e) * i
            : n > 0
              ? (r / n) * i
              : 0
          : i > 1
            ? n < 1
              ? ((1 - r) / (1 - n)) * i + (r - n) / (1 - n)
              : e < 1
                ? ((1 - t) / (1 - e)) * i + (t - e) / (1 - e)
                : 1
            : 3 * i * (1 - i) ** 2 * t + 3 * i ** 2 * (1 - i) * r + i ** 3;
      };
    },
    steps: function (e, t = `end`) {
      t = t.split(`-`).reverse()[0];
      let n = e;
      return (
        t === `none` ? --n : t === `both` && ++n,
        (r, i = !1) => {
          let a = Math.floor(r * e),
            o = (r * a) % 1 == 0;
          return (
            (t === `start` || t === `both`) && ++a,
            i && o && --a,
            r >= 0 && a < 0 && (a = 0),
            r <= 1 && a > n && (a = n),
            a / n
          );
        }
      );
    },
  },
  ir = class {
    done() {
      return !1;
    }
  },
  ar = class extends ir {
    constructor(e = gn.ease) {
      (super(), (this.ease = rr[e] || e));
    }
    step(e, t, n) {
      return typeof e == `number` ? e + (t - e) * this.ease(n) : n < 1 ? e : t;
    }
  },
  or = class extends ir {
    constructor(e) {
      (super(), (this.stepper = e));
    }
    done(e) {
      return e.done;
    }
    step(e, t, n, r) {
      return this.stepper(e, t, n, r);
    }
  };
function sr() {
  let e = (this._duration || 500) / 1e3,
    t = this._overshoot || 0,
    n = Math.PI,
    r = Math.log(t / 100 + 1e-10),
    i = -r / Math.sqrt(n * n + r * r),
    a = 3.9 / (i * e);
  ((this.d = 2 * i * a), (this.k = a * a));
}
(P(
  class extends or {
    constructor(e = 500, t = 0) {
      (super(), this.duration(e).overshoot(t));
    }
    step(e, t, n, r) {
      if (typeof e == `string`) return e;
      if (((r.done = n === 1 / 0), n === 1 / 0)) return t;
      if (n === 0) return e;
      (n > 100 && (n = 16), (n /= 1e3));
      let i = r.velocity || 0,
        a = -this.d * i - this.k * (e - t),
        o = e + i * n + (a * n * n) / 2;
      return (
        (r.velocity = i + a * n),
        (r.done = Math.abs(t - o) + Math.abs(i) < 0.002),
        r.done ? t : o
      );
    }
  },
  { duration: nr(`_duration`, sr), overshoot: nr(`_overshoot`, sr) },
),
  P(
    class extends or {
      constructor(e = 0.1, t = 0.01, n = 0, r = 1e3) {
        (super(), this.p(e).i(t).d(n).windup(r));
      }
      step(e, t, n, r) {
        if (typeof e == `string`) return e;
        if (((r.done = n === 1 / 0), n === 1 / 0)) return t;
        if (n === 0) return e;
        let i = t - e,
          a = (r.integral || 0) + i * n,
          o = (i - (r.error || 0)) / n,
          s = this._windup;
        return (
          s !== !1 && (a = Math.max(-s, Math.min(a, s))),
          (r.error = i),
          (r.integral = a),
          (r.done = Math.abs(i) < 0.001),
          r.done ? t : e + (this.P * i + this.I * a + this.D * o)
        );
      }
    },
    { windup: nr(`_windup`), p: nr(`P`), i: nr(`I`), d: nr(`D`) },
  ));
var cr = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 },
  lr = {
    M: function (e, t, n) {
      return ((t.x = n.x = e[0]), (t.y = n.y = e[1]), [`M`, t.x, t.y]);
    },
    L: function (e, t) {
      return ((t.x = e[0]), (t.y = e[1]), [`L`, e[0], e[1]]);
    },
    H: function (e, t) {
      return ((t.x = e[0]), [`H`, e[0]]);
    },
    V: function (e, t) {
      return ((t.y = e[0]), [`V`, e[0]]);
    },
    C: function (e, t) {
      return (
        (t.x = e[4]),
        (t.y = e[5]),
        [`C`, e[0], e[1], e[2], e[3], e[4], e[5]]
      );
    },
    S: function (e, t) {
      return ((t.x = e[2]), (t.y = e[3]), [`S`, e[0], e[1], e[2], e[3]]);
    },
    Q: function (e, t) {
      return ((t.x = e[2]), (t.y = e[3]), [`Q`, e[0], e[1], e[2], e[3]]);
    },
    T: function (e, t) {
      return ((t.x = e[0]), (t.y = e[1]), [`T`, e[0], e[1]]);
    },
    Z: function (e, t, n) {
      return ((t.x = n.x), (t.y = n.y), [`Z`]);
    },
    A: function (e, t) {
      return (
        (t.x = e[5]),
        (t.y = e[6]),
        [`A`, e[0], e[1], e[2], e[3], e[4], e[5], e[6]]
      );
    },
  },
  ur = `mlhvqtcsaz`.split(``);
for (let e = 0, t = ur.length; e < t; ++e)
  lr[ur[e]] = (function (e) {
    return function (t, n, r) {
      if (e === `H`) t[0] += n.x;
      else if (e === `V`) t[0] += n.y;
      else if (e === `A`) ((t[5] += n.x), (t[6] += n.y));
      else
        for (let e = 0, r = t.length; e < r; ++e)
          t[e] = t[e] + (e % 2 ? n.y : n.x);
      return lr[e](t, n, r);
    };
  })(ur[e].toUpperCase());
function dr(e) {
  return lr[e.segment[0]](e.segment.slice(1), e.p, e.p0);
}
function fr(e) {
  return (
    e.segment.length && e.segment.length - 1 === cr[e.segment[0].toUpperCase()]
  );
}
function pr(e, t) {
  e.inNumber && mr(e, !1);
  let n = Ct.test(t);
  if (n) e.segment = [t];
  else {
    let t = e.lastCommand,
      n = t.toLowerCase();
    e.segment = [n === `m` ? (t === n ? `l` : `L`) : t];
  }
  return ((e.inSegment = !0), (e.lastCommand = e.segment[0]), n);
}
function mr(e, t) {
  if (!e.inNumber) throw Error(`Parser Error`);
  (e.number && e.segment.push(parseFloat(e.number)),
    (e.inNumber = t),
    (e.number = ``),
    (e.pointSeen = !1),
    (e.hasExponent = !1),
    fr(e) && hr(e));
}
function hr(e) {
  ((e.inSegment = !1),
    e.absolute && (e.segment = dr(e)),
    e.segments.push(e.segment));
}
function gr(e) {
  if (!e.segment.length) return !1;
  let t = e.segment[0].toUpperCase() === `A`,
    n = e.segment.length;
  return t && (n === 4 || n === 5);
}
function _r(e) {
  return e.lastToken.toUpperCase() === `E`;
}
function vr(e, t = !0) {
  let n = 0,
    r = ``,
    i = {
      segment: [],
      inNumber: !1,
      number: ``,
      lastToken: ``,
      inSegment: !1,
      segments: [],
      pointSeen: !1,
      hasExponent: !1,
      absolute: t,
      p0: new L(),
      p: new L(),
    };
  for (; (i.lastToken = r), (r = e.charAt(n++));)
    if (!(!i.inSegment && pr(i, r))) {
      if (r === `.`) {
        if (i.pointSeen || i.hasExponent) {
          (mr(i, !1), --n);
          continue;
        }
        ((i.inNumber = !0), (i.pointSeen = !0), (i.number += r));
        continue;
      }
      if (!isNaN(parseInt(r))) {
        if (i.number === `0` || gr(i)) {
          ((i.inNumber = !0), (i.number = r), mr(i, !0));
          continue;
        }
        ((i.inNumber = !0), (i.number += r));
        continue;
      }
      if (r === ` ` || r === `,`) {
        i.inNumber && mr(i, !1);
        continue;
      }
      if (r === `-`) {
        if (i.inNumber && !_r(i)) {
          (mr(i, !1), --n);
          continue;
        }
        ((i.number += r), (i.inNumber = !0));
        continue;
      }
      if (r.toUpperCase() === `E`) {
        ((i.number += r), (i.hasExponent = !0));
        continue;
      }
      if (Ct.test(r)) {
        if (i.inNumber) mr(i, !1);
        else if (fr(i)) hr(i);
        else throw Error(`parser Error`);
        --n;
      }
    }
  return (i.inNumber && mr(i, !1), i.inSegment && fr(i) && hr(i), i.segments);
}
function yr(e) {
  let t = ``;
  for (let n = 0, r = e.length; n < r; n++)
    ((t += e[n][0]),
      e[n][1] != null &&
        ((t += e[n][1]),
        e[n][2] != null &&
          ((t += ` `),
          (t += e[n][2]),
          e[n][3] != null &&
            ((t += ` `),
            (t += e[n][3]),
            (t += ` `),
            (t += e[n][4]),
            e[n][5] != null &&
              ((t += ` `),
              (t += e[n][5]),
              (t += ` `),
              (t += e[n][6]),
              e[n][7] != null && ((t += ` `), (t += e[n][7])))))));
  return t + ` `;
}
var br = class extends vn {
    bbox() {
      return (
        qt().path.setAttribute(`d`, this.toString()),
        new z(qt.nodes.path.getBBox())
      );
    }
    move(e, t) {
      let n = this.bbox();
      if (((e -= n.x), (t -= n.y), !isNaN(e) && !isNaN(t)))
        for (let n, r = this.length - 1; r >= 0; r--)
          ((n = this[r][0]),
            n === `M` || n === `L` || n === `T`
              ? ((this[r][1] += e), (this[r][2] += t))
              : n === `H`
                ? (this[r][1] += e)
                : n === `V`
                  ? (this[r][1] += t)
                  : n === `C` || n === `S` || n === `Q`
                    ? ((this[r][1] += e),
                      (this[r][2] += t),
                      (this[r][3] += e),
                      (this[r][4] += t),
                      n === `C` && ((this[r][5] += e), (this[r][6] += t)))
                    : n === `A` && ((this[r][6] += e), (this[r][7] += t)));
      return this;
    }
    parse(e = `M0 0`) {
      return (
        Array.isArray(e) &&
          (e = Array.prototype.concat.apply([], e).toString()),
        vr(e)
      );
    }
    size(e, t) {
      let n = this.bbox(),
        r,
        i;
      for (
        n.width = n.width === 0 ? 1 : n.width,
          n.height = n.height === 0 ? 1 : n.height,
          r = this.length - 1;
        r >= 0;
        r--
      )
        ((i = this[r][0]),
          i === `M` || i === `L` || i === `T`
            ? ((this[r][1] = ((this[r][1] - n.x) * e) / n.width + n.x),
              (this[r][2] = ((this[r][2] - n.y) * t) / n.height + n.y))
            : i === `H`
              ? (this[r][1] = ((this[r][1] - n.x) * e) / n.width + n.x)
              : i === `V`
                ? (this[r][1] = ((this[r][1] - n.y) * t) / n.height + n.y)
                : i === `C` || i === `S` || i === `Q`
                  ? ((this[r][1] = ((this[r][1] - n.x) * e) / n.width + n.x),
                    (this[r][2] = ((this[r][2] - n.y) * t) / n.height + n.y),
                    (this[r][3] = ((this[r][3] - n.x) * e) / n.width + n.x),
                    (this[r][4] = ((this[r][4] - n.y) * t) / n.height + n.y),
                    i === `C` &&
                      ((this[r][5] = ((this[r][5] - n.x) * e) / n.width + n.x),
                      (this[r][6] = ((this[r][6] - n.y) * t) / n.height + n.y)))
                  : i === `A` &&
                    ((this[r][1] = (this[r][1] * e) / n.width),
                    (this[r][2] = (this[r][2] * t) / n.height),
                    (this[r][6] = ((this[r][6] - n.x) * e) / n.width + n.x),
                    (this[r][7] = ((this[r][7] - n.y) * t) / n.height + n.y)));
      return this;
    }
    toString() {
      return yr(this);
    }
  },
  xr = (e) => {
    let t = typeof e;
    return t === `number`
      ? B
      : t === `string`
        ? I.isColor(e)
          ? I
          : St.test(e)
            ? Ct.test(e)
              ? br
              : vn
            : dt.test(e)
              ? B
              : Cr
        : Dr.indexOf(e.constructor) > -1
          ? e.constructor
          : Array.isArray(e)
            ? vn
            : t === `object`
              ? Er
              : Cr;
  },
  Sr = class {
    constructor(e) {
      ((this._stepper = e || new ar(`-`)),
        (this._from = null),
        (this._to = null),
        (this._type = null),
        (this._context = null),
        (this._morphObj = null));
    }
    at(e) {
      return this._morphObj.morph(
        this._from,
        this._to,
        e,
        this._stepper,
        this._context,
      );
    }
    done() {
      return this._context.map(this._stepper.done).reduce(function (e, t) {
        return e && t;
      }, !0);
    }
    from(e) {
      return e == null ? this._from : ((this._from = this._set(e)), this);
    }
    stepper(e) {
      return e == null ? this._stepper : ((this._stepper = e), this);
    }
    to(e) {
      return e == null ? this._to : ((this._to = this._set(e)), this);
    }
    type(e) {
      return e == null ? this._type : ((this._type = e), this);
    }
    _set(e) {
      this._type || this.type(xr(e));
      let t = new this._type(e);
      return (
        this._type === I &&
          (t = this._to
            ? t[this._to[4]]()
            : this._from
              ? t[this._from[4]]()
              : t),
        this._type === Er &&
          (t = this._to
            ? t.align(this._to)
            : this._from
              ? t.align(this._from)
              : t),
        (t = t.toConsumable()),
        (this._morphObj = this._morphObj || new this._type()),
        (this._context =
          this._context ||
          Array.apply(null, Array(t.length))
            .map(Object)
            .map(function (e) {
              return ((e.done = !0), e);
            })),
        t
      );
    }
  },
  Cr = class {
    constructor(...e) {
      this.init(...e);
    }
    init(e) {
      return ((e = Array.isArray(e) ? e[0] : e), (this.value = e), this);
    }
    toArray() {
      return [this.value];
    }
    valueOf() {
      return this.value;
    }
  },
  wr = class e {
    constructor(...e) {
      this.init(...e);
    }
    init(t) {
      return (
        Array.isArray(t) &&
          (t = {
            scaleX: t[0],
            scaleY: t[1],
            shear: t[2],
            rotate: t[3],
            translateX: t[4],
            translateY: t[5],
            originX: t[6],
            originY: t[7],
          }),
        Object.assign(this, e.defaults, t),
        this
      );
    }
    toArray() {
      let e = this;
      return [
        e.scaleX,
        e.scaleY,
        e.shear,
        e.rotate,
        e.translateX,
        e.translateY,
        e.originX,
        e.originY,
      ];
    }
  };
wr.defaults = {
  scaleX: 1,
  scaleY: 1,
  shear: 0,
  rotate: 0,
  translateX: 0,
  translateY: 0,
  originX: 0,
  originY: 0,
};
var Tr = (e, t) => (e[0] < t[0] ? -1 : +(e[0] > t[0])),
  Er = class {
    constructor(...e) {
      this.init(...e);
    }
    align(e) {
      let t = this.values;
      for (let n = 0, r = t.length; n < r; ++n) {
        if (t[n + 1] === e[n + 1]) {
          if (t[n + 1] === I && e[n + 7] !== t[n + 7]) {
            let t = e[n + 7],
              r = new I(this.values.splice(n + 3, 5))[t]().toArray();
            this.values.splice(n + 3, 0, ...r);
          }
          n += t[n + 2] + 2;
          continue;
        }
        if (!e[n + 1]) return this;
        let r = new e[n + 1]().toArray(),
          i = t[n + 2] + 3;
        (t.splice(n, i, e[n], e[n + 1], e[n + 2], ...r), (n += t[n + 2] + 2));
      }
      return this;
    }
    init(e) {
      if (((this.values = []), Array.isArray(e))) {
        this.values = e.slice();
        return;
      }
      e ||= {};
      let t = [];
      for (let n in e) {
        let r = xr(e[n]),
          i = new r(e[n]).toArray();
        t.push([n, r, i.length, ...i]);
      }
      return (
        t.sort(Tr),
        (this.values = t.reduce((e, t) => e.concat(t), [])),
        this
      );
    }
    toArray() {
      return this.values;
    }
    valueOf() {
      let e = {},
        t = this.values;
      for (; t.length;) {
        let n = t.shift(),
          r = t.shift(),
          i = t.shift();
        e[n] = new r(t.splice(0, i));
      }
      return e;
    }
  },
  Dr = [Cr, wr, Er];
function Or(e = []) {
  Dr.push(...[].concat(e));
}
function kr() {
  P(Dr, {
    to(e) {
      return new Sr().type(this.constructor).from(this.toArray()).to(e);
    },
    fromArray(e) {
      return (this.init(e), this);
    },
    toConsumable() {
      return this.toArray();
    },
    morph(e, t, n, r, i) {
      return this.fromArray(
        e.map(function (e, a) {
          return r.step(e, t[a], n, i[a], i);
        }),
      );
    },
  });
}
var Ar = class extends U {
  constructor(e, t = e) {
    super(j(`path`, e), t);
  }
  array() {
    return (this._array ||= new br(this.attr(`d`)));
  }
  clear() {
    return (delete this._array, this);
  }
  height(e) {
    return e == null ? this.bbox().height : this.size(this.bbox().width, e);
  }
  move(e, t) {
    return this.attr(`d`, this.array().move(e, t));
  }
  plot(e) {
    return e == null
      ? this.array()
      : this.clear().attr(
          `d`,
          typeof e == `string` ? e : (this._array = new br(e)),
        );
  }
  size(e, t) {
    let n = Le(this, e, t);
    return this.attr(`d`, this.array().size(n.width, n.height));
  }
  width(e) {
    return e == null ? this.bbox().width : this.size(e, this.bbox().height);
  }
  x(e) {
    return e == null ? this.bbox().x : this.move(e, this.bbox().y);
  }
  y(e) {
    return e == null ? this.bbox().y : this.move(this.bbox().x, e);
  }
};
((Ar.prototype.MorphArray = br),
  D({
    Container: {
      path: F(function (e) {
        return this.put(new Ar()).plot(e || new br());
      }),
    },
  }),
  N(Ar, `Path`));
function jr() {
  return (this._array ||= new qn(this.attr(`points`)));
}
function Mr() {
  return (delete this._array, this);
}
function Nr(e, t) {
  return this.attr(`points`, this.array().move(e, t));
}
function Pr(e) {
  return e == null
    ? this.array()
    : this.clear().attr(
        `points`,
        typeof e == `string` ? e : (this._array = new qn(e)),
      );
}
function Fr(e, t) {
  let n = Le(this, e, t);
  return this.attr(`points`, this.array().size(n.width, n.height));
}
var Ir = {
    __proto__: null,
    array: jr,
    clear: Mr,
    move: Nr,
    plot: Pr,
    size: Fr,
  },
  Lr = class extends U {
    constructor(e, t = e) {
      super(j(`polygon`, e), t);
    }
  };
(D({
  Container: {
    polygon: F(function (e) {
      return this.put(new Lr()).plot(e || new qn());
    }),
  },
}),
  P(Lr, $n),
  P(Lr, Ir),
  N(Lr, `Polygon`));
var Rr = class extends U {
  constructor(e, t = e) {
    super(j(`polyline`, e), t);
  }
};
(D({
  Container: {
    polyline: F(function (e) {
      return this.put(new Rr()).plot(e || new qn());
    }),
  },
}),
  P(Rr, $n),
  P(Rr, Ir),
  N(Rr, `Polyline`));
var W = class extends U {
  constructor(e, t = e) {
    super(j(`rect`, e), t);
  }
};
(P(W, { rx: An, ry: jn }),
  D({
    Container: {
      rect: F(function (e, t) {
        return this.put(new W()).size(e, t);
      }),
    },
  }),
  N(W, `Rect`));
var zr = class {
    constructor() {
      ((this._first = null), (this._last = null));
    }
    first() {
      return this._first && this._first.value;
    }
    last() {
      return this._last && this._last.value;
    }
    push(e) {
      let t = e.next === void 0 ? { value: e, next: null, prev: null } : e;
      return (
        this._last
          ? ((t.prev = this._last), (this._last.next = t), (this._last = t))
          : ((this._last = t), (this._first = t)),
        t
      );
    }
    remove(e) {
      (e.prev && (e.prev.next = e.next),
        e.next && (e.next.prev = e.prev),
        e === this._last && (this._last = e.prev),
        e === this._first && (this._first = e.next),
        (e.prev = null),
        (e.next = null));
    }
    shift() {
      let e = this._first;
      return e
        ? ((this._first = e.next),
          this._first && (this._first.prev = null),
          (this._last = this._first ? this._last : null),
          e.value)
        : null;
    }
  },
  G = {
    nextDraw: null,
    frames: new zr(),
    timeouts: new zr(),
    immediates: new zr(),
    timer: () => k.window.performance || k.window.Date,
    transforms: [],
    frame(e) {
      let t = G.frames.push({ run: e });
      return (
        G.nextDraw === null &&
          (G.nextDraw = k.window.requestAnimationFrame(G._draw)),
        t
      );
    },
    timeout(e, t) {
      t ||= 0;
      let n = G.timer().now() + t,
        r = G.timeouts.push({ run: e, time: n });
      return (
        G.nextDraw === null &&
          (G.nextDraw = k.window.requestAnimationFrame(G._draw)),
        r
      );
    },
    immediate(e) {
      let t = G.immediates.push(e);
      return (
        G.nextDraw === null &&
          (G.nextDraw = k.window.requestAnimationFrame(G._draw)),
        t
      );
    },
    cancelFrame(e) {
      e != null && G.frames.remove(e);
    },
    clearTimeout(e) {
      e != null && G.timeouts.remove(e);
    },
    cancelImmediate(e) {
      e != null && G.immediates.remove(e);
    },
    _draw(e) {
      let t = null,
        n = G.timeouts.last();
      for (
        ;
        (t = G.timeouts.shift()) &&
        (e >= t.time ? t.run() : G.timeouts.push(t), t !== n);
      );
      let r = null,
        i = G.frames.last();
      for (; r !== i && (r = G.frames.shift());) r.run(e);
      let a = null;
      for (; (a = G.immediates.shift());) a();
      G.nextDraw =
        G.timeouts.first() || G.frames.first()
          ? k.window.requestAnimationFrame(G._draw)
          : null;
    },
  },
  Br = function (e) {
    let t = e.start,
      n = e.runner.duration();
    return { start: t, duration: n, end: t + n, runner: e.runner };
  },
  Vr = function () {
    let e = k.window;
    return (e.performance || e.Date).now();
  },
  Hr = class extends mn {
    constructor(e = Vr) {
      (super(),
        (this._timeSource = e),
        (this._startTime = 0),
        (this._speed = 1),
        (this._persist = 0),
        (this._nextFrame = null),
        (this._paused = !0),
        (this._runners = []),
        (this._runnerIds = []),
        (this._lastRunnerId = -1),
        (this._time = 0),
        (this._lastSourceTime = 0),
        (this._lastStepTime = 0),
        (this._step = this._stepFn.bind(this, !1)),
        (this._stepImmediate = this._stepFn.bind(this, !0)));
    }
    active() {
      return !!this._nextFrame;
    }
    finish() {
      return (this.time(this.getEndTimeOfTimeline() + 1), this.pause());
    }
    getEndTime() {
      let e = this.getLastRunnerInfo(),
        t = e ? e.runner.duration() : 0;
      return (e ? e.start : this._time) + t;
    }
    getEndTimeOfTimeline() {
      let e = this._runners.map((e) => e.start + e.runner.duration());
      return Math.max(0, ...e);
    }
    getLastRunnerInfo() {
      return this.getRunnerInfoById(this._lastRunnerId);
    }
    getRunnerInfoById(e) {
      return this._runners[this._runnerIds.indexOf(e)] || null;
    }
    pause() {
      return ((this._paused = !0), this._continue());
    }
    persist(e) {
      return e == null ? this._persist : ((this._persist = e), this);
    }
    play() {
      return ((this._paused = !1), this.updateTime()._continue());
    }
    reverse(e) {
      let t = this.speed();
      if (e == null) return this.speed(-t);
      let n = Math.abs(t);
      return this.speed(e ? -n : n);
    }
    schedule(e, t, n) {
      if (e == null) return this._runners.map(Br);
      let r = 0,
        i = this.getEndTime();
      if (((t ||= 0), n == null || n === `last` || n === `after`)) r = i;
      else if (n === `absolute` || n === `start`) ((r = t), (t = 0));
      else if (n === `now`) r = this._time;
      else if (n === `relative`) {
        let n = this.getRunnerInfoById(e.id);
        n && ((r = n.start + t), (t = 0));
      } else if (n === `with-last`) {
        let e = this.getLastRunnerInfo();
        r = e ? e.start : this._time;
      } else throw Error(`Invalid value for the "when" parameter`);
      (e.unschedule(), e.timeline(this));
      let a = e.persist(),
        o = {
          persist: a === null ? this._persist : a,
          start: r + t,
          runner: e,
        };
      return (
        (this._lastRunnerId = e.id),
        this._runners.push(o),
        this._runners.sort((e, t) => e.start - t.start),
        (this._runnerIds = this._runners.map((e) => e.runner.id)),
        this.updateTime()._continue(),
        this
      );
    }
    seek(e) {
      return this.time(this._time + e);
    }
    source(e) {
      return e == null ? this._timeSource : ((this._timeSource = e), this);
    }
    speed(e) {
      return e == null ? this._speed : ((this._speed = e), this);
    }
    stop() {
      return (this.time(0), this.pause());
    }
    time(e) {
      return e == null ? this._time : ((this._time = e), this._continue(!0));
    }
    unschedule(e) {
      let t = this._runnerIds.indexOf(e.id);
      return t < 0
        ? this
        : (this._runners.splice(t, 1),
          this._runnerIds.splice(t, 1),
          e.timeline(null),
          this);
    }
    updateTime() {
      return (
        this.active() || (this._lastSourceTime = this._timeSource()),
        this
      );
    }
    _continue(e = !1) {
      return (
        G.cancelFrame(this._nextFrame),
        (this._nextFrame = null),
        e
          ? this._stepImmediate()
          : (this._paused || (this._nextFrame = G.frame(this._step)), this)
      );
    }
    _stepFn(e = !1) {
      let t = this._timeSource(),
        n = t - this._lastSourceTime;
      e && (n = 0);
      let r = this._speed * n + (this._time - this._lastStepTime);
      ((this._lastSourceTime = t),
        e ||
          ((this._time += r), (this._time = this._time < 0 ? 0 : this._time)),
        (this._lastStepTime = this._time),
        this.fire(`time`, this._time));
      for (let e = this._runners.length; e--;) {
        let t = this._runners[e],
          n = t.runner;
        this._time - t.start <= 0 && n.reset();
      }
      let i = !1;
      for (let e = 0, t = this._runners.length; e < t; e++) {
        let n = this._runners[e],
          a = n.runner,
          o = r,
          s = this._time - n.start;
        if (s <= 0) {
          i = !0;
          continue;
        } else s < o && (o = s);
        a.active() &&
          (a.step(o).done
            ? n.persist !== !0 &&
              a.duration() - a.time() + this._time + n.persist < this._time &&
              (a.unschedule(), --e, --t)
            : (i = !0));
      }
      return (
        (i && !(this._speed < 0 && this._time === 0)) ||
        (this._runnerIds.length && this._speed < 0 && this._time > 0)
          ? this._continue()
          : (this.pause(), this.fire(`finished`)),
        this
      );
    }
  };
D({
  Element: {
    timeline: function (e) {
      return e == null
        ? ((this._timeline = this._timeline || new Hr()), this._timeline)
        : ((this._timeline = e), this);
    },
  },
});
var Ur = class e extends mn {
  constructor(t) {
    (super(),
      (this.id = e.id++),
      (t ??= gn.duration),
      (t = typeof t == `function` ? new or(t) : t),
      (this._element = null),
      (this._timeline = null),
      (this.done = !1),
      (this._queue = []),
      (this._duration = typeof t == `number` && t),
      (this._isDeclarative = t instanceof or),
      (this._stepper = this._isDeclarative ? t : new ar()),
      (this._history = {}),
      (this.enabled = !0),
      (this._time = 0),
      (this._lastTime = 0),
      (this._reseted = !0),
      (this.transforms = new R()),
      (this.transformId = 1),
      (this._haveReversed = !1),
      (this._reverse = !1),
      (this._loopsDone = 0),
      (this._swing = !1),
      (this._wait = 0),
      (this._times = 1),
      (this._frameId = null),
      (this._persist = this._isDeclarative ? !0 : null));
  }
  static sanitise(e, t, n) {
    let r = 1,
      i = !1,
      a = 0;
    return (
      (e ||= gn.duration),
      (t ||= gn.delay),
      (n ||= `last`),
      typeof e == `object` &&
        !(e instanceof ir) &&
        ((t = e.delay || t),
        (n = e.when || n),
        (i = e.swing || i),
        (r = e.times || r),
        (a = e.wait || a),
        (e = e.duration || gn.duration)),
      { duration: e, delay: t, swing: i, times: r, wait: a, when: n }
    );
  }
  active(e) {
    return e == null ? this.enabled : ((this.enabled = e), this);
  }
  addTransform(e, t) {
    return (this.transforms.lmultiplyO(e), this);
  }
  after(e) {
    return this.on(`finished`, e);
  }
  animate(t, n, r) {
    let i = e.sanitise(t, n, r),
      a = new e(i.duration);
    return (
      this._timeline && a.timeline(this._timeline),
      this._element && a.element(this._element),
      a.loop(i).schedule(i.delay, i.when)
    );
  }
  clearTransform() {
    return ((this.transforms = new R()), this);
  }
  clearTransformsFromQueue() {
    (!this.done ||
      !this._timeline ||
      !this._timeline._runnerIds.includes(this.id)) &&
      (this._queue = this._queue.filter((e) => !e.isTransform));
  }
  delay(e) {
    return this.animate(0, e);
  }
  duration() {
    return this._times * (this._wait + this._duration) - this._wait;
  }
  during(e) {
    return this.queue(null, e);
  }
  ease(e) {
    return ((this._stepper = new ar(e)), this);
  }
  element(e) {
    return e == null
      ? this._element
      : ((this._element = e), e._prepareRunner(), this);
  }
  finish() {
    return this.step(1 / 0);
  }
  loop(e, t, n) {
    return (
      typeof e == `object` && ((t = e.swing), (n = e.wait), (e = e.times)),
      (this._times = e || 1 / 0),
      (this._swing = t || !1),
      (this._wait = n || 0),
      this._times === !0 && (this._times = 1 / 0),
      this
    );
  }
  loops(e) {
    let t = this._duration + this._wait;
    if (e == null) {
      let e = Math.floor(this._time / t),
        n = (this._time - e * t) / this._duration;
      return Math.min(e + n, this._times);
    }
    let n = Math.floor(e),
      r = e % 1,
      i = t * n + this._duration * r;
    return this.time(i);
  }
  persist(e) {
    return e == null ? this._persist : ((this._persist = e), this);
  }
  position(e) {
    let t = this._time,
      n = this._duration,
      r = this._wait,
      i = this._times,
      a = this._swing,
      o = this._reverse,
      s;
    if (e == null) {
      let e = function (e) {
          let t = a * Math.floor((e % (2 * (r + n))) / (r + n)),
            i = (t && !o) || (!t && o),
            s = ((-1) ** i * (e % (r + n))) / n + i;
          return Math.max(Math.min(s, 1), 0);
        },
        c = i * (r + n) - r;
      return (
        (s =
          t <= 0
            ? Math.round(e(1e-5))
            : t < c
              ? e(t)
              : Math.round(e(c - 1e-5))),
        s
      );
    }
    let c = Math.floor(this.loops()),
      l = a && c % 2 == 0;
    return ((s = c + ((l && !o) || (o && l) ? e : 1 - e)), this.loops(s));
  }
  progress(e) {
    return e == null
      ? Math.min(1, this._time / this.duration())
      : this.time(e * this.duration());
  }
  queue(e, t, n, r) {
    return (
      this._queue.push({
        initialiser: e || hn,
        runner: t || hn,
        retarget: n,
        isTransform: r,
        initialised: !1,
        finished: !1,
      }),
      this.timeline() && this.timeline()._continue(),
      this
    );
  }
  reset() {
    return this._reseted ? this : (this.time(0), (this._reseted = !0), this);
  }
  reverse(e) {
    return ((this._reverse = e ?? !this._reverse), this);
  }
  schedule(e, t, n) {
    if ((e instanceof Hr || ((n = t), (t = e), (e = this.timeline())), !e))
      throw Error(`Runner cannot be scheduled without timeline`);
    return (e.schedule(this, t, n), this);
  }
  step(e) {
    if (!this.enabled) return this;
    ((e ??= 16), (this._time += e));
    let t = this.position(),
      n = this._lastPosition !== t && this._time >= 0;
    this._lastPosition = t;
    let r = this.duration(),
      i = this._lastTime <= 0 && this._time > 0,
      a = this._lastTime < r && this._time >= r;
    ((this._lastTime = this._time), i && this.fire(`start`, this));
    let o = this._isDeclarative;
    ((this.done = !o && !a && this._time >= r), (this._reseted = !1));
    let s = !1;
    return (
      (n || o) &&
        (this._initialise(n),
        (this.transforms = new R()),
        (s = this._run(o ? e : t)),
        this.fire(`step`, this)),
      (this.done = this.done || (s && o)),
      a && this.fire(`finished`, this),
      this
    );
  }
  time(e) {
    if (e == null) return this._time;
    let t = e - this._time;
    return (this.step(t), this);
  }
  timeline(e) {
    return e === void 0 ? this._timeline : ((this._timeline = e), this);
  }
  unschedule() {
    let e = this.timeline();
    return (e && e.unschedule(this), this);
  }
  _initialise(e) {
    if (!(!e && !this._isDeclarative))
      for (let t = 0, n = this._queue.length; t < n; ++t) {
        let n = this._queue[t],
          r = this._isDeclarative || (!n.initialised && e);
        ((e = !n.finished),
          r && e && (n.initialiser.call(this), (n.initialised = !0)));
      }
  }
  _rememberMorpher(e, t) {
    if (
      ((this._history[e] = {
        morpher: t,
        caller: this._queue[this._queue.length - 1],
      }),
      this._isDeclarative)
    ) {
      let e = this.timeline();
      e && e.play();
    }
  }
  _run(e) {
    let t = !0;
    for (let n = 0, r = this._queue.length; n < r; ++n) {
      let r = this._queue[n],
        i = r.runner.call(this, e);
      ((r.finished = r.finished || i === !0), (t &&= r.finished));
    }
    return t;
  }
  _tryRetarget(e, t, n) {
    if (this._history[e]) {
      if (!this._history[e].caller.initialised) {
        let t = this._queue.indexOf(this._history[e].caller);
        return (this._queue.splice(t, 1), !1);
      }
      (this._history[e].caller.retarget
        ? this._history[e].caller.retarget.call(this, t, n)
        : this._history[e].morpher.to(t),
        (this._history[e].caller.finished = !1));
      let r = this.timeline();
      return (r && r.play(), !0);
    }
    return !1;
  }
};
Ur.id = 0;
var Wr = class {
  constructor(e = new R(), t = -1, n = !0) {
    ((this.transforms = e), (this.id = t), (this.done = n));
  }
  clearTransformsFromQueue() {}
};
P([Ur, Wr], {
  mergeWith(e) {
    return new Wr(e.transforms.lmultiply(this.transforms), e.id);
  },
});
var Gr = (e, t) => e.lmultiplyO(t),
  Kr = (e) => e.transforms;
function qr() {
  let e = this._transformationRunners.runners.map(Kr).reduce(Gr, new R());
  (this.transform(e),
    this._transformationRunners.merge(),
    this._transformationRunners.length() === 1 && (this._frameId = null));
}
var Jr = class {
  constructor() {
    ((this.runners = []), (this.ids = []));
  }
  add(e) {
    if (this.runners.includes(e)) return;
    let t = e.id + 1;
    return (this.runners.push(e), this.ids.push(t), this);
  }
  clearBefore(e) {
    let t = this.ids.indexOf(e + 1) || 1;
    return (
      this.ids.splice(0, t, 0),
      this.runners
        .splice(0, t, new Wr())
        .forEach((e) => e.clearTransformsFromQueue()),
      this
    );
  }
  edit(e, t) {
    let n = this.ids.indexOf(e + 1);
    return (this.ids.splice(n, 1, e + 1), this.runners.splice(n, 1, t), this);
  }
  getByID(e) {
    return this.runners[this.ids.indexOf(e + 1)];
  }
  length() {
    return this.ids.length;
  }
  merge() {
    let e = null;
    for (let t = 0; t < this.runners.length; ++t) {
      let n = this.runners[t];
      if (
        e &&
        n.done &&
        e.done &&
        (!n._timeline || !n._timeline._runnerIds.includes(n.id)) &&
        (!e._timeline || !e._timeline._runnerIds.includes(e.id))
      ) {
        this.remove(n.id);
        let r = n.mergeWith(e);
        (this.edit(e.id, r), (e = r), --t);
      } else e = n;
    }
    return this;
  }
  remove(e) {
    let t = this.ids.indexOf(e + 1);
    return (this.ids.splice(t, 1), this.runners.splice(t, 1), this);
  }
};
D({
  Element: {
    animate(e, t, n) {
      let r = Ur.sanitise(e, t, n),
        i = this.timeline();
      return new Ur(r.duration)
        .loop(r)
        .element(this)
        .timeline(i.play())
        .schedule(r.delay, r.when);
    },
    delay(e, t) {
      return this.animate(0, e, t);
    },
    _clearTransformRunnersBefore(e) {
      this._transformationRunners.clearBefore(e.id);
    },
    _currentTransform(e) {
      return this._transformationRunners.runners
        .filter((t) => t.id <= e.id)
        .map(Kr)
        .reduce(Gr, new R());
    },
    _addRunner(e) {
      (this._transformationRunners.add(e),
        G.cancelImmediate(this._frameId),
        (this._frameId = G.immediate(qr.bind(this))));
    },
    _prepareRunner() {
      this._frameId ??
        (this._transformationRunners = new Jr().add(new Wr(new R(this))));
    },
  },
});
var Yr = (e, t) => e.filter((e) => !t.includes(e));
(P(Ur, {
  attr(e, t) {
    return this.styleAttr(`attr`, e, t);
  },
  css(e, t) {
    return this.styleAttr(`css`, e, t);
  },
  styleAttr(e, t, n) {
    if (typeof t == `string`) return this.styleAttr(e, { [t]: n });
    let r = t;
    if (this._tryRetarget(e, r)) return this;
    let i = new Sr(this._stepper).to(r),
      a = Object.keys(r);
    return (
      this.queue(
        function () {
          i = i.from(this.element()[e](a));
        },
        function (t) {
          return (this.element()[e](i.at(t).valueOf()), i.done());
        },
        function (t) {
          let n = Object.keys(t),
            o = Yr(n, a);
          if (o.length) {
            let t = this.element()[e](o),
              n = new Er(i.from()).valueOf();
            (Object.assign(n, t), i.from(n));
          }
          let s = new Er(i.to()).valueOf();
          (Object.assign(s, t), i.to(s), (a = n), (r = t));
        },
      ),
      this._rememberMorpher(e, i),
      this
    );
  },
  zoom(e, t) {
    if (this._tryRetarget(`zoom`, e, t)) return this;
    let n = new Sr(this._stepper).to(new B(e));
    return (
      this.queue(
        function () {
          n = n.from(this.element().zoom());
        },
        function (e) {
          return (this.element().zoom(n.at(e), t), n.done());
        },
        function (e, r) {
          ((t = r), n.to(e));
        },
      ),
      this._rememberMorpher(`zoom`, n),
      this
    );
  },
  transform(e, t, n) {
    if (
      ((t = e.relative || t),
      this._isDeclarative && !t && this._tryRetarget(`transform`, e))
    )
      return this;
    let r = R.isMatrixLike(e);
    n = e.affine == null ? (n ?? !r) : e.affine;
    let i = new Sr(this._stepper).type(n ? wr : R),
      a,
      o,
      s,
      c,
      l;
    function u() {
      ((o ||= this.element()),
        (a ||= Re(e, o)),
        (l = new R(t ? void 0 : o)),
        o._addRunner(this),
        t || o._clearTransformRunnersBefore(this));
    }
    function d(u) {
      t || this.clearTransform();
      let { x: d, y: f } = new L(a).transform(o._currentTransform(this)),
        p = new R({ ...e, origin: [d, f] }),
        m = this._isDeclarative && s ? s : l;
      if (n) {
        ((p = p.decompose(d, f)), (m = m.decompose(d, f)));
        let e = p.rotate,
          t = m.rotate,
          n = [e - 360, e, e + 360],
          r = n.map((e) => Math.abs(e - t)),
          i = Math.min(...r),
          a = r.indexOf(i);
        p.rotate = n[a];
      }
      (t &&
        (r || (p.rotate = e.rotate || 0),
        this._isDeclarative && c && (m.rotate = c)),
        i.from(m),
        i.to(p));
      let h = i.at(u);
      return (
        (c = h.rotate),
        (s = new R(h)),
        this.addTransform(s),
        o._addRunner(this),
        i.done()
      );
    }
    function f(t) {
      ((t.origin || `center`).toString() !==
        (e.origin || `center`).toString() && (a = Re(t, o)),
        (e = { ...t, origin: a }));
    }
    return (
      this.queue(u, d, f, !0),
      this._isDeclarative && this._rememberMorpher(`transform`, i),
      this
    );
  },
  x(e, t) {
    return this._queueNumber(`x`, e);
  },
  y(e) {
    return this._queueNumber(`y`, e);
  },
  dx(e = 0) {
    return this._queueNumberDelta(`x`, e);
  },
  dy(e = 0) {
    return this._queueNumberDelta(`y`, e);
  },
  dmove(e, t) {
    return this.dx(e).dy(t);
  },
  _queueNumberDelta(e, t) {
    if (((t = new B(t)), this._tryRetarget(e, t))) return this;
    let n = new Sr(this._stepper).to(t),
      r = null;
    return (
      this.queue(
        function () {
          ((r = this.element()[e]()), n.from(r), n.to(r + t));
        },
        function (t) {
          return (this.element()[e](n.at(t)), n.done());
        },
        function (e) {
          n.to(r + new B(e));
        },
      ),
      this._rememberMorpher(e, n),
      this
    );
  },
  _queueObject(e, t) {
    if (this._tryRetarget(e, t)) return this;
    let n = new Sr(this._stepper).to(t);
    return (
      this.queue(
        function () {
          n.from(this.element()[e]());
        },
        function (t) {
          return (this.element()[e](n.at(t)), n.done());
        },
      ),
      this._rememberMorpher(e, n),
      this
    );
  },
  _queueNumber(e, t) {
    return this._queueObject(e, new B(t));
  },
  cx(e) {
    return this._queueNumber(`cx`, e);
  },
  cy(e) {
    return this._queueNumber(`cy`, e);
  },
  move(e, t) {
    return this.x(e).y(t);
  },
  center(e, t) {
    return this.cx(e).cy(t);
  },
  size(e, t) {
    let n;
    return (
      (!e || !t) && (n = this._element.bbox()),
      (e ||= (n.width / n.height) * t),
      (t ||= (n.height / n.width) * e),
      this.width(e).height(t)
    );
  },
  width(e) {
    return this._queueNumber(`width`, e);
  },
  height(e) {
    return this._queueNumber(`height`, e);
  },
  plot(e, t, n, r) {
    if (arguments.length === 4) return this.plot([e, t, n, r]);
    if (this._tryRetarget(`plot`, e)) return this;
    let i = new Sr(this._stepper).type(this._element.MorphArray).to(e);
    return (
      this.queue(
        function () {
          i.from(this._element.array());
        },
        function (e) {
          return (this._element.plot(i.at(e)), i.done());
        },
      ),
      this._rememberMorpher(`plot`, i),
      this
    );
  },
  leading(e) {
    return this._queueNumber(`leading`, e);
  },
  viewbox(e, t, n, r) {
    return this._queueObject(`viewbox`, new z(e, t, n, r));
  },
  update(e) {
    return typeof e == `object`
      ? (e.opacity != null && this.attr(`stop-opacity`, e.opacity),
        e.color != null && this.attr(`stop-color`, e.color),
        e.offset != null && this.attr(`offset`, e.offset),
        this)
      : this.update({
          offset: arguments[0],
          color: arguments[1],
          opacity: arguments[2],
        });
  },
}),
  P(Ur, { rx: An, ry: jn, from: Vn, to: Hn }),
  N(Ur, `Runner`));
var Xr = class extends H {
  constructor(e, t = e) {
    (super(j(`svg`, e), t), this.namespace());
  }
  defs() {
    return this.isRoot()
      ? M(this.node.querySelector(`defs`)) || this.put(new kn())
      : this.root().defs();
  }
  isRoot() {
    return (
      !this.node.parentNode ||
      (!(this.node.parentNode instanceof k.window.SVGElement) &&
        this.node.parentNode.nodeName !== `#document-fragment`)
    );
  }
  namespace() {
    return this.isRoot()
      ? this.attr({ xmlns: ze, version: `1.1` })
          .attr(`xmlns:xlink`, He, Ve)
          .attr(`xmlns:svgjs`, Ue, Ve)
      : this.root().namespace();
  }
  removeNamespace() {
    return this.attr({ xmlns: null, version: null })
      .attr(`xmlns:xlink`, null, Ve)
      .attr(`xmlns:svgjs`, null, Ve);
  }
  root() {
    return this.isRoot() ? this : super.root();
  }
};
(D({
  Container: {
    nested: F(function () {
      return this.put(new Xr());
    }),
  },
}),
  N(Xr, `Svg`, !0));
var Zr = class extends H {
  constructor(e, t = e) {
    super(j(`symbol`, e), t);
  }
};
(D({
  Container: {
    symbol: F(function () {
      return this.put(new Zr());
    }),
  },
}),
  N(Zr, `Symbol`));
function Qr(e) {
  return (
    this._build === !1 && this.clear(),
    this.node.appendChild(k.document.createTextNode(e)),
    this
  );
}
function $r() {
  return this.node.getComputedTextLength();
}
function ei(e, t = this.bbox()) {
  return e == null ? t.x : this.attr(`x`, this.attr(`x`) + e - t.x);
}
function ti(e, t = this.bbox()) {
  return e == null ? t.y : this.attr(`y`, this.attr(`y`) + e - t.y);
}
function ni(e, t, n = this.bbox()) {
  return this.x(e, n).y(t, n);
}
function ri(e, t = this.bbox()) {
  return e == null ? t.cx : this.attr(`x`, this.attr(`x`) + e - t.cx);
}
function ii(e, t = this.bbox()) {
  return e == null ? t.cy : this.attr(`y`, this.attr(`y`) + e - t.cy);
}
function ai(e, t, n = this.bbox()) {
  return this.cx(e, n).cy(t, n);
}
function oi(e) {
  return this.attr(`x`, e);
}
function si(e) {
  return this.attr(`y`, e);
}
function ci(e, t) {
  return this.ax(e).ay(t);
}
function li(e) {
  return ((this._build = !!e), this);
}
var ui = {
    __proto__: null,
    plain: Qr,
    length: $r,
    x: ei,
    y: ti,
    move: ni,
    cx: ri,
    cy: ii,
    center: ai,
    ax: oi,
    ay: si,
    amove: ci,
    build: li,
  },
  K = class extends U {
    constructor(e, t = e) {
      (super(j(`text`, e), t),
        (this.dom.leading = new B(1.3)),
        (this._rebuild = !0),
        (this._build = !1));
    }
    leading(e) {
      return e == null
        ? this.dom.leading
        : ((this.dom.leading = new B(e)), this.rebuild());
    }
    rebuild(e) {
      if ((typeof e == `boolean` && (this._rebuild = e), this._rebuild)) {
        let e = this,
          t = 0,
          n = this.dom.leading;
        (this.each(function (r) {
          let i =
            n *
            new B(
              k.window
                .getComputedStyle(this.node)
                .getPropertyValue(`font-size`),
            );
          this.dom.newLined &&
            (this.attr(`x`, e.attr(`x`)),
            this.text() ===
            `
`
              ? (t += i)
              : (this.attr(`dy`, r ? i + t : 0), (t = 0)));
        }),
          this.fire(`rebuild`));
      }
      return this;
    }
    setData(e) {
      return (
        (this.dom = e),
        (this.dom.leading = new B(e.leading || 1.3)),
        this
      );
    }
    text(e) {
      if (e === void 0) {
        let t = this.node.childNodes,
          n = 0;
        e = ``;
        for (let r = 0, i = t.length; r < i; ++r) {
          if (t[r].nodeName === `textPath`) {
            r === 0 && (n = 1);
            continue;
          }
          (r !== n &&
            t[r].nodeType !== 3 &&
            M(t[r]).dom.newLined === !0 &&
            (e += `
`),
            (e += t[r].textContent));
        }
        return e;
      }
      if ((this.clear().build(!0), typeof e == `function`)) e.call(this, this);
      else {
        e = (e + ``).split(`
`);
        for (let t = 0, n = e.length; t < n; t++) this.newLine(e[t]);
      }
      return this.build(!1).rebuild();
    }
  };
(P(K, ui),
  D({
    Container: {
      text: F(function (e = ``) {
        return this.put(new K()).text(e);
      }),
      plain: F(function (e = ``) {
        return this.put(new K()).plain(e);
      }),
    },
  }),
  N(K, `Text`));
var di = class extends U {
  constructor(e, t = e) {
    (super(j(`tspan`, e), t), (this._build = !1));
  }
  dx(e) {
    return this.attr(`dx`, e);
  }
  dy(e) {
    return this.attr(`dy`, e);
  }
  newLine() {
    this.dom.newLined = !0;
    let e = this.parent();
    if (!(e instanceof K)) return this;
    let t = e.index(this),
      n = k.window.getComputedStyle(this.node).getPropertyValue(`font-size`),
      r = e.dom.leading * new B(n);
    return this.dy(t ? r : 0).attr(`x`, e.x());
  }
  text(e) {
    return e == null
      ? this.node.textContent +
          (this.dom.newLined
            ? `
`
            : ``)
      : (typeof e == `function`
          ? (this.clear().build(!0), e.call(this, this), this.build(!1))
          : this.plain(e),
        this);
  }
};
(P(di, ui),
  D({
    Tspan: {
      tspan: F(function (e = ``) {
        let t = new di();
        return (this._build || this.clear(), this.put(t).text(e));
      }),
    },
    Text: {
      newLine: function (e = ``) {
        return this.tspan(e).newLine();
      },
    },
  }),
  N(di, `Tspan`));
var fi = class extends U {
  constructor(e, t = e) {
    super(j(`circle`, e), t);
  }
  radius(e) {
    return this.attr(`r`, e);
  }
  rx(e) {
    return this.attr(`r`, e);
  }
  ry(e) {
    return this.rx(e);
  }
  size(e) {
    return this.radius(new B(e).divide(2));
  }
};
(P(fi, { x: Mn, y: Nn, cx: Pn, cy: Fn, width: In, height: Ln }),
  D({
    Container: {
      circle: F(function (e = 0) {
        return this.put(new fi()).size(e).move(0, 0);
      }),
    },
  }),
  N(fi, `Circle`));
var pi = class extends H {
  constructor(e, t = e) {
    super(j(`clipPath`, e), t);
  }
  remove() {
    return (
      this.targets().forEach(function (e) {
        e.unclip();
      }),
      super.remove()
    );
  }
  targets() {
    return nn(`svg [clip-path*=` + this.id() + `]`);
  }
};
(D({
  Container: {
    clip: F(function () {
      return this.defs().put(new pi());
    }),
  },
  Element: {
    clipper() {
      return this.reference(`clip-path`);
    },
    clipWith(e) {
      let t = e instanceof pi ? e : this.parent().clip().add(e);
      return this.attr(`clip-path`, `url(#` + t.id() + `)`);
    },
    unclip() {
      return this.attr(`clip-path`, null);
    },
  },
}),
  N(pi, `ClipPath`));
var mi = class extends V {
  constructor(e, t = e) {
    super(j(`foreignObject`, e), t);
  }
};
(D({
  Container: {
    foreignObject: F(function (e, t) {
      return this.put(new mi()).size(e, t);
    }),
  },
}),
  N(mi, `ForeignObject`));
function hi(e, t) {
  return (
    this.children().forEach((n, r) => {
      let i;
      try {
        i = n.bbox();
      } catch {
        return;
      }
      let a = new R(n),
        o = a.translate(e, t).transform(a.inverse()),
        s = new L(i.x, i.y).transform(o);
      n.move(s.x, s.y);
    }),
    this
  );
}
function gi(e) {
  return this.dmove(e, 0);
}
function _i(e) {
  return this.dmove(0, e);
}
function vi(e, t = this.bbox()) {
  return e == null ? t.height : this.size(t.width, e, t);
}
function yi(e = 0, t = 0, n = this.bbox()) {
  let r = e - n.x,
    i = t - n.y;
  return this.dmove(r, i);
}
function bi(e, t, n = this.bbox()) {
  let r = Le(this, e, t, n),
    i = r.width / n.width,
    a = r.height / n.height;
  return (
    this.children().forEach((e, t) => {
      let r = new L(n).transform(new R(e).inverse());
      e.scale(i, a, r.x, r.y);
    }),
    this
  );
}
function xi(e, t = this.bbox()) {
  return e == null ? t.width : this.size(e, t.height, t);
}
function Si(e, t = this.bbox()) {
  return e == null ? t.x : this.move(e, t.y, t);
}
function Ci(e, t = this.bbox()) {
  return e == null ? t.y : this.move(t.x, e, t);
}
var wi = {
    __proto__: null,
    dmove: hi,
    dx: gi,
    dy: _i,
    height: vi,
    move: yi,
    size: bi,
    width: xi,
    x: Si,
    y: Ci,
  },
  q = class extends H {
    constructor(e, t = e) {
      super(j(`g`, e), t);
    }
  };
(P(q, wi),
  D({
    Container: {
      group: F(function () {
        return this.put(new q());
      }),
    },
  }),
  N(q, `G`));
var Ti = class extends H {
  constructor(e, t = e) {
    super(j(`a`, e), t);
  }
  target(e) {
    return this.attr(`target`, e);
  }
  to(e) {
    return this.attr(`href`, e, He);
  }
};
(P(Ti, wi),
  D({
    Container: {
      link: F(function (e) {
        return this.put(new Ti()).to(e);
      }),
    },
    Element: {
      unlink() {
        let e = this.linker();
        if (!e) return this;
        let t = e.parent();
        if (!t) return this.remove();
        let n = t.index(e);
        return (t.add(this, n), e.remove(), this);
      },
      linkTo(e) {
        let t = this.linker();
        return (
          t || ((t = new Ti()), this.wrap(t)),
          typeof e == `function` ? e.call(t, t) : t.to(e),
          this
        );
      },
      linker() {
        let e = this.parent();
        return e && e.node.nodeName.toLowerCase() === `a` ? e : null;
      },
    },
  }),
  N(Ti, `A`));
var Ei = class extends H {
  constructor(e, t = e) {
    super(j(`mask`, e), t);
  }
  remove() {
    return (
      this.targets().forEach(function (e) {
        e.unmask();
      }),
      super.remove()
    );
  }
  targets() {
    return nn(`svg [mask*=` + this.id() + `]`);
  }
};
(D({
  Container: {
    mask: F(function () {
      return this.defs().put(new Ei());
    }),
  },
  Element: {
    masker() {
      return this.reference(`mask`);
    },
    maskWith(e) {
      let t = e instanceof Ei ? e : this.parent().mask().add(e);
      return this.attr(`mask`, `url(#` + t.id() + `)`);
    },
    unmask() {
      return this.attr(`mask`, null);
    },
  },
}),
  N(Ei, `Mask`));
var Di = class extends V {
  constructor(e, t = e) {
    super(j(`stop`, e), t);
  }
  update(e) {
    return (
      (typeof e == `number` || e instanceof B) &&
        (e = {
          offset: arguments[0],
          color: arguments[1],
          opacity: arguments[2],
        }),
      e.opacity != null && this.attr(`stop-opacity`, e.opacity),
      e.color != null && this.attr(`stop-color`, e.color),
      e.offset != null && this.attr(`offset`, new B(e.offset)),
      this
    );
  }
};
(D({
  Gradient: {
    stop: function (e, t, n) {
      return this.put(new Di()).update(e, t, n);
    },
  },
}),
  N(Di, `Stop`));
function Oi(e, t) {
  if (!e) return ``;
  if (!t) return e;
  let n = e + `{`;
  for (let e in t) n += Fe(e) + `:` + t[e] + `;`;
  return ((n += `}`), n);
}
var ki = class extends V {
  constructor(e, t = e) {
    super(j(`style`, e), t);
  }
  addText(e = ``) {
    return ((this.node.textContent += e), this);
  }
  font(e, t, n = {}) {
    return this.rule(`@font-face`, { fontFamily: e, src: t, ...n });
  }
  rule(e, t) {
    return this.addText(Oi(e, t));
  }
};
(D(`Dom`, {
  style(e, t) {
    return this.put(new ki()).rule(e, t);
  },
  fontface(e, t, n) {
    return this.put(new ki()).font(e, t, n);
  },
}),
  N(ki, `Style`));
var Ai = class extends K {
  constructor(e, t = e) {
    super(j(`textPath`, e), t);
  }
  array() {
    let e = this.track();
    return e ? e.array() : null;
  }
  plot(e) {
    let t = this.track(),
      n = null;
    return (t && (n = t.plot(e)), e == null ? n : this);
  }
  track() {
    return this.reference(`href`);
  }
};
(D({
  Container: {
    textPath: F(function (e, t) {
      return (e instanceof K || (e = this.text(e)), e.path(t));
    }),
  },
  Text: {
    path: F(function (e, t = !0) {
      let n = new Ai();
      (e instanceof Ar || (e = this.defs().path(e)),
        n.attr(`href`, `#` + e, He));
      let r;
      if (t) for (; (r = this.node.firstChild);) n.node.appendChild(r);
      return this.put(n);
    }),
    textPath() {
      return this.findOne(`textPath`);
    },
  },
  Path: {
    text: F(function (e) {
      return (
        e instanceof K || (e = new K().addTo(this.parent()).text(e)),
        e.path(this)
      );
    }),
    targets() {
      return nn(`svg textPath`).filter((e) =>
        (e.attr(`href`) || ``).includes(this.id()),
      );
    },
  },
}),
  (Ai.prototype.MorphArray = br),
  N(Ai, `TextPath`));
var ji = class extends U {
  constructor(e, t = e) {
    super(j(`use`, e), t);
  }
  use(e, t) {
    return this.attr(`href`, (t || ``) + `#` + e, He);
  }
};
(D({
  Container: {
    use: F(function (e, t) {
      return this.put(new ji()).use(e, t);
    }),
  },
}),
  N(ji, `Use`));
var J = A;
(P([Xr, Zr, Kn, Gn, tr], O(`viewbox`)),
  P([er, Rr, Lr, Ar], O(`marker`)),
  P(K, O(`Text`)),
  P(Ar, O(`Path`)),
  P(kn, O(`Defs`)),
  P([K, di], O(`Tspan`)),
  P([W, zn, Wn, Ur], O(`radius`)),
  P(mn, O(`EventTarget`)),
  P(Sn, O(`Dom`)),
  P(V, O(`Element`)),
  P(U, O(`Shape`)),
  P([H, Bn], O(`Container`)),
  P(Wn, O(`Gradient`)),
  P(Ur, O(`Runner`)),
  en.extend(ke()),
  Or([B, I, z, R, vn, qn, br, L]),
  kr());
var Mi = {
    paddingX: 15,
    paddingY: 5,
    imgMaxWidth: 200,
    imgMaxHeight: 100,
    iconSize: 20,
    lineWidth: 1,
    lineColor: `#549688`,
    lineDasharray: `none`,
    lineFlow: !1,
    lineFlowDuration: 1,
    lineFlowForward: !0,
    lineStyle: `straight`,
    rootLineKeepSameInCurve: !0,
    rootLineStartPositionKeepSameInCurve: !1,
    lineRadius: 5,
    showLineMarker: !1,
    generalizationLineWidth: 1,
    generalizationLineColor: `#549688`,
    generalizationLineMargin: 0,
    generalizationNodeMargin: 20,
    associativeLineWidth: 2,
    associativeLineColor: `rgb(51, 51, 51)`,
    associativeLineActiveWidth: 8,
    associativeLineActiveColor: `rgba(2, 167, 240, 1)`,
    associativeLineDasharray: `6,4`,
    associativeLineTextColor: `rgb(51, 51, 51)`,
    associativeLineTextFontSize: 14,
    associativeLineTextLineHeight: 1.2,
    associativeLineTextFontFamily: `微软雅黑, Microsoft YaHei`,
    backgroundColor: `#fafafa`,
    backgroundImage: `none`,
    backgroundRepeat: `no-repeat`,
    backgroundPosition: `center center`,
    backgroundSize: `cover`,
    nodeUseLineStyle: !1,
    root: {
      shape: `rectangle`,
      fillColor: `#549688`,
      fontFamily: `微软雅黑, Microsoft YaHei`,
      color: `#fff`,
      fontSize: 16,
      fontWeight: `bold`,
      fontStyle: `normal`,
      borderColor: `transparent`,
      borderWidth: 0,
      borderDasharray: `none`,
      borderRadius: 5,
      textDecoration: `none`,
      gradientStyle: !1,
      startColor: `#549688`,
      endColor: `#fff`,
      startDir: [0, 0],
      endDir: [1, 0],
      lineMarkerDir: `end`,
      hoverRectColor: ``,
      hoverRectRadius: 5,
      textAlign: `left`,
      imgPlacement: `top`,
      tagPlacement: `right`,
    },
    second: {
      shape: `rectangle`,
      marginX: 100,
      marginY: 40,
      fillColor: `#fff`,
      fontFamily: `微软雅黑, Microsoft YaHei`,
      color: `#565656`,
      fontSize: 16,
      fontWeight: `normal`,
      fontStyle: `normal`,
      borderColor: `#549688`,
      borderWidth: 1,
      borderDasharray: `none`,
      borderRadius: 5,
      textDecoration: `none`,
      gradientStyle: !1,
      startColor: `#549688`,
      endColor: `#fff`,
      startDir: [0, 0],
      endDir: [1, 0],
      lineMarkerDir: `end`,
      hoverRectColor: ``,
      hoverRectRadius: 5,
      textAlign: `left`,
      imgPlacement: `top`,
      tagPlacement: `right`,
    },
    node: {
      shape: `rectangle`,
      marginX: 50,
      marginY: 0,
      fillColor: `transparent`,
      fontFamily: `微软雅黑, Microsoft YaHei`,
      color: `#6a6d6c`,
      fontSize: 14,
      fontWeight: `normal`,
      fontStyle: `normal`,
      borderColor: `transparent`,
      borderWidth: 0,
      borderRadius: 5,
      borderDasharray: `none`,
      textDecoration: `none`,
      gradientStyle: !1,
      startColor: `#549688`,
      endColor: `#fff`,
      startDir: [0, 0],
      endDir: [1, 0],
      lineMarkerDir: `end`,
      hoverRectColor: ``,
      hoverRectRadius: 5,
      textAlign: `left`,
      imgPlacement: `top`,
      tagPlacement: `right`,
    },
    generalization: {
      shape: `rectangle`,
      marginX: 100,
      marginY: 40,
      fillColor: `#fff`,
      fontFamily: `微软雅黑, Microsoft YaHei`,
      color: `#565656`,
      fontSize: 16,
      fontWeight: `normal`,
      fontStyle: `normal`,
      borderColor: `#549688`,
      borderWidth: 1,
      borderDasharray: `none`,
      borderRadius: 5,
      textDecoration: `none`,
      gradientStyle: !1,
      startColor: `#549688`,
      endColor: `#fff`,
      startDir: [0, 0],
      endDir: [1, 0],
      hoverRectColor: ``,
      hoverRectRadius: 5,
      textAlign: `left`,
      imgPlacement: `top`,
      tagPlacement: `right`,
    },
  },
  Ni =
    `lineWidth.lineColor.lineDasharray.lineStyle.generalizationLineWidth.generalizationLineColor.associativeLineWidth.associativeLineColor.associativeLineActiveWidth.associativeLineActiveColor.associativeLineTextColor.associativeLineTextFontSize.associativeLineTextLineHeight.associativeLineTextFontFamily.backgroundColor.backgroundImage.backgroundRepeat.backgroundPosition.backgroundSize.rootLineKeepSameInCurve.rootLineStartPositionKeepSameInCurve.showLineMarker.lineRadius.hoverRectColor.hoverRectRadius.lineFlow.lineFlowDuration.lineFlowForward.textAlign`.split(
      `.`,
    ),
  Pi = (e) => {
    let t = Object.keys(e);
    for (let e = 0; e < t.length; e++)
      if (!Ni.find((n) => n === t[e])) return !1;
    return !0;
  },
  Fi = [
    `lineColor`,
    `lineDasharray`,
    `lineWidth`,
    `lineMarkerDir`,
    `lineFlow`,
    `lineFlowDuration`,
    `lineFlowForward`,
  ],
  Y = (e, t, n, r, i, a = 0, o = 0, s = []) => {
    let c = !1;
    if (
      (n && (c = n(e, t, i, a, o, s)),
      !c && e.children && e.children.length > 0)
    ) {
      let t = a + 1;
      e.children.forEach((i, a) => {
        Y(i, e, n, r, !1, t, a, [...s, e]);
      });
    }
    r && r(e, t, i, a, o, s);
  },
  Ii = (e, t) => {
    let n = [e],
      r = !1;
    for (t(e, null) === `stop` && (r = !0); n.length && !r;) {
      let e = n.shift();
      e.children &&
        e.children.length &&
        e.children.forEach((i) => {
          r || (n.push(i), t(i, e) === `stop` && (r = !0));
        });
    }
  },
  Li = (e, t, n, r) => {
    let i = e / t,
      a = [];
    return (
      n && r
        ? (a = e <= n && t <= r ? [e, t] : i > n / r ? [n, n / i] : [i * r, r])
        : n
          ? (a = e <= n ? [e, t] : [n, n / i])
          : r && (a = t <= r ? [e, t] : [i * r, r]),
      a
    );
  },
  Ri = (e) => {
    e = e.replace(
      /<br>/gim,
      `
`,
    );
    let t = document.createElement(`div`);
    return ((t.innerHTML = e), (e = t.textContent), e);
  },
  X = (e) => {
    try {
      return JSON.parse(JSON.stringify(e));
    } catch {
      return null;
    }
  },
  zi = (e, t, n = !1) => (
    (e.data = X(t.data)),
    n &&
      ((e.data.isActive = !1),
      Fa(e.data).forEach((e) => {
        e.isActive = !1;
      })),
    (e.children = []),
    t.children &&
      t.children.length > 0 &&
      t.children.forEach((t, r) => {
        e.children[r] = zi({}, t, n);
      }),
    Object.keys(t).forEach((n) => {
      ![`data`, `children`].includes(n) && !/^_/.test(n) && (e[n] = t[n]);
    }),
    e
  ),
  Bi = (e, t, n = !1, r = !0) => {
    let i = t.nodeData ? t.nodeData : t;
    return (
      (e.data = X(i.data)),
      r ? delete e.data.uid : e.data.uid || (e.data.uid = Zi()),
      n && (e.data.isActive = !1),
      (e.children = []),
      t.children && t.children.length > 0
        ? t.children.forEach((t, i) => {
            e.children[i] = Bi({}, t, n, r);
          })
        : t.nodeData &&
          t.nodeData.children &&
          t.nodeData.children.length > 0 &&
          t.nodeData.children.forEach((t, i) => {
            e.children[i] = Bi({}, t, n, r);
          }),
      Object.keys(i).forEach((t) => {
        ![`data`, `children`].includes(t) && !/^_/.test(t) && (e[t] = i[t]);
      }),
      e
    );
  },
  Vi = (e, t = 300, n) => {
    let r = null;
    return (...i) => {
      r ||= setTimeout(() => {
        (e.call(n, ...i), (r = null));
      }, t);
    };
  },
  Hi = (e, t = 300, n) => {
    let r = null;
    return (...i) => {
      (r && clearTimeout(r),
        (r = setTimeout(() => {
          ((r = null), e.apply(n, i));
        }, t)));
    };
  },
  Ui = (e, t = () => {}) => {
    let n = 0,
      r = e.length;
    if (r <= 0) return t();
    let i = () => {
      if (n >= r) {
        t();
        return;
      }
      (e[n](),
        setTimeout(() => {
          (n++, i());
        }, 0));
    };
    i();
  },
  Wi = (e) => (Math.PI / 180) * e,
  Gi = (e) =>
    e.replace(/([a-z])([A-Z])/g, (...e) => e[1] + `-` + e[2].toLowerCase()),
  Ki = function (e, t) {
    let n = !1,
      r = null,
      i = () => {
        ((n = !1), t ? e.call(t) : e());
      };
    if (typeof MutationObserver < `u`) {
      let e = 1,
        t = new MutationObserver(i),
        n = document.createTextNode(e);
      (t.observe(n, { characterData: !0 }),
        (r = function () {
          ((e = (e + 1) % 2), (n.data = e));
        }));
    } else r = setTimeout;
    return function () {
      n || ((n = !0), r(i, 0));
    };
  },
  qi = (e, t, n = 0, r = 0) => {
    let i = e.elRect,
      {
        scaleX: a,
        scaleY: o,
        translateX: s,
        translateY: c,
      } = e.draw.transform(),
      { left: l, top: u, width: d, height: f } = t,
      p = (l + d) * a + s,
      m = (u + f) * o + c;
    ((l = l * a + s), (u = u * o + c));
    let h = 0,
      g = 0;
    return (
      l < 0 + n && (h = -l + n),
      p > i.width - n && (h = -(p - i.width) - n),
      u < 0 + r && (g = -u + r),
      m > i.height - r && (g = -(m - i.height) - r),
      { isOuter: h !== 0 || g !== 0, offsetLeft: h, offsetTop: g }
    );
  },
  Ji = null,
  Yi = (e) => (
    (Ji ||= document.createElement(`div`)),
    (Ji.innerHTML = e),
    Ji.textContent
  ),
  Xi = (e) =>
    new Promise((t) => {
      let n = new Image();
      ((n.src = e),
        (n.onload = () => {
          t({ width: n.width, height: n.height });
        }),
        (n.onerror = () => {
          t({ width: 0, height: 0 });
        }));
    }),
  Zi = () => we(),
  Qi = (e) =>
    new Promise((t, n) => {
      let r = new FileReader();
      (r.readAsDataURL(e),
        (r.onload = async (e) => {
          let n = e.target.result;
          t({ url: n, size: await Xi(n) });
        }),
        (r.onerror = (e) => {
          n(e);
        }));
    }),
  $i = (e) => Object.prototype.toString.call(e).slice(8, -1),
  ea = (e) => e == null || e === ``,
  ta = null,
  na = (e) => {
    ((ta ||= document.createElement(`div`)), (ta.innerHTML = e));
    for (let e = ta.childNodes, t = e.length; t--;)
      if (e[t].nodeType == 1) return !0;
    return !1;
  },
  ra = (e) => (
    (e = String(e).replace(/\s+/g, ``)),
    [`#fff`, `#ffffff`, `#FFF`, `#FFFFFF`, `rgb(255,255,255)`].includes(e) ||
      /rgba\(255,255,255,[^)]+\)/.test(e)
  ),
  ia = (e) => (
    (e = String(e).replace(/\s+/g, ``)),
    [``, `transparent`].includes(e) || /rgba\(\d+,\d+,\d+,0\)/.test(e)
  ),
  aa = (e) => {
    let { lineColor: t, root: n, second: r, node: i } = e,
      a = [
        t,
        n.fillColor,
        n.color,
        r.fillColor,
        r.color,
        i.fillColor,
        i.color,
        n.borderColor,
        r.borderColor,
        i.borderColor,
      ];
    for (let e = 0; e < a.length; e++) {
      let t = a[e];
      if (!ia(t) && !ra(t)) return t;
    }
  },
  oa = null,
  sa = (e) => {
    ((oa ||= document.createElement(`div`)), (oa.innerHTML = e));
    let t = oa.querySelectorAll(`.ql-formula`);
    Array.from(t).forEach((e) => {
      let t = document.createTextNode(`$smmformula$`);
      e.parentNode.replaceChild(t, e);
    });
    let n = oa.childNodes,
      r = [];
    for (let e = 0; e < n.length; e++) {
      let t = n[e];
      t.nodeType === 1
        ? r.push(t.textContent)
        : t.nodeType === 3 && r.push(t.nodeValue);
    }
    if (
      ((e = r.map((e) => `<p><span>${ba(e)}</span></p>`).join(``)),
      t.length > 0)
    ) {
      ((e = e.replace(/\$smmformula\$/g, `<span class="smmformula"></span>`)),
        (oa.innerHTML = e));
      let n = oa.querySelectorAll(`.smmformula`);
      (Array.from(n).forEach((e, n) => {
        e.parentNode.replaceChild(t[n], e);
      }),
        (e = oa.innerHTML));
    }
    return e;
  },
  ca = (e, t) => {
    let n = {};
    return (
      Object.keys(t).forEach((r) => {
        let i = e[r],
          a = t[r];
        if ($i(i) !== $i(a)) {
          n[r] = a;
          return;
        }
        if ($i(i) === `Object`) {
          if (JSON.stringify(i) !== JSON.stringify(a)) {
            n[r] = a;
            return;
          }
        } else if (i !== a) {
          n[r] = a;
          return;
        }
      }),
      n
    );
  },
  la = (e) => (/^_/.test(e) ? !1 : !de.includes(e)),
  ua = (e) => {
    let t = [...Fi],
      n = Object.keys(e);
    for (let e = 0; e < n.length; e++) if (!t.includes(n[e])) return !1;
    return !0;
  },
  da = (e) =>
    e.reduce((e, t) => {
      let n = e.find((e) => e.type === t.type);
      return (
        n
          ? t.list.forEach((e) => {
              let t = n.list.find((t) => t.name === e.name);
              t ? (t.icon = e.icon) : n.list.push(e);
            })
          : e.push({ ...t }),
        e
      );
    }, []),
  fa = (e) => {
    let t = [];
    return (
      e.forEach((n) => {
        e.find((e) => e.uid !== n.uid && e.isAncestor(n)) || t.push(n);
      }),
      t
    );
  },
  pa = (e) => {
    let t = {},
      n = {};
    e.forEach((e) => {
      let r = e.parent;
      if (r) {
        let i = r.uid;
        n[i] = r;
        let a = { node: e, index: e.getIndexInBrothers() };
        t[i]
          ? t[i].find((e) => e.index === a.index) || t[i].push(a)
          : (t[i] = [a]);
      }
    });
    let r = [];
    return (
      Object.keys(t).forEach((e) => {
        if (t[e].length > 1) {
          let i = t[e].map((e) => e.index).sort((e, t) => e - t);
          r.push({ node: n[e], range: [i[0], i[i.length - 1]] });
        } else r.push({ node: t[e][0].node });
      }),
      r
    );
  },
  ma = (e) => {
    let t = window.getSelection(),
      n = document.createRange();
    (n.selectNodeContents(e), n.collapse(), t.removeAllRanges(), t.addRange(n));
  },
  ha = (e) => {
    let t = window.getSelection(),
      n = document.createRange();
    (n.selectNodeContents(e), t.removeAllRanges(), t.addRange(n));
  },
  ga = (e, t = {}) => {
    ((t = { ...t }),
      t && t.richText && t.resetRichText && delete t.resetRichText);
    let n = (e) => {
      e.forEach((e) => {
        ((e.data = { ...e.data, ...t }),
          e.children && e.children.length > 0 && n(e.children));
      });
    };
    return (n(e), e);
  },
  _a = (e, t = !1, n = null, r = !1) => {
    let i = (e) => {
      e.forEach((e) => {
        ((e.data ||= {}),
          (t || ea(e.data.uid)) && (e.data.uid = Zi()),
          r &&
            Fa(e.data).forEach((e) => {
              (t || ea(e.uid)) && (e.uid = Zi());
            }),
          n && n(e),
          e.children && e.children.length > 0 && i(e.children));
      });
    };
    return (i(e), e);
  },
  Z = (e) => (e ? (Array.isArray(e) ? e : [e]) : []),
  va = (e) =>
    e.parent
      ? e.parent.nodeData.children.findIndex((t) => t.data.uid === e.uid)
      : 0,
  Q = (e, t) => t.findIndex((t) => t.uid === e.uid),
  ya = (e) => {
    let t = 0;
    for (let n = 0; n < e.length; n++) t = e.charCodeAt(n) + ((t << 5) - t);
    return `hsla(` + (new Ee(t).genrand_int32() % 360) + `, 50%, 50%, 1)`;
  },
  ba = (e) => (
    [
      [`&`, `&amp;`],
      [`<`, `&lt;`],
      [`>`, `&gt;`],
    ].forEach((t) => {
      e = e.replace(new RegExp(t[0], `g`), t[1]);
    }),
    e
  ),
  xa = (e, t) => {
    let n = $i(e);
    if (n !== $i(t)) return !1;
    if (n === `Object`) {
      let n = Object.keys(e),
        r = Object.keys(t);
      if (n.length !== r.length) return !1;
      for (let i = 0; i < n.length; i++) {
        let a = n[i];
        if (!r.includes(a) || !xa(e[a], t[a])) return !1;
      }
      return !0;
    } else if (n === `Array`) {
      if (e.length !== t.length) return !1;
      for (let n = 0; n < e.length; n++) {
        let r = e[n],
          i = t[n];
        if ($i(r) !== $i(i) || !xa(r, i)) return !1;
      }
      return !0;
    } else return e === t;
  },
  Sa = () =>
    navigator.clipboard && typeof navigator.clipboard.read == `function`,
  Ca = (e) => {
    navigator.clipboard &&
      navigator.clipboard.writeText &&
      navigator.clipboard.writeText(JSON.stringify(e));
  },
  wa = async () => {
    let e = null,
      t = null;
    if (Sa()) {
      let n = await navigator.clipboard.read();
      if (n && n.length > 0)
        for (let r of n)
          for (let n of r.types)
            /^image\//.test(n)
              ? (t = await r.getType(n))
              : n === `text/plain` && (e = await (await r.getType(n)).text());
    }
    return { text: e, img: t };
  },
  Ta = (e) => {
    if (!e || !e.parent) return;
    let t = va(e);
    t !== -1 && e.parent.nodeData.children.splice(t, 1);
  },
  Ea = (e, t) => {
    if (e.length !== t.length) return !1;
    for (let n = 0; n < e.length; n++)
      if (!t.find((t) => t.uid === e[n].uid)) return !1;
    return !0;
  },
  Da = (e) => ({ simpleMindMap: !0, data: e }),
  Oa = (e) => {
    let t = null;
    if (typeof e == `string`)
      try {
        let n = JSON.parse(e);
        typeof n == `object` && n.simpleMindMap && (t = n.data);
      } catch {}
    else typeof e == `object` && e.simpleMindMap && (t = e.data);
    let n = !!t;
    return { isSmm: n, data: n ? t : String(e) };
  },
  ka = (e, t) => {
    e.preventDefault();
    let n = window.getSelection();
    if (!n.rangeCount) return;
    (n.deleteFromDocument(),
      (t ||= e.clipboardData.getData(`text`)),
      (t = ba(t)),
      (t = Yi(t)));
    let r = t.split(/\n/g),
      i = document.createDocumentFragment();
    (r.forEach((e, t) => {
      let n = document.createTextNode(e);
      if ((i.appendChild(n), t < r.length - 1)) {
        let e = document.createElement(`br`);
        i.appendChild(e);
      }
    }),
      n.getRangeAt(0).insertNode(i),
      n.collapseToEnd());
  },
  Aa = (e) => {
    let t = {},
      n = (e, r) => {
        let i = e.data.uid;
        (r && r.children.push(i),
          (t[i] = { isRoot: !r, data: { ...e.data }, children: [] }),
          e.children &&
            e.children.length > 0 &&
            e.children.forEach((e) => {
              n(e, t[i]);
            }));
      };
    return (n(e, null), t);
  },
  ja = (e, t, n, r) => Math.sqrt((e - n) ** 2 + (t - r) ** 2),
  Ma = ({ addContentToHeader: e, addContentToFooter: t }) => {
    let n = [],
      r = null,
      i = 0,
      a = null,
      o = 0,
      s = (e, t) => {
        if (typeof e == `function`) {
          let r = e();
          if (!r) return;
          let { el: i, cssText: a, height: o } = r;
          (i instanceof HTMLElement && (Ia(i), t(Pa({ el: i, height: o }), o)),
            a && n.push(a));
        }
      };
    return (
      s(e, (e, t) => {
        ((r = e), (i = t));
      }),
      s(t, (e, t) => {
        ((a = e), (o = t));
      }),
      { cssTextList: n, header: r, headerHeight: i, footer: a, footerHeight: o }
    );
  },
  Na = (e, t = 0, n = 0, r = 0, i = 0, a = !1, o = !1) => {
    let s = 1 / 0,
      c = -1 / 0,
      l = 1 / 0,
      u = -1 / 0,
      d = (e, t) => {
        if (!(t && a) && e.group)
          try {
            let {
              x: t,
              y: n,
              width: r,
              height: i,
            } = e.group.findOne(`.smm-node-shape`).rbox();
            (t < s && (s = t),
              t + r > c && (c = t + r),
              n < l && (l = n),
              n + i > u && (u = n + i));
          } catch {}
        (!o &&
          e._generalizationList.length > 0 &&
          e._generalizationList.forEach((e) => {
            d(e.generalizationNode);
          }),
          e.children &&
            e.children.forEach((e) => {
              d(e);
            }));
      };
    return (
      d(e, !0),
      (s = s - t + r),
      (l = l - n + i),
      (c = c - t + r),
      (u = u - n + i),
      { left: s, top: l, width: c - s, height: u - l }
    );
  };
(() => {
  if (document.documentElement.requestFullScreen) return `fullscreenchange`;
  if (document.documentElement.webkitRequestFullScreen)
    return `webkitfullscreenchange`;
  if (document.documentElement.mozRequestFullScreen)
    return `mozfullscreenchange`;
  if (document.documentElement.msRequestFullscreen) return `msfullscreenchange`;
})();
var Pa = ({ el: e, width: t, height: n }) => {
    let r = new mi();
    return (
      t !== void 0 && r.width(t),
      n !== void 0 && r.height(n),
      r.add(e),
      r
    );
  },
  Fa = (e) => {
    let t = e.generalization;
    return t ? (Array.isArray(t) ? t : [t]) : [];
  },
  Ia = (e) => {
    e.setAttribute(`xmlns`, `http://www.w3.org/1999/xhtml`);
  },
  La = (e) => ((e = [...e]), e.sort((e, t) => e.sortIndex - t.sortIndex), e),
  Ra = (e, t) => (0, Te.default)(e, t, { arrayMerge: (e, t) => t }),
  za = (e) => {
    let t = {};
    return (
      me.forEach((n) => {
        let r = e.style.merge(n);
        (n === `fontSize` && (r += `px`), (t[n] = r));
      }),
      t
    );
  },
  Ba = [
    `backgroundColor`,
    `backgroundImage`,
    `backgroundRepeat`,
    `backgroundPosition`,
    `backgroundSize`,
  ],
  Va = [
    `gradientStyle`,
    `startColor`,
    `endColor`,
    `startDir`,
    `endDir`,
    `fillColor`,
    `borderColor`,
    `borderWidth`,
    `borderDasharray`,
  ],
  Ha = class e {
    static setBackgroundStyle(t, n) {
      if (!t) return;
      if (!e.cacheStyle) {
        e.cacheStyle = {};
        let n = window.getComputedStyle(t);
        Ba.forEach((t) => {
          e.cacheStyle[t] = n[t];
        });
      }
      let {
        backgroundColor: r,
        backgroundImage: i,
        backgroundRepeat: a,
        backgroundPosition: o,
        backgroundSize: s,
      } = n;
      ((t.style.backgroundColor = r),
        i && i !== `none`
          ? ((t.style.backgroundImage = `url(${i})`),
            (t.style.backgroundRepeat = a),
            (t.style.backgroundPosition = o),
            (t.style.backgroundSize = s))
          : (t.style.backgroundImage = `none`));
    }
    static removeBackgroundStyle(t) {
      e.cacheStyle &&=
        (Ba.forEach((n) => {
          t.style[n] = e.cacheStyle[n];
        }),
        null);
    }
    constructor(e) {
      ((this.ctx = e),
        (this._markerPath = null),
        (this._marker = null),
        (this._gradient = null));
    }
    merge(e, t) {
      let n = this.ctx.mindMap.themeConfig,
        r = null,
        i = !1;
      t
        ? ((i = !0), (r = n))
        : (r = this.ctx.isGeneralization
            ? n.generalization
            : this.ctx.layerIndex === 0
              ? n.root
              : this.ctx.layerIndex === 1
                ? n.second
                : n.node);
      let a = ``;
      return (
        (a =
          this.getSelfStyle(e) === void 0
            ? r[e] === void 0
              ? n[e]
              : r[e]
            : this.getSelfStyle(e)),
        i || this.addToEffectiveStyles({ [e]: a }),
        a
      );
    }
    getStyle(e, t) {
      return this.merge(e, t);
    }
    getSelfStyle(e) {
      return this.ctx.getData(e);
    }
    addToEffectiveStyles(e) {
      this.ctx.mindMap.painter &&
        (this.ctx.effectiveStyles = { ...this.ctx.effectiveStyles, ...e });
    }
    rect(e) {
      (this.shape(e), e.radius(this.merge(`borderRadius`)));
    }
    shape(e) {
      let t = {};
      (Va.forEach((e) => {
        t[e] = this.merge(e);
      }),
        t.gradientStyle
          ? ((this._gradient ||= this.ctx.nodeDraw.gradient(`linear`)),
            this._gradient.update((e) => {
              (e.stop(0, t.startColor), e.stop(1, t.endColor));
            }),
            this._gradient.from(...t.startDir).to(...t.endDir),
            e.fill(this._gradient))
          : e.fill({ color: t.fillColor }),
        e.stroke({
          color: t.borderColor,
          width: t.borderWidth,
          dasharray: t.borderDasharray,
        }));
    }
    text(e) {
      let t = {
        color: this.merge(`color`),
        fontFamily: this.merge(`fontFamily`),
        fontSize: this.merge(`fontSize`),
        fontWeight: this.merge(`fontWeight`),
        fontStyle: this.merge(`fontStyle`),
        textDecoration: this.merge(`textDecoration`),
      };
      e.fill({ color: t.color }).css({
        "font-family": t.fontFamily,
        "font-size": t.fontSize + `px`,
        "font-weight": t.fontWeight,
        "font-style": t.fontStyle,
        "text-decoration": t.textDecoration,
      });
    }
    domText(e, t = 1) {
      let n = {
        color: this.merge(`color`),
        fontFamily: this.merge(`fontFamily`),
        fontSize: this.merge(`fontSize`),
        fontWeight: this.merge(`fontWeight`),
        fontStyle: this.merge(`fontStyle`),
        textDecoration: this.merge(`textDecoration`),
        textAlign: this.merge(`textAlign`),
      };
      ((e.style.color = n.color),
        (e.style.textDecoration = n.textDecoration),
        (e.style.fontFamily = n.fontFamily),
        (e.style.fontSize = n.fontSize * t + `px`),
        (e.style.fontWeight = n.fontWeight || `normal`),
        (e.style.fontStyle = n.fontStyle),
        (e.style.textAlign = n.textAlign));
    }
    tagText(e, t) {
      e.fill({ color: `#fff` }).css({ "font-size": t.fontSize + `px` });
    }
    tagRect(e, t) {
      (e.fill({ color: t.fill }), t.radius && e.radius(t.radius));
    }
    iconNode(e, t) {
      e.attr({ fill: t || this.merge(`color`) });
    }
    line(e, { width: t, color: n, dasharray: r } = {}, i, a) {
      let { customHandleLine: o } = this.ctx.mindMap.opt;
      if (
        (typeof o == `function` &&
          o(this.ctx, e, { width: t, color: n, dasharray: r }),
        e.stroke({ color: n, dasharray: r, width: t }).fill({ color: `none` }),
        i)
      ) {
        let t = this.merge(`showLineMarker`, !0),
          r = a.style;
        if (t) {
          ((r._marker = r._marker || r.createMarker()),
            r._markerPath.stroke({ color: n }).fill({ color: n }),
            e.attr(`marker-start`, ``),
            e.attr(`marker-end`, ``));
          let t = r.merge(`lineMarkerDir`);
          e.marker(t, r._marker);
        } else
          r._marker &&=
            (e.attr(`marker-start`, ``),
            e.attr(`marker-end`, ``),
            r._marker.remove(),
            null);
      }
    }
    createMarker() {
      return this.ctx.lineDraw.marker(20, 20, (e) => {
        (e.ref(8, 5),
          e.size(20, 20),
          e.attr(`markerUnits`, `userSpaceOnUse`),
          e.attr(`orient`, `auto-start-reverse`),
          (this._markerPath = e.path(`M0,0 L2,5 L0,10 L10,5 Z`)));
      });
    }
    generalizationLine(e) {
      e.stroke({
        width: this.merge(`generalizationLineWidth`, !0),
        color: this.merge(`generalizationLineColor`, !0),
      }).fill({ color: `none` });
    }
    iconBtn(e, t, n) {
      let {
        color: r,
        fill: i,
        fontSize: a,
        fontColor: o,
      } = this.ctx.mindMap.opt.expandBtnStyle || {
        color: `#808080`,
        fill: `#fff`,
        fontSize: 12,
        strokeColor: `#333333`,
        fontColor: `#333333`,
      };
      (e.fill({ color: r }),
        t.fill({ color: r }),
        n.fill({ color: i }),
        this.ctx.mindMap.opt.isShowExpandNum &&
          e.attr({ "font-size": a + `px`, "font-color": o }));
    }
    hasCustomStyle() {
      let e = !1;
      return (
        Object.keys(this.ctx.getData()).forEach((t) => {
          la(t) && (e = !0);
        }),
        e
      );
    }
    getCustomStyle() {
      let e = {};
      return (
        Object.keys(this.ctx.getData()).forEach((t) => {
          la(t) && (e[t] = this.ctx.getData(t));
        }),
        e
      );
    }
    hoverNode(e) {
      let t =
          this.merge(`hoverRectColor`) || this.ctx.mindMap.opt.hoverRectColor,
        n = this.merge(`hoverRectRadius`);
      e.radius(n).fill(`none`).stroke({ color: t });
    }
    onRemove() {
      ((this._marker &&= (this._marker.remove(), null)),
        (this._markerPath &&= (this._markerPath.remove(), null)),
        (this._gradient &&= (this._gradient.remove(), null)));
    }
  };
Ha.cacheStyle = null;
var Ua = class {
    constructor(e) {
      ((this.node = e), (this.mindMap = e.mindMap));
    }
    getShapePadding(e, t, n, r) {
      let i = this.node.getShape(),
        a = e + n * 2,
        o = t + r * 2,
        s = Math.abs(a - o);
      switch (i) {
        case w.SHAPE.ROUNDED_RECTANGLE:
          return { paddingX: t > e ? (t - e) / 2 : 0, paddingY: 0 };
        case w.SHAPE.DIAMOND:
          return { paddingX: e / 2, paddingY: t / 2 };
        case w.SHAPE.PARALLELOGRAM:
          return { paddingX: n <= 0 ? 15 : 0, paddingY: 0 };
        case w.SHAPE.OUTER_TRIANGULAR_RECTANGLE:
          return { paddingX: n <= 0 ? 15 : 0, paddingY: 0 };
        case w.SHAPE.INNER_TRIANGULAR_RECTANGLE:
          return { paddingX: n <= 0 ? 15 : 0, paddingY: 0 };
        case w.SHAPE.ELLIPSE:
          return { paddingX: n <= 0 ? 15 : 0, paddingY: r <= 0 ? 5 : 0 };
        case w.SHAPE.CIRCLE:
          return { paddingX: o > a ? s / 2 : 0, paddingY: o < a ? s / 2 : 0 };
      }
      let c = this.getShapeFromExtendList(i);
      return (
        (c &&
          c.getPadding({
            node: this.node,
            width: e,
            height: t,
            paddingX: n,
            paddingY: r,
          })) || { paddingX: 0, paddingY: 0 }
      );
    }
    getShapeFromExtendList(e) {
      return this.mindMap.extendShapeList.find((t) => t.name === e);
    }
    createShape() {
      let e = this.node.getShape(),
        t = null;
      if (
        (e === w.SHAPE.RECTANGLE
          ? (t = this.createRect())
          : e === w.SHAPE.DIAMOND
            ? (t = this.createDiamond())
            : e === w.SHAPE.PARALLELOGRAM
              ? (t = this.createParallelogram())
              : e === w.SHAPE.ROUNDED_RECTANGLE
                ? (t = this.createRoundedRectangle())
                : e === w.SHAPE.OCTAGONAL_RECTANGLE
                  ? (t = this.createOctagonalRectangle())
                  : e === w.SHAPE.OUTER_TRIANGULAR_RECTANGLE
                    ? (t = this.createOuterTriangularRectangle())
                    : e === w.SHAPE.INNER_TRIANGULAR_RECTANGLE
                      ? (t = this.createInnerTriangularRectangle())
                      : e === w.SHAPE.ELLIPSE
                        ? (t = this.createEllipse())
                        : e === w.SHAPE.CIRCLE && (t = this.createCircle()),
        !t)
      ) {
        let n = this.getShapeFromExtendList(e);
        n && (t = n.createShape(this.node));
      }
      return t || this.createRect();
    }
    getNodeSize() {
      let e = this.node.getBorderWidth(),
        { width: t, height: n } = this.node;
      return ((t -= e), (n -= e), { width: t, height: n });
    }
    createPath(e) {
      let { customCreateNodePath: t } = this.mindMap.opt;
      return t ? J(t(e)) : new Ar().plot(e);
    }
    createPolygon(e) {
      let { customCreateNodePolygon: t } = this.mindMap.opt;
      return t ? J(t(e)) : new Lr().plot(e);
    }
    createRect() {
      let { width: e, height: t } = this.getNodeSize(),
        n = this.node.style.merge(`borderRadius`),
        r = `
      M${n},0
      L${e - n},0
      C${e - n},0 ${e},0 ${e},${n}
      L${e},${t - n}
      C${e},${t - n} ${e},${t} ${e - n},${t}
      L${n},${t}
      C${n},${t} 0,${t} 0,${t - n}
      L0,${n}
      C0,${n} 0,0 ${n},0
      Z
    `;
      return this.createPath(r);
    }
    createDiamond() {
      let { width: e, height: t } = this.getNodeSize(),
        n = e / 2,
        r = t / 2,
        i = [
          [n, 0],
          [e, r],
          [n, t],
          [0, r],
        ];
      return this.createPolygon(i);
    }
    createParallelogram() {
      let { paddingX: e } = this.node.getPaddingVale();
      e ||= this.node.shapePadding.paddingX;
      let { width: t, height: n } = this.getNodeSize(),
        r = [
          [e, 0],
          [t, 0],
          [t - e, n],
          [0, n],
        ];
      return this.createPolygon(r);
    }
    createRoundedRectangle() {
      let { width: e, height: t } = this.getNodeSize(),
        n = t / 2,
        r = `
      M${n},0
      L${e - n},0
      A${t / 2},${t / 2} 0 0,1 ${e - n},${t} 
      L${n},${t}
      A${t / 2},${t / 2} 0 0,1 ${n},0
    `;
      return this.createPath(r);
    }
    createOctagonalRectangle() {
      let { width: e, height: t } = this.getNodeSize(),
        n = [
          [0, 5],
          [5, 0],
          [e - 5, 0],
          [e, 5],
          [e, t - 5],
          [e - 5, t],
          [5, t],
          [0, t - 5],
        ];
      return this.createPolygon(n);
    }
    createOuterTriangularRectangle() {
      let { paddingX: e } = this.node.getPaddingVale();
      e ||= this.node.shapePadding.paddingX;
      let { width: t, height: n } = this.getNodeSize(),
        r = [
          [e, 0],
          [t - e, 0],
          [t, n / 2],
          [t - e, n],
          [e, n],
          [0, n / 2],
        ];
      return this.createPolygon(r);
    }
    createInnerTriangularRectangle() {
      let { paddingX: e } = this.node.getPaddingVale();
      e ||= this.node.shapePadding.paddingX;
      let { width: t, height: n } = this.getNodeSize(),
        r = [
          [0, 0],
          [t, 0],
          [t - e / 2, n / 2],
          [t, n],
          [0, n],
          [e / 2, n / 2],
        ];
      return this.createPolygon(r);
    }
    createEllipse() {
      let { width: e, height: t } = this.getNodeSize(),
        n = e / 2,
        r = t / 2,
        i = `
      M${n},0
      A${n},${r} 0 0,1 ${n},${t} 
      M${n},${t} 
      A${n},${r} 0 0,1 ${n},0 
    `;
      return this.createPath(i);
    }
    createCircle() {
      let { width: e, height: t } = this.getNodeSize(),
        n = e / 2,
        r = t / 2,
        i = `
      M${n},0
      A${n},${r} 0 0,1 ${n},${t} 
      M${n},${t} 
      A${n},${r} 0 0,1 ${n},0 
    `;
      return this.createPath(i);
    }
  },
  Wa = [
    w.SHAPE.RECTANGLE,
    w.SHAPE.DIAMOND,
    w.SHAPE.PARALLELOGRAM,
    w.SHAPE.ROUNDED_RECTANGLE,
    w.SHAPE.OCTAGONAL_RECTANGLE,
    w.SHAPE.OUTER_TRIANGULAR_RECTANGLE,
    w.SHAPE.INNER_TRIANGULAR_RECTANGLE,
    w.SHAPE.ELLIPSE,
    w.SHAPE.CIRCLE,
  ];
function Ga() {
  let e = this.getData(`generalization`);
  return Array.isArray(e) ? e : e ? [e] : [];
}
function Ka() {
  return this.formatGetGeneralization().length > 0;
}
function qa() {
  return !!this.formatGetGeneralization().find(
    (e) => !e.range || e.range.length <= 0,
  );
}
function Ja(e) {
  return this._generalizationList.findIndex(
    (t) => t.generalizationNode.uid === e.uid,
  );
}
function Ya() {
  if (this.isGeneralization || !this.checkHasGeneralization()) return;
  let e = 0,
    t = 0;
  (this.formatGetGeneralization().forEach((n, r) => {
    let i = this._generalizationList[r];
    ((i ||= this._generalizationList[r] = {}),
      (i.node = this),
      (i.range = n.range),
      (i.generalizationLine ||= this.lineDraw.path()),
      (i.generalizationNode ||= new Ds({
        data: { inserting: n.inserting, data: n },
        uid: Zi(),
        renderer: this.renderer,
        mindMap: this.mindMap,
        isGeneralization: !0,
      })),
      delete n.inserting,
      (i.generalizationNode.generalizationBelongNode = this),
      i.generalizationNode.width > e && (e = i.generalizationNode.width),
      i.generalizationNode.height > t && (t = i.generalizationNode.height),
      n.isActive && this.renderer.addNodeToActiveList(i.generalizationNode));
  }),
    (this._generalizationNodeWidth = e),
    (this._generalizationNodeHeight = t));
}
function Xa() {
  this.isGeneralization ||
    (this.removeGeneralization(), this.createGeneralizationNode());
}
function Za(e) {
  if (this.isGeneralization) return;
  this.updateGeneralizationData();
  let t = this.formatGetGeneralization();
  if (t.length <= 0 || this.getData(`expand`) === !1) {
    this.removeGeneralization();
    return;
  }
  (t.length !== this._generalizationList.length && this.removeGeneralization(),
    this.createGeneralizationNode(),
    this.renderer.layout.renderGeneralization(this._generalizationList),
    this._generalizationList.forEach((t) => {
      (this.style.generalizationLine(t.generalizationLine),
        t.generalizationNode.render(() => {}, e));
    }));
}
function Qa() {
  let e = this.getChildrenLength(),
    t = this.formatGetGeneralization(),
    n = [];
  (t.forEach((t) => {
    if (!t.range) {
      n.push(t);
      return;
    }
    t.range.length > 0 &&
      t.range[0] <= e - 1 &&
      t.range[1] <= e - 1 &&
      n.push(t);
  }),
    n.length !== t.length && this.setData({ generalization: n }));
}
function $a() {
  this.isGeneralization ||
    (this._generalizationList.forEach((e) => {
      (e.generalizationNode.style.onRemove(),
        (e.generalizationLine &&= (e.generalizationLine.remove(), null)),
        (e.generalizationNode &&=
          (this.renderer.removeNodeFromActiveList(e.generalizationNode),
          e.generalizationNode.remove(),
          null)));
    }),
    (this._generalizationList = []),
    this.generalizationBelongNode &&
      this.nodeDraw
        .find(`.generalization_` + this.generalizationBelongNode.uid)
        .remove());
}
function eo() {
  this.isGeneralization ||
    this._generalizationList.forEach((e) => {
      (e.generalizationLine && e.generalizationLine.hide(),
        e.generalizationNode && e.generalizationNode.hide());
    });
}
function to() {
  this.isGeneralization ||
    this._generalizationList.forEach((e) => {
      (e.generalizationLine && e.generalizationLine.show(),
        e.generalizationNode && e.generalizationNode.show());
    });
}
function no(e) {
  this._generalizationList.forEach((t) => {
    (t.generalizationLine.opacity(e), t.generalizationNode.group.opacity(e));
  });
}
function ro() {
  let e = this.generalizationBelongNode,
    t = e.formatGetGeneralization()[e.getGeneralizationNodeIndex(this)],
    n = this.getStyle(`hoverRectColor`) || this.mindMap.opt.hoverRectColor,
    r = n ? { stroke: n } : null;
  Array.isArray(t.range) && t.range.length > 0
    ? this.mindMap.renderer.highlightNode(e, t.range, r)
    : this.mindMap.renderer.highlightNode(e, null, r);
}
function io() {
  this.mindMap.renderer.closeHighlightNode();
}
var ao = {
    formatGetGeneralization: Ga,
    checkHasGeneralization: Ka,
    checkHasSelfGeneralization: qa,
    getGeneralizationNodeIndex: Ja,
    createGeneralizationNode: Ya,
    updateGeneralization: Xa,
    updateGeneralizationData: Qa,
    renderGeneralization: Za,
    removeGeneralization: $a,
    hideGeneralization: eo,
    showGeneralization: to,
    setGeneralizationOpacity: no,
    handleGeneralizationMouseenter: ro,
    handleGeneralizationMouseleave: io,
  },
  oo = {
    open: `<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path d="M475.136 327.168v147.968h-147.968v74.24h147.968v147.968h74.24v-147.968h147.968v-74.24h-147.968v-147.968h-74.24z m36.864-222.208c225.28 0 407.04 181.76 407.04 407.04s-181.76 407.04-407.04 407.04-407.04-181.76-407.04-407.04 181.76-407.04 407.04-407.04z m0-74.24c-265.216 0-480.768 215.552-480.768 480.768s215.552 480.768 480.768 480.768 480.768-215.552 480.768-480.768-215.552-480.768-480.768-480.768z"></path></svg>`,
    close: `<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path d="M512 105.472c225.28 0 407.04 181.76 407.04 407.04s-181.76 407.04-407.04 407.04-407.04-181.76-407.04-407.04 181.76-407.04 407.04-407.04z m0-74.24c-265.216 0-480.768 215.552-480.768 480.768s215.552 480.768 480.768 480.768 480.768-215.552 480.768-480.768-215.552-480.768-480.768-480.768z"></path><path d="M252.928 474.624h518.144v74.24h-518.144z"></path></svg>`,
    remove: `<svg width="14px" height="14px" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path fill="#ffffff" d="M512 105.472c225.28 0 407.04 181.76 407.04 407.04s-181.76 407.04-407.04 407.04-407.04-181.76-407.04-407.04 181.76-407.04 407.04-407.04z m0-74.24c-265.216 0-480.768 215.552-480.768 480.768s215.552 480.768 480.768 480.768 480.768-215.552 480.768-480.768-215.552-480.768-480.768-480.768z"></path><path fill="#ffffff" d="M252.928 474.624h518.144v74.24h-518.144z"></path></svg>`,
    imgAdjust: `<svg width="12px" height="12px" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"><path fill="#ffffff" d="M1008.128 614.4a25.6 25.6 0 0 0-27.648 5.632l-142.848 142.848L259.072 186.88 401.92 43.52A25.6 25.6 0 0 0 384 0h-358.4a25.6 25.6 0 0 0-25.6 25.6v358.4a25.6 25.6 0 0 0 43.52 17.92l143.36-142.848 578.048 578.048-142.848 142.848a25.6 25.6 0 0 0 17.92 43.52h358.4a25.6 25.6 0 0 0 25.6-25.6v-358.4a25.6 25.6 0 0 0-15.872-25.088z"  /></svg>`,
    quickCreateChild: `<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path d="M514.048 62.464q93.184 0 175.616 35.328t143.872 96.768 96.768 143.872 35.328 175.616q0 94.208-35.328 176.128t-96.768 143.36-143.872 96.768-175.616 35.328q-94.208 0-176.64-35.328t-143.872-96.768-96.768-143.36-35.328-176.128q0-93.184 35.328-175.616t96.768-143.872 143.872-96.768 176.64-35.328zM772.096 576.512q26.624 0 45.056-18.944t18.432-45.568-18.432-45.056-45.056-18.432l-192.512 0 0-192.512q0-26.624-18.944-45.568t-45.568-18.944-45.056 18.944-18.432 45.568l0 192.512-192.512 0q-26.624 0-45.056 18.432t-18.432 45.056 18.432 45.568 45.056 18.944l192.512 0 0 191.488q0 26.624 18.432 45.568t45.056 18.944 45.568-18.944 18.944-45.568l0-191.488 192.512 0z"></path></svg>`,
  };
function so() {
  if (this._openExpandNode) return;
  let {
      expandBtnSize: e,
      expandBtnIcon: t,
      isShowExpandNum: n,
    } = this.mindMap.opt,
    { close: r, open: i } = t || {};
  (n
    ? ((this._openExpandNode = new K()),
      this._openExpandNode.addClass(`smm-expand-btn-text`),
      this._openExpandNode.attr({
        "text-anchor": `middle`,
        "dominant-baseline": `middle`,
        x: e / 2,
        y: 2,
      }))
    : ((this._openExpandNode = J(i || oo.open).size(e, e)),
      this._openExpandNode.x(0).y(-e / 2)),
    (this._closeExpandNode = J(r || oo.close).size(e, e)),
    this._closeExpandNode.x(0).y(-e / 2),
    (this._fillExpandNode = new fi().size(e)),
    this._fillExpandNode.x(0).y(-e / 2),
    this.style.iconBtn(
      this._openExpandNode,
      this._closeExpandNode,
      this._fillExpandNode,
    ));
}
function co(e = []) {
  return e.reduce((e, t) => e + this.sumNode(t.children || []), e.length);
}
function lo() {
  let { expand: e } = this.getData();
  if (e === this._lastExpandBtnType) return;
  (this._expandBtn && this._expandBtn.clear(), this.createExpandNodeContent());
  let t;
  if (
    (e === !1
      ? ((t = this._openExpandNode), (this._lastExpandBtnType = !1))
      : ((t = this._closeExpandNode), (this._lastExpandBtnType = !0)),
    this._expandBtn)
  ) {
    let {
      isShowExpandNum: n,
      expandBtnStyle: r,
      expandBtnNumHandler: i,
    } = this.mindMap.opt;
    if (n)
      if (e) this._fillExpandNode.stroke(`none`);
      else {
        this._fillExpandNode.stroke({ color: r.strokeColor });
        let e = this.sumNode(this.nodeData.children || []);
        if (typeof i == `function`) {
          let t = i(e, this);
          ea(t) || (e = t);
        }
        t.text(String(e));
      }
    this._expandBtn.add(this._fillExpandNode).add(t);
  }
}
function uo() {
  this._expandBtn &&
    this.renderer.layout.renderExpandBtn(this, this._expandBtn);
}
function fo() {
  this.getChildrenLength() <= 0 ||
    this.isRoot ||
    (this._expandBtn
      ? this.group.add(this._expandBtn)
      : ((this._expandBtn = new q()),
        this._expandBtn.on(`mouseover`, (e) => {
          (e.stopPropagation(), this._expandBtn.css({ cursor: `pointer` }));
        }),
        this._expandBtn.on(`mouseout`, (e) => {
          (e.stopPropagation(), this._expandBtn.css({ cursor: `auto` }));
        }),
        this._expandBtn.on(`click`, (e) => {
          (e.stopPropagation(),
            this.mindMap.execCommand(
              `SET_NODE_EXPAND`,
              this,
              !this.getData(`expand`),
            ),
            this.mindMap.emit(`expand_btn_click`, this));
        }),
        this._expandBtn.on(`dblclick`, (e) => {
          e.stopPropagation();
        }),
        this._expandBtn.addClass(`smm-expand-btn`),
        this.group.add(this._expandBtn)),
    (this._showExpandBtn = !0),
    this.updateExpandBtnNode(),
    this.updateExpandBtnPos());
}
function po() {
  this._expandBtn &&
    this._showExpandBtn &&
    (this._expandBtn.remove(), (this._showExpandBtn = !1));
}
function mo() {
  let { alwaysShowExpandBtn: e, notShowExpandBtn: t } = this.mindMap.opt;
  e ||
    t ||
    setTimeout(() => {
      this.renderExpandBtn();
    }, 0);
}
function ho() {
  let { alwaysShowExpandBtn: e, notShowExpandBtn: t } = this.mindMap.opt;
  if (e || this._isMouseenter || t) return;
  let { isActive: n, expand: r } = this.getData();
  !n &&
    r &&
    setTimeout(() => {
      this.removeExpandBtn();
    }, 0);
}
var go = {
  createExpandNodeContent: so,
  updateExpandBtnNode: lo,
  updateExpandBtnPos: uo,
  renderExpandBtn: fo,
  removeExpandBtn: po,
  showExpandBtn: mo,
  hideExpandBtn: ho,
  sumNode: co,
};
function _o(e = {}) {
  this.mindMap.execCommand(`SET_NODE_DATA`, this, e);
}
function vo(e, t, n) {
  this.mindMap.execCommand(`SET_NODE_TEXT`, this, e, t, n);
}
function yo(e) {
  this.mindMap.execCommand(`SET_NODE_IMAGE`, this, e);
}
function bo(e) {
  this.mindMap.execCommand(`SET_NODE_ICON`, this, e);
}
function xo(e, t) {
  this.mindMap.execCommand(`SET_NODE_HYPERLINK`, this, e, t);
}
function So(e) {
  this.mindMap.execCommand(`SET_NODE_NOTE`, this, e);
}
function Co(e, t) {
  this.mindMap.execCommand(`SET_NODE_ATTACHMENT`, this, e, t);
}
function wo(e) {
  this.mindMap.execCommand(`SET_NODE_TAG`, this, e);
}
function To(e) {
  this.mindMap.execCommand(`SET_NODE_SHAPE`, this, e);
}
function Eo(e, t) {
  this.mindMap.execCommand(`SET_NODE_STYLE`, this, e, t);
}
function Do(e) {
  this.mindMap.execCommand(`SET_NODE_STYLES`, this, e);
}
var Oo = {
    setData: _o,
    setText: vo,
    setImage: yo,
    setIcon: bo,
    setHyperlink: xo,
    setNote: So,
    setAttachment: Co,
    setTag: wo,
    setShape: To,
    setStyle: Eo,
    setStyles: Do,
  },
  ko = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M435.484444 251.733333v68.892445L295.822222 320.682667a168.504889 168.504889 0 0 0-2.844444 336.952889h142.506666v68.892444H295.822222a237.397333 237.397333 0 0 1 0-474.794667h139.662222z m248.945778 0a237.397333 237.397333 0 0 1 0 474.851556H544.654222v-69.006222l139.776 0.056889a168.504889 168.504889 0 0 0 2.844445-336.952889H544.597333V251.676444h139.776z m-25.827555 203.946667a34.474667 34.474667 0 0 1 0 68.892444H321.649778a34.474667 34.474667 0 0 1 0-68.892444h336.952889z" ></path></svg>`,
  Ao = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M152.768 985.984 152.768 49.856l434.56 0 66.816 0 234.048 267.392 0 66.816 0 601.92L152.768 985.984 152.768 985.984zM654.144 193.088l0 124.16 108.736 0L654.144 193.088 654.144 193.088zM821.312 384.064l-167.168 0L587.328 384.064 587.328 317.312 587.328 116.736 219.584 116.736 219.584 919.04l601.728 0L821.312 384.064 821.312 384.064zM386.688 517.888 319.808 517.888 319.808 450.944l66.816 0L386.624 517.888 386.688 517.888zM386.688 651.584 319.808 651.584 319.808 584.704l66.816 0L386.624 651.584 386.688 651.584zM386.688 785.344 319.808 785.344l0-66.88 66.816 0L386.624 785.344 386.688 785.344zM721.024 517.888 453.632 517.888 453.632 450.944l267.392 0L721.024 517.888 721.024 517.888zM654.144 651.584 453.632 651.584 453.632 584.704l200.512 0L654.144 651.584 654.144 651.584zM620.672 785.344l-167.04 0 0-66.88 167.04 0L620.672 785.344 620.672 785.344z" ></path></svg>`,
  jo = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" width="128" height="128"><path d="M516.373333 375.978667l136.576-136.576a147.797333 147.797333 0 0 1 208.853334-0.021334 147.690667 147.690667 0 0 1-0.042667 208.832l-204.8 204.778667v0.021333l-153.621333 153.6c-85.973333 85.973333-225.28 85.973333-311.253334 0.021334-85.994667-85.973333-85.973333-225.216 0.149334-311.36L431.146667 256.362667a21.333333 21.333333 0 0 0-30.165334-30.165334L162.069333 465.066667c-102.805333 102.826667-102.826667 269.056-0.149333 371.733333 102.613333 102.613333 268.970667 102.613333 371.584 0l153.6-153.642667h0.021333l0.021334-0.021333 204.778666-204.778667c74.325333-74.325333 74.346667-194.858667 0.021334-269.184-74.24-74.24-194.88-74.24-269.162667 0.042667l-136.576 136.554667-187.626667 187.626666a117.845333 117.845333 0 0 0-0.106666 166.826667 118.037333 118.037333 0 0 0 166.826666-0.106667l255.850667-255.829333a21.333333 21.333333 0 0 0-30.165333-30.165333L435.136 669.973333a75.370667 75.370667 0 0 1-106.496 0.106667 75.178667 75.178667 0 0 1 0.128-106.496l187.605333-187.605333z" ></path></svg>`,
  Mo = [
    {
      name: `优先级图标`,
      type: `priority`,
      list: [
        {
          name: `1`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512.042667 1024C229.248 1024 0 794.794667 0 511.957333 0 229.205333 229.248 0 512.042667 0 794.752 0 1024 229.205333 1024 511.957333 1024 794.794667 794.752 1024 512.042667 1024z" fill="#E93B30"></path><path d="M580.309333 256h-75.52c-10.666667 29.824-30.165333 55.765333-58.709333 78.165333-28.416 22.314667-54.869333 37.418667-79.146667 45.397334v84.608a320 320 0 0 0 120.234667-70.698667v352.085333H580.266667V256z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `2`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M511.957333 1024C229.248 1024 0 794.752 0 512S229.248 0 511.957333 0C794.752 0 1024 229.248 1024 512s-229.248 512-512.042667 512z" fill="#FA8D2E"></path><path d="M667.946667 658.602667h-185.301334c4.864-8.533333 11.178667-17.066667 19.072-25.984 7.808-8.874667 26.453333-26.837333 55.936-53.888 29.525333-27.008 49.877333-47.786667 61.226667-62.165334 16.981333-21.717333 29.44-42.453333 37.290667-62.293333 7.808-19.84 11.776-40.746667 11.776-62.677333 0-38.570667-13.738667-70.741333-41.088-96.725334C599.466667 268.928 561.706667 256 513.834667 256c-43.690667 0-80.128 11.136-109.354667 33.578667-29.098667 22.4-46.506667 59.306667-52.010667 110.805333l93.184 9.301333c1.792-27.349333 8.405333-46.890667 19.754667-58.624 11.434667-11.776 26.837333-17.664 46.165333-17.664 19.541333 0 34.858667 5.589333 45.909334 16.768 11.136 11.264 16.682667 27.221333 16.682666 48.042667 0 18.858667-6.4 37.930667-19.242666 57.258667-9.472 14.037333-35.157333 40.533333-77.098667 79.872-52.096 48.554667-87.04 87.509333-104.704 116.821333A226.688 226.688 0 0 0 341.333333 745.429333h326.613334v-86.826666z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `3`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.752 0 512 0z" fill="#2E66FA"></path><path d="M627.754667 731.733333c-29.354667 25.088-66.901333 37.632-112.725334 37.632-44.928 0-81.792-11.52-110.592-34.773333-33.066667-26.538667-49.877333-64.469333-50.304-114.133333h92.16c0.426667 21.76 7.552 38.314667 21.333334 49.664 12.288 10.88 28.117333 16.341333 47.402666 16.341333 20.309333 0 36.778667-6.101333 49.322667-18.432 12.544-12.330667 18.773333-29.568 18.773333-51.797333 0-21.290667-6.229333-38.186667-18.773333-50.773334-12.544-12.501333-29.866667-18.773333-52.138667-18.773333h-13.525333v-80.042667H512c42.112 0 63.274667-21.034667 63.274667-63.146666 0-20.309333-5.888-36.096-17.706667-47.445334a60.757333 60.757333 0 0 0-43.818667-17.066666c-17.493333 0-32 5.504-43.434666 16.298666-11.562667 10.88-17.792 25.728-18.773334 44.714667H359.68c0.981333-43.946667 16.042667-78.976 45.397333-104.96 29.354667-25.941333 65.706667-39.04 109.226667-39.04 44.928 0 81.792 13.525333 110.592 40.490667 28.8 26.922667 43.306667 61.610667 43.306667 104.149333 0 48.213333-19.413333 82.688-58.154667 103.552 43.52 23.125333 65.28 61.44 65.28 114.858667 0 48.128-15.957333 85.76-47.573333 112.682666z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `4`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512.042667 1024C229.248 1024 0 794.794667 0 512.042667 0 229.205333 229.248 0 512.042667 0 794.752 0 1024 229.205333 1024 512.042667 1024 794.794667 794.752 1024 512.042667 1024z" fill="#6D768D"></path><path d="M600.96 256v309.802667h60.117333v81.536h-60.16v98.218666h-90.154666v-98.218666H311.466667v-81.237334L522.666667 256h78.293333zM510.72 399.104l-112.042667 166.698667h112.042667V399.104z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `5`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512.042667 1024C229.248 1024 0 794.794667 0 512.042667 0 229.205333 229.248 0 512.042667 0 794.752 0 1024 229.205333 1024 512.042667 1024 794.794667 794.752 1024 512.042667 1024z" fill="#6D768D"></path><path d="M470.912 343.552h175.786667V256H400.256l-47.786667 253.952 75.434667 10.837333c21.205333-23.552 45.269333-35.413333 72.021333-35.413333 21.546667 0 38.997333 7.509333 52.437334 22.4 13.312 15.018667 20.053333 37.418667 20.053333 67.328 0 31.872-6.741333 55.765333-20.181333 71.552-13.397333 15.872-29.866667 23.765333-49.237334 23.765333-17.066667 0-32.085333-6.186667-45.013333-18.432-13.013333-12.373333-20.821333-29.013333-23.466667-50.133333L341.333333 611.498667c5.546667 40.874667 22.485333 73.429333 50.730667 97.621333 28.330667 24.32 64.938667 36.437333 109.866667 36.437333 56.149333 0 100.053333-21.546667 131.754666-64.554666a176.64 176.64 0 0 0 34.816-107.52c0-48.042667-14.378667-87.210667-43.221333-117.333334-28.8-30.208-63.957333-45.312-105.514667-45.312-21.674667 0-42.922667 5.248-63.829333 15.616l14.976-82.901333z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `6`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 1024C229.248 1024 0 794.794667 0 512.042667 0 229.205333 229.248 0 512 0c282.88 0 512 229.205333 512 512.042667C1024 794.794667 794.88 1024 512 1024z" fill="#6D768D"></path><path d="M519.210667 256c36.992 0 67.626667 10.368 91.776 31.189333 24.192 20.821333 39.68 51.029333 46.293333 90.709334l-90.197333 9.984c-2.176-18.56-7.978667-32.298667-17.28-41.173334-9.258667-8.874667-21.418667-13.226667-36.224-13.226666-19.754667 0-36.437333 8.789333-50.048 26.453333-13.696 17.664-22.314667 54.613333-25.856 110.549333 23.296-27.52 52.138667-41.258667 86.656-41.258666 38.997333 0 72.362667 14.805333 100.181333 44.544 27.733333 29.696 41.685333 68.010667 41.685333 114.858666 0 49.877333-14.634667 89.856-43.818666 119.936-29.226667 30.208-66.730667 45.226667-112.554667 45.226667-49.066667 0-89.429333-19.072-121.130667-57.344C357.12 658.218667 341.333333 595.541333 341.333333 508.416c0-89.344 16.469333-153.813333 49.493334-193.194667C423.722667 275.754667 466.56 256 519.168 256z m-9.472 241.834667c-17.962667 0-33.066667 6.997333-45.525334 21.12-12.330667 14.037333-18.56 34.858667-18.56 62.293333 0 30.421333 6.912 53.76 20.906667 70.4 13.952 16.469333 29.866667 24.746667 47.786667 24.746667 17.28 0 31.701333-6.826667 43.178666-20.309334 11.52-13.525333 17.237333-35.669333 17.237334-66.56 0-31.658667-6.186667-54.869333-18.517334-69.546666a58.197333 58.197333 0 0 0-46.506666-22.144z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `7`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512.042667 1024C229.248 1024 0 794.752 0 512S229.248 0 512.042667 0C794.752 0 1024 229.248 1024 512s-229.248 512-511.957333 512z" fill="#6D768D"></path><path d="M673.024 273.066667H354.133333v86.869333h212.224a691.2 691.2 0 0 0-104.746666 187.989333c-26.026667 70.101333-39.978667 138.88-41.429334 206.293334h89.6c-0.298667-42.922667 6.698667-91.776 21.034667-146.474667a654.72 654.72 0 0 1 62.08-154.965333c27.136-48.554667 53.888-85.76 80.128-111.701334V273.066667z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `8`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 1024C229.248 1024 0 794.752 0 512S229.248 0 512 0s512 229.248 512 512-229.248 512-512 512z" fill="#6D768D"></path><path d="M512.426667 256c46.208 0 82.048 11.861333 107.605333 35.541333 25.6 23.68 38.314667 53.674667 38.314667 89.898667 0 22.613333-5.802667 42.666667-17.578667 60.330667a111.445333 111.445333 0 0 1-49.450667 40.277333c26.965333 10.837333 47.36 26.752 61.312 47.658667 13.994667 20.906667 21.034667 45.013333 21.034667 72.362666 0 45.098667-14.336 81.834667-42.965333 109.952-28.586667 28.245333-66.602667 42.368-114.090667 42.368-44.245333 0-81.066667-11.648-110.464-34.986666-34.645333-27.52-52.010667-65.28-52.010667-113.365334 0-26.368 6.528-50.645333 19.626667-72.746666 13.056-22.144 33.578667-39.210667 61.696-51.242667-24.064-10.154667-41.557333-24.192-52.48-41.941333a109.824 109.824 0 0 1-16.512-58.666667c0-36.224 12.757333-66.218667 37.973333-89.898667 25.386667-23.68 61.354667-35.541333 108.032-35.541333z m1.28 265.429333c-22.784 0-39.722667 7.978667-50.901334 23.893334-11.136 15.786667-16.64 33.066667-16.64 51.498666 0 25.984 6.485333 46.208 19.712 60.714667 13.098667 14.506667 29.525333 21.802667 49.152 21.802667 19.242667 0 35.157333-6.997333 47.786667-20.992 12.629333-13.909333 18.858667-34.048 18.858667-60.416 0-23.082667-6.314667-41.557333-19.2-55.466667a63.274667 63.274667 0 0 0-48.725334-21.034667z m-0.341334-191.488c-17.792 0-32 5.333333-42.581333 16-10.538667 10.666667-15.872 24.746667-15.872 42.325334 0 18.645333 5.248 33.152 15.701333 43.648 10.453333 10.453333 24.362667 15.658667 41.770667 15.658666 17.664 0 31.658667-5.290667 42.24-15.872 10.538667-10.581333 15.872-25.173333 15.872-43.818666 0-17.493333-5.248-31.573333-15.701333-42.154667s-24.277333-15.786667-41.429334-15.786667z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `9`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 1024C229.248 1024 0 794.794667 0 512.042667 0 229.333333 229.248 0 512 0c282.88 0 512 229.333333 512 512.042667C1024 794.794667 794.88 1024 512 1024z" fill="#6D768D"></path><path d="M497.28 256c49.365333 0 89.856 19.157333 121.429333 57.429333 31.701333 38.229333 47.488 101.205333 47.488 188.842667 0 89.173333-16.384 153.386667-49.365333 192.853333-32.853333 39.594667-75.605333 59.264-128.426667 59.264-37.888 0-68.608-10.154667-91.989333-30.506666s-38.4-50.816-45.013333-91.306667l90.112-9.984c2.261333 18.474667 8.021333 32.085333 17.28 41.088 9.173333 8.874667 21.418667 13.312 36.608 13.312 19.2 0 35.541333-8.874667 48.981333-26.752 13.44-17.749333 22.016-54.613333 25.770667-110.549333-23.466667 27.264-52.821333 40.874667-88.064 40.874666-38.314667 0-71.253333-14.72-99.114667-44.330666C355.242667 506.709333 341.333333 468.224 341.333333 420.864c0-49.493333 14.592-89.258667 43.946667-119.466667C414.549333 271.104 451.925333 256 497.237333 256z m-4.352 77.482667c-17.237333 0-31.658667 6.826667-43.008 20.437333-11.477333 13.653333-17.194667 35.84-17.194667 66.816 0 31.402667 6.229333 54.485333 18.645334 69.205333 12.458667 14.72 27.946667 22.101333 46.592 22.101334 18.005333 0 33.066667-7.082667 45.44-21.205334 12.330667-14.208 18.432-35.029333 18.432-62.506666 0-29.994667-6.912-53.376-20.821334-69.973334-13.824-16.597333-29.866667-24.874667-48.085333-24.874666z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `10`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512.042667 1024C229.248 1024 0 794.794667 0 511.957333 0 229.205333 229.248 0 512.042667 0 794.752 0 1024 229.205333 1024 511.957333 1024 794.794667 794.752 1024 512.042667 1024z" fill="#6D768D"></path><path d="M619.946667 273.066667c46.976 0 83.754667 16.042667 110.250666 48.042666 31.573333 37.973333 47.36 100.864 47.36 188.672 0 87.722667-15.829333 150.698667-47.658666 189.056-26.325333 31.616-62.976 47.36-109.952 47.36-47.274667 0-85.418667-17.237333-114.346667-51.968-28.885333-34.602667-43.392-96.426667-43.392-185.386666 0-87.168 15.872-150.016 47.701333-188.416 26.282667-31.488 62.933333-47.36 110.037334-47.36z m-207.488 12.8v452.266666H325.504V411.690667A299.904 299.904 0 0 1 213.333333 476.373333V398.933333c22.656-7.296 47.36-21.12 73.856-41.514666 26.624-20.522667 44.842667-44.288 54.784-71.552h70.485334z m207.488 60.842666c-11.306667 0-21.461333 3.413333-30.336 10.24-8.874667 6.826667-15.786667 19.157333-20.693334 36.864-6.4 22.997333-9.642667 61.653333-9.642666 115.968 0 54.442667 2.944 91.733333 8.661333 112.128 5.802667 20.352 13.098667 33.877333 21.845333 40.618667 8.789333 6.741333 18.858667 10.154667 30.165334 10.154667 11.349333 0 21.376-3.498667 30.250666-10.325334 8.874667-6.826667 15.786667-19.157333 20.693334-36.778666 6.4-22.826667 9.642667-61.354667 9.642666-115.797334 0-54.314667-2.858667-91.648-8.661333-112.042666-5.802667-20.352-13.013333-33.962667-21.76-40.789334a47.616 47.616 0 0 0-30.165333-10.24z" fill="#FFFFFF"></path></svg>`,
        },
      ],
    },
    {
      name: `进度图标`,
      type: `progress`,
      list: [
        {
          name: `1`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.752 0 512 0z" fill="#12BB37"></path><path d="M512 928c-229.76 0-416-186.24-416-416S282.24 96 512 96V512l294.144-294.144A414.72 414.72 0 0 1 928 512c0 229.76-186.24 416-416 416z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `2`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.752 0 512 0z" fill="#12BB37"></path><path d="M512 928c-229.76 0-416-186.24-416-416S282.24 96 512 96V512h416c0 229.76-186.24 416-416 416z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `3`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.752 0 512 0z" fill="#12BB37"></path><path d="M512 928c-229.76 0-416-186.24-416-416S282.24 96 512 96V512l294.144 294.144A414.72 414.72 0 0 1 512 928z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `4`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.752 0 512 0z" fill="#12BB37"></path><path d="M512 928c-229.76 0-416-186.24-416-416S282.24 96 512 96v832z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `5`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.752 0 512 0z" fill="#12BB37"></path><path d="M512 512l-294.144 294.144A414.72 414.72 0 0 1 96 512c0-229.76 186.24-416 416-416V512z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `6`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.752 0 512 0z" fill="#12BB37"></path><path d="M512 512H96c0-229.76 186.24-416 416-416V512z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `7`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.752 0 512 0z" fill="#12BB37"></path><path d="M512 512L217.856 217.856A414.72 414.72 0 0 1 512 96V512z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `8`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M0 512c0 282.752 229.248 512 512 512s512-229.248 512-512S794.752 0 512 0 0 229.248 0 512z" fill="#12BB37"></path><path d="M716.629333 341.333333h-51.328a35.072 35.072 0 0 0-28.330666 14.293334l-171.989334 233.984-77.909333-106.026667a35.2 35.2 0 0 0-28.330667-14.293333H307.413333c-7.082667 0-11.264 7.936-7.082666 13.653333l136.32 185.472a35.2 35.2 0 0 0 56.533333 0l230.4-313.429333a8.533333 8.533333 0 0 0-6.954667-13.653334z" fill="#FFFFFF"></path></svg>`,
        },
      ],
    },
    {
      name: `表情图标`,
      type: `expression`,
      list: [
        {
          name: `1`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1026 1024"><path d="M1.097856 1.097642h1021.804717v1021.804716H1.097856z" fill="#F09495" ></path><path d="M1024.000214 1024H0.000214V0h1024v1024z m-1021.804716-2.195284h1019.609433V2.195284H2.195498v1019.609432z" fill="#FFFFFF" ></path><path d="M234.695985 335.179887m-27.341259 0a27.341259 27.341259 0 1 0 54.682518 0 27.341259 27.341259 0 1 0-54.682518 0Z" fill="#040000" ></path><path d="M234.695985 363.519002c-15.666342 0-28.339115-12.772559-28.339115-28.339115 0-15.666342 12.772559-28.339115 28.339115-28.339115s28.339115 12.772559 28.339115 28.339115c0.099786 15.666342-12.672773 28.339115-28.339115 28.339115z m0-54.582732c-14.468914 0-26.243617 11.774703-26.243617 26.243617s11.774703 26.243617 26.243617 26.243617 26.243617-11.774703 26.243617-26.243617-11.774703-26.243617-26.243617-26.243617z" fill="#FFFFFF" ></path><path d="M776.232528 335.179887m-27.341259 0a27.341259 27.341259 0 1 0 54.682518 0 27.341259 27.341259 0 1 0-54.682518 0Z" fill="#040000" ></path><path d="M776.232528 363.519002c-15.666342 0-28.339115-12.772559-28.339115-28.339115 0-15.666342 12.772559-28.339115 28.339115-28.339115 15.666342 0 28.339115 12.772559 28.339115 28.339115 0 15.666342-12.772559 28.339115-28.339115 28.339115z m0-54.582732c-14.468914 0-26.243617 11.774703-26.243617 26.243617s11.774703 26.243617 26.243617 26.243617 26.243617-11.774703 26.243617-26.243617c-0.099786-14.468914-11.874488-26.243617-26.243617-26.243617z" fill="#FFFFFF" ></path><path d="M512.000214 671.656987c-52.58702 0-105.872539-17.961411-105.872539-52.387449S459.413194 566.882089 512.000214 566.882089s105.872539 17.961411 105.87254 52.387449S564.587234 671.656987 512.000214 671.656987z m0-74.240499c-21.952836 0-43.207172 3.592282-58.2748 9.77899-13.870201 5.68778-17.06334 11.275775-17.06334 12.07406s3.19314 6.386279 17.06334 12.07406c15.067628 6.186708 36.321965 9.77899 58.2748 9.77899s43.207172-3.592282 58.274801-9.77899c13.870201-5.68778 17.06334-11.275775 17.06334-12.07406s-3.19314-6.386279-17.06334-12.07406c-15.067628-6.286494-36.321965-9.77899-58.274801-9.77899z" fill="#040000" ></path></svg>`,
        },
        {
          name: `2`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M0 0h1024v1024H0z" fill="#E6A6C9" ></path><path d="M315.1 368.1c-23.9 0-43.3-19.4-43.3-43.3s19.4-43.3 43.3-43.3 43.3 19.4 43.3 43.3-19.4 43.3-43.3 43.3z m0-74.7c-17.3 0-31.3 14.1-31.3 31.3 0 17.3 14.1 31.3 31.3 31.3 17.3 0 31.3-14.1 31.3-31.3 0-17.2-14-31.3-31.3-31.3zM738.7 368.1c-23.9 0-43.3-19.4-43.3-43.3s19.4-43.3 43.3-43.3 43.3 19.4 43.3 43.3-19.4 43.3-43.3 43.3z m0-74.7c-17.3 0-31.3 14.1-31.3 31.3 0 17.3 14.1 31.3 31.3 31.3 17.3 0 31.3-14.1 31.3-31.3 0-17.2-14-31.3-31.3-31.3zM293.5 698.8l-14.5-1.3c0.1-0.6 1.5-14.6 15.1-27.9 17.2-16.7 45-24.8 82.7-24 4.9-0.1 10.9-10.5 16.1-19.6 8.4-14.7 19-33.1 37.9-34.3 19.4-1.2 42.2 16.4 71.5 55.4 9.9 5.2 16.5 11.2 21.8 16.1 8.4 7.7 13.1 11.9 25.1 10.8 14.9-1.4 38.9-11.1 77.5-31.4 26.8-28.4 56.4-41.4 83.5-36.6 27.9 4.9 50.6 27.6 67.5 67.5l-13.4 5.7c-14.7-34.5-34.3-54.9-56.7-58.8-22.3-3.9-47.6 7.8-71.2 33.1l-0.8 0.9-1.1 0.6c-85.6 45.1-99.4 38-120.2 19.1-5.5-5-11.2-10.2-20.1-14.7l-1.5-0.8-1-1.4c-32.2-43.2-50.4-51.6-60-51-11.1 0.7-18.8 14-26.2 27-7.6 13.2-15.4 26.9-28.8 26.9h-0.2c-78.4-1.6-83 38.3-83 38.7z" fill="#040000" ></path></svg>`,
        },
        {
          name: `3`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1026 1024" ><path d="M1.1 1.097642h1021.804716v1021.804716H1.1z" fill="#F7E983" ></path><path d="M1024.002358 1024H0.002358V0h1024v1024z m-1021.804716-2.195284h1019.609433V2.195284H2.197642v1019.609432z" fill="#FFFFFF" ></path><path d="M329.174412 344.491728a38.118106 10.277919 57.6 1 0 17.355867-11.014369 38.118106 10.277919 57.6 1 0-17.355867 11.014369Z" fill="#040000" ></path><path d="M644.769475 355.956059a11.175989 36.321965 30 1 0 36.321965-62.911488 11.175989 36.321965 30 1 0-36.321965 62.911488Z" fill="#040000" ></path><path d="M569.678445 671.158059c-26.343403 0-51.190021-5.288638-70.049503-14.967843-20.755408-10.577275-32.230754-25.445332-32.230755-41.710388 0-16.265056 11.475346-31.133112 32.230755-41.710387 18.859482-9.579419 43.805886-14.967843 70.049503-14.967843s51.190021 5.288638 70.049503 14.967843c20.755408 10.577275 32.230754 25.445332 32.230754 41.710387 0 16.265056-11.475346 31.133112-32.230754 41.710388-18.859482 9.679205-43.805886 14.967843-70.049503 14.967843z m0-95.095693c-49.693237 0-84.318846 20.356266-84.318846 38.517248s34.625609 38.517248 84.318846 38.517248 84.318846-20.356266 84.318846-38.517248-34.725395-38.517248-84.318846-38.517248z" fill="#040000" ></path></svg>`,
        },
        {
          name: `4`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1026 1024" ><path d="M1.1 1.097642h1021.804716v1021.804716H1.1z" fill="#A6D9E2" ></path><path d="M1024.002358 1024H0.002358V0h1024v1024z m-1021.804716-2.195284h1019.609433V2.195284H2.197642v1019.609432z" fill="#FFFFFF" ></path><path d="M376.194134 348.950302m-23.44962 0a23.44962 23.44962 0 1 0 46.89924 0 23.44962 23.44962 0 1 0-46.89924 0Z" fill="#040000" ></path><path d="M629.150672 348.950302m-24.647047 0a24.647047 24.647047 0 1 0 49.294095 0 24.647047 24.647047 0 1 0-49.294095 0Z" fill="#040000" ></path><path d="M397.847613 603.503411c13.471058 8.282206 28.738258 14.468914 43.7061 19.458195 29.835899 9.978562 62.266225 14.169558 93.299551 7.483921 21.054765-4.490353 40.213604-14.369129 56.778016-28.039758 6.785422-5.587995-2.893783-15.167414-9.579419-9.579419-46.999026 38.916391-112.258819 31.033327-163.847983 6.086922-4.590138-2.195284-9.080491-4.490353-13.371272-7.184564-7.583707-4.590138-14.468914 7.184564-6.984993 11.774703z" fill="#040000" ></path><path d="M627.753674 534.052621c-31.033327 24.048334-58.474371 68.253362-37.419607 106.970182 10.577275 19.35841 29.835899 32.629897 48.795167 42.708244 7.982849 4.190996 15.067628-7.883064 7.084779-12.07406-25.245761-13.271487-53.485091-35.324108-49.094524-66.557006 2.793997-20.156695 15.766127-37.319821 29.736114-51.190022 3.392711-3.392711 6.984993-6.785422 10.776847-9.77899 2.993569-2.295069 2.394855-7.483921 0-9.878776-2.893783-3.19314-6.885208-2.49464-9.878776-0.199572z" fill="#040000" ></path></svg>`,
        },
        {
          name: `5`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1026 1024" ><path d="M1.1 1.097642h1021.804716v1021.804716H1.1z" fill="#AD6F59" ></path><path d="M1024.002358 1024H0.002358V0h1024v1024z m-1021.804716-2.195284h1019.609433V2.195284H2.197642v1019.609432z" fill="#FFFFFF" ></path><path d="M411.829832 330.730879a38.118106 10.277919 57.6 1 0 17.355867-11.014368 38.118106 10.277919 57.6 1 0-17.355867 11.014368Z" fill="#040000" ></path><path d="M480.669675 609.989476c11.774703-25.844475 27.740401-51.788735 44.60417-73.342429 13.770415-17.462483 29.237186-33.92711 47.897096-44.803742 17.262912-10.078347 35.324108-13.67063 54.283376-6.58585 11.974274 4.390567 23.948548 14.468914 33.128825 24.547261 14.369129 15.865913 25.145975 34.625609 34.725394 53.684662 4.290782 8.581563 17.262912 0.997856 12.972131-7.583707-15.167414-30.334828-35.224323-63.763009-66.157864-80.327421-21.054765-11.37556-44.504385-11.475346-66.157864-1.895927-21.054765 9.280062-38.617034 25.644904-53.485091 42.907815-14.468914 16.863769-27.041902 35.324108-38.217891 54.582733-5.887351 10.178133-11.674917 20.555837-16.464627 31.232898-1.696355 3.692068-0.997856 7.982849 2.694212 10.277918 3.19314 1.895927 8.581563 0.898071 10.178133-2.694211z" fill="#040000" ></path><path d="M663.863649 338.091735a14.468914 33.727538 30 1 0 33.727538-58.417811 14.468914 33.727538 30 1 0-33.727538 58.417811Z" fill="#040000" ></path></svg>`,
        },
        {
          name: `6`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M762.9 77.4H261.1L10.2 512l250.9 434.6h501.8L1013.8 512z" fill="#83CEE3" ></path><path d="M369 375.8m-34.6 0a34.6 34.6 0 1 0 69.2 0 34.6 34.6 0 1 0-69.2 0Z" fill="#040000" ></path><path d="M369 411.7c-19.8 0-36-16.1-36-36s16.1-36 36-36 36 16.1 36 36-16.1 36-36 36z m0-69.1c-18.3 0-33.2 14.9-33.2 33.2S350.7 409 369 409s33.2-14.9 33.2-33.2-14.9-33.2-33.2-33.2z" fill="#FFFFFF" ></path><path d="M672.2 333.6c-15.1 7.6-30.2 15.6-44.3 25-5.9 3.9-17 10.4-14.6 19.1 1.8 6.5 12 11.2 17.3 14.3 15.7 9.3 32.1 17.6 48.3 25.9 8.6 4.4 16.2-8.5 7.6-13-14.1-7.3-28.3-14.5-42.1-22.3-3.9-2.2-7.9-4.5-11.7-6.9-1.2-0.8-2.4-1.5-3.5-2.4-0.6-0.4-1.1-0.8-1.6-1.2 2.2 1.7-0.3-0.3-0.3-0.3-0.9 0.1-1.5-3.2-0.2 0.5 0.9 2.4 1.1 3.8 0.3 5.8 0.6-1.5-0.9 0.8-0.1 0 0.5-0.5 1-1.1 1.6-1.6 0.5-0.5 1-0.9 1.6-1.3 0.6-0.5 0 0 1.2-0.9 1.7-1.3 3.5-2.5 5.3-3.6 8.4-5.5 17.2-10.4 26-15.2 5.6-3 11.2-6 16.8-8.9 8.6-4.4 1-17.3-7.6-13zM578.2 720.9c-12.5-96.7-33.3-154.7-55.6-155.6-8.8 3.9-22.3 17.5-37.7 60.1-10.8 29.8-18.4 62.2-23 81.6-1.2 5.1-2.1 9.1-2.9 11.8l-9.3-2.4c0.7-2.6 1.6-6.6 2.8-11.6 14.9-63 36-136.8 67.5-148.8l0.8-0.3h0.8c18.2-0.4 33.2 19.5 45.8 60.8 10.2 33.3 16.7 74.6 20.5 103.3l-9.7 1.1z" fill="#040000" ></path></svg>`,
        },
        {
          name: `7`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M762.9 77.4H261.1L10.2 512l250.9 434.6h501.8L1013.8 512z" fill="#8CC66D" ></path><path d="M375.778679 404.47473a14.5 33.8 30 1 0 33.8-58.543317 14.5 33.8 30 1 0-33.8 58.543317Z" fill="#040000" ></path><path d="M627.220263 374.211388a43.1 11.6 57.6 1 0 19.588408-12.431182 43.1 11.6 57.6 1 0-19.588408 12.431182Z" fill="#040000" ></path><path d="M451.1 548.5c17.6-9.3 63.9-30 105.3-16.2 17 20.3 32.7 98.8 28.8 138.1-27.5 10.2-82.5 10.2-106.1 5.8-8.3-10.5-32.7-81.8-35.3-114.6-0.4-5.5 2.5-10.6 7.3-13.1z" fill="#040000" ></path></svg>`,
        },
        {
          name: `8`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M762.9 77.4H261.1L10.2 512l250.9 434.6h501.8L1013.8 512z" fill="#5A74B8" ></path><path d="M357.7 400m-34.6 0a34.6 34.6 0 1 0 69.2 0 34.6 34.6 0 1 0-69.2 0Z" fill="#040000" ></path><path d="M357.7 436c-19.8 0-36-16.1-36-36s16.1-36 36-36 36 16.1 36 36-16.2 36-36 36z m0-69.2c-18.3 0-33.2 14.9-33.2 33.2s14.9 33.2 33.2 33.2 33.2-14.9 33.2-33.2-14.9-33.2-33.2-33.2z" fill="#FFFFFF" ></path><path d="M676 400m-34.6 0a34.6 34.6 0 1 0 69.2 0 34.6 34.6 0 1 0-69.2 0Z" fill="#040000" ></path><path d="M676 436c-19.8 0-36-16.1-36-36s16.1-36 36-36 36 16.1 36 36-16.2 36-36 36z m0-69.2c-18.3 0-33.2 14.9-33.2 33.2s14.9 33.2 33.2 33.2c18.3 0 33.2-14.9 33.2-33.2s-14.9-33.2-33.2-33.2z" fill="#FFFFFF" ></path><path d="M347.6 684.1c0.3-0.9 0.6-1.7 0.9-2.6 0.2-0.5 1.4-3.2 0.3-0.8 0.6-1.4 1.3-2.9 2-4.3 3.2-6.3 6-10.7 10.9-15.3 4.3-4 10.8-7.5 17.1-6.1 3.9 0.9 7.9 4.9 11.1 7.2 3.1 2.2 6.3 4.5 9.7 6.2 7.5 3.8 15.3 4.4 23.4 1.9 4.7-1.5 9.2-3.6 13.6-5.9 5-2.6 10.7-5 14.2-9.5 4.5-5.7 6.1-8.5 11.4-14.1 1-1 2-2 3.1-3 0.2-0.2 2.2-1.7 0.6-0.5 0.6-0.4 1.2-0.9 1.8-1.3 1-0.6 2.1-1.3 3.2-1.7-2 0.8 0.2 0 0.6-0.1 2.3-0.7-0.3-0.2 1.2-0.3 2.8-0.1 3.6 0 5.5 1 3.8 1.9 6.6 4.7 9.5 7.8 4.5 5 7.5 11.1 11.7 16.2 1.8 2.2 3.7 4.3 5.4 6.5 8.1 10.3 17.7 22.2 32.2 22 8.8-0.1 16.6-5.2 22.6-11.2 4.2-4.1 7.7-8.9 11-13.7 2.9-4.2 4.6-9.9 6.2-13.5 3.2-7.1 7.2-13.1 13-18.1 4.8-4.2 11.1-6.5 16.7-5.3 10.5 2.4 17.2 12.1 23.1 20.2 4.7 6.5 9.8 13 16 18.2 7.8 6.4 17.1 11.4 27.5 11.1 14.1-0.4 25.5-9.5 34.2-19.9 3-3.6 3.6-8.8 0-12.4-3.1-3.1-9.4-3.7-12.4 0-6.3 7.6-14.7 15.9-24.9 14.7-2.2-0.3-5.3-1.5-7.9-3.1-3.5-2.1-6.1-4.4-9.1-7.5-4.9-5.1-6.8-8.1-10.9-13.8-7.3-10.1-16.1-19.6-28.2-23.7-18.5-6.3-35.7 5.6-46 20.1-2.4 3.3-4.4 6.9-6.1 10.6-1.8 3.9-2.7 8.5-5.2 11.9-3.1 4.4-6.2 8.8-10.2 12.5-3 2.8-5.7 4.4-8.6 5.1-0.4 0.1-1.7 0.1 0.1 0h-2.2c2.1 0.1 0 0-0.5-0.1-0.7-0.2-1.4-0.4-2-0.6 1.8 0.7-1.8-1.1-2.4-1.5l-1.2-0.9c1.5 1.2-0.9-0.9-1.2-1.1-4.7-4.3-8.4-9.5-12.3-14.4-10.9-13.6-20.9-34-41-34.9-14.2-0.6-24.5 10.6-32.4 20.8-1.2 1.6-2.5 3.2-3.7 4.8-1.5 1.9 1.1-1.4-0.4 0.5-0.4 0.5-0.8 1.2-1.3 1.6-1.7 1.4-4.6 2.6-6.6 3.6-2.9 1.6-5.9 3.2-9 4.5-1.6 0.7-3.4 1.2-5.1 1.7-2.2 0.6-0.7 0.5-2.8 0.4-2.8 0-3.9-0.4-6.6-1.9-3.9-2.2-7.5-4.9-11.1-7.5-5.6-4-10-6.9-17-7.5-10.5-0.9-20.3 3.2-28.2 9.9-9.4 8.1-16.4 20.2-20.1 32-3.6 11.2 13.3 15.8 16.8 5.1z" fill="#040000" ></path></svg>`,
        },
        {
          name: `9`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M762.9 77.4H261.1L10.2 512l250.9 434.6h501.8L1013.8 512z" fill="#F0884F" ></path><path d="M287.2 382c6.4 2.3 11.6-3.7 15.4-7.9 5.1-5.5 10.2-11 16-15.9 0.8-0.7 1.7-1.4 2.5-2.1 1.2-0.9-1.7 1.3 0.2-0.2l1.2-0.9c2.1-1.5 4.3-2.9 6.5-4.3 2-1.2 4-2.2 6.1-3.2 0.6-0.3 1.2-0.6 1.9-0.9-0.3 0.2-1.5 0.6 0.2-0.1 1.3-0.5 2.6-1 4-1.5 11.2-3.7 21.8-4 33.4-1.1 19.5 4.9 36.4 17 51.2 30.2 8.6 7.7 21.4-5 12.7-12.7-25.2-22.6-57.1-42.1-92.2-36.2-20.4 3.4-37.7 16.1-51.6 30.9-2.3 2.4-4.5 5-6.8 7.4-0.7 0.7-1.9 1.5-2.4 2.4-0.5 0.8 2.3-1.5 0.8-0.7 1.3-0.7 3.9-1.4 5.8-0.7-11.1-3.7-15.8 13.7-4.9 17.5zM598 382c6.4 2.3 11.6-3.7 15.4-7.9 5.1-5.5 10.2-11 16-15.9 0.8-0.7 1.7-1.4 2.5-2.1 1.2-0.9-1.7 1.3 0.2-0.2l1.2-0.9c2.1-1.5 4.3-2.9 6.5-4.3 2-1.2 4-2.2 6.1-3.2 0.6-0.3 1.2-0.6 1.9-0.9-0.3 0.2-1.5 0.6 0.2-0.1 1.3-0.5 2.6-1 4-1.5 11.2-3.7 21.8-4 33.4-1.1 19.5 4.9 36.4 17 51.2 30.2 8.6 7.7 21.4-5 12.7-12.7-25.2-22.6-57.1-42.1-92.2-36.2-20.4 3.4-37.7 16.1-51.6 30.9-2.3 2.4-4.5 5-6.8 7.4-0.7 0.7-1.9 1.5-2.4 2.4-0.5 0.8 2.3-1.5 0.8-0.7 1.3-0.7 3.9-1.4 5.8-0.7-11.1-3.7-15.8 13.7-4.9 17.5zM505.9 527.1c3.4 0.7 6.8 1.7 10.2 2.8 6.7 2.2 10.4 3.5 16.6 7.7 1.6 1.1-0.5-0.5 0.6 0.5 0.6 0.5 1.1 1.1 1.7 1.6 1.5 1.4-0.1-0.4 0.5 0.6 0.4 0.6 0.7 1.2 1 1.8-1-2 0.1 0 0 0.5 0.1-2-0.1 0-0.1 0-0.1 0.8 0 0.7 0.1-0.5-0.1 0.4-0.1 0.7-0.3 1.1-0.6 1 0.7-0.9-0.4 1-1.6 2.5-4.6 5.4-8.1 7.8-6.8 4.6-14.4 8.2-22 11.4-7 3-7.4 11.9 0 14.8 7.4 2.8 15 5.3 22.4 8.1 3.1 1.1 4.2 1.5 6.9 2.9 1.1 0.6 2.1 1.2 3.2 1.8 1.2 0.8-0.7-0.5 0.1 0 0.4 0.3 0.8 0.7 1.1 1.1 0.6 0.8-1.1-1.2-0.2-0.2 0.8 0.9-0.3-1.4-0.1-0.2 0.1 0.9 0.2-1.9 0-0.9-0.1 0.5-0.8 1.8 0 0.2-0.2 0.5-0.5 1-0.8 1.4-0.3 0.3-0.9 1.3-0.3 0.5-0.5 0.7-1.1 1.3-1.7 1.9-6.9 7.3-15.9 12.8-24.4 18.1-8.3 5.3-0.6 18.5 7.7 13.2 9.9-6.3 20.9-12.8 28.6-21.8 4.8-5.5 8.1-12.9 4.2-19.9-3.4-6-10.5-8.9-16.6-11.4-8.6-3.5-17.5-6.2-26.2-9.5v14.8c14.4-6.1 47.2-18.8 41.2-40.3-3.5-12.9-19.4-18.9-30.8-22.6-3.4-1.1-6.9-2.1-10.5-2.9-9.1-2.2-13.3 12.5-3.6 14.6z" fill="#040000" ></path></svg>`,
        },
        {
          name: `10`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M762.9 77.4H261.1L10.2 512l250.9 434.6h501.8L1013.8 512z" fill="#F6F180" ></path><path d="M342.9 400.6m-29.5 0a29.5 29.5 0 1 0 59 0 29.5 29.5 0 1 0-59 0Z" fill="#040000" ></path><path d="M342.9 431.3c-16.9 0-30.7-13.8-30.7-30.7s13.8-30.7 30.7-30.7 30.7 13.8 30.7 30.7-13.7 30.7-30.7 30.7z m0-59c-15.6 0-28.3 12.7-28.3 28.3s12.7 28.3 28.3 28.3 28.3-12.7 28.3-28.3-12.6-28.3-28.3-28.3z" fill="#FFFFFF" ></path><path d="M702 400.6m-29.5 0a29.5 29.5 0 1 0 59 0 29.5 29.5 0 1 0-59 0Z" fill="#040000" ></path><path d="M702 431.3c-16.9 0-30.7-13.8-30.7-30.7s13.8-30.7 30.7-30.7 30.7 13.8 30.7 30.7-13.8 30.7-30.7 30.7z m0-59c-15.6 0-28.3 12.7-28.3 28.3s12.7 28.3 28.3 28.3 28.3-12.7 28.3-28.3-12.7-28.3-28.3-28.3z" fill="#FFFFFF" ></path><path d="M358.7 519.9c20 22 45.5 40.4 71.3 54.8 51.2 28.5 111.7 39.9 168 19.5 44.3-16.1 80.7-47.8 110.2-83.9 3-3.7 3.6-8.9 0-12.5-3.1-3.1-9.5-3.7-12.5 0-25.5 31.4-56.2 59.7-93.7 76-27.1 11.7-56.6 15.7-85.8 12.2-24.7-2.9-49.5-11.8-71.5-23.4-18.7-9.8-36.6-22.2-51.1-34.3-7.8-6.5-15.5-13.3-22.4-20.9-7.7-8.5-20.1 4.1-12.5 12.5z" ></path></svg>`,
        },
        {
          name: `11`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M48.2 844.9c-68.5-210.6 186-782.1 409.1-795.4 6.3-0.4 12.5 0.2 18.6 1.6C665.1 94.6 985.4 515 987.1 821.3c0.1 20-12.9 37.9-22.4 43.1-162.7 89.8-605.8 179.7-884.4 30.9-15-7.9-24.2-26.1-32.1-50.4z" fill="#F0884F" ></path><path d="M401 352.1m-52.4 0a52.4 52.4 0 1 0 104.8 0 52.4 52.4 0 1 0-104.8 0Z" fill="#FFFFFF" ></path><path d="M408.7 329m-29.3 0a29.3 29.3 0 1 0 58.6 0 29.3 29.3 0 1 0-58.6 0Z" fill="#040000" ></path><path d="M527.5 352.1m-52.4 0a52.4 52.4 0 1 0 104.8 0 52.4 52.4 0 1 0-104.8 0Z" fill="#FFFFFF" ></path><path d="M527.5 329m-29.3 0a29.3 29.3 0 1 0 58.6 0 29.3 29.3 0 1 0-58.6 0Z" fill="#040000" ></path><path d="M450.7 517c1.1-8.2 3.2-16.4 6.1-24.1 0.1-0.3 1-2.5 0.5-1.4s0.3-0.7 0.5-1c0.7-1.4 1.4-2.8 2.2-4.1 0.4-0.8 2.8-3.9 1.3-2.1 0.8-1 1.7-1.9 2.6-2.8 1-1-1.5 1 0.1 0 0.5-0.3 1-0.6 1.5-0.8-1.3 0.7-1.2 0.3 0 0.1 1.9-0.3-1.8 0.3 0.1 0 1.2-0.2 1.5 0.3 0-0.1 0.6 0.2 1.3 0.3 1.9 0.5 0.3 0.1-1.3-0.7 0.2 0.1 0.8 0.5 1.6 0.9 2.4 1.4 1.4 1 0-0.1 1.4 1.1 0.9 0.8 1.8 1.7 2.6 2.6 1.8 1.9 3.5 3.9 5 6.1 5.1 7.1 9.3 14.8 13.2 22.6 3.5 6.9 13.7 4.7 15.8-2.1 2.6-8.7 4.8-17.4 7.4-26.1 0.9-3.2 1.9-6.4 3.2-9.4-0.7 1.6 0.8-1.6 1.2-2.2l0.9-1.5c0.7-1.2-1.4 0.7 0.1-0.1 1.7-0.9-1.2 0.3-0.3 0.1 0.8-0.2 1-1.2 0.3-0.3-0.6 0.8 0.6 0-0.5 0.2-2 0.3 2.4 0.5-1.1 0 0.5 0.1 1.2 0.2 1.6 0.4-1.1-0.8-0.8-0.4 0.2 0.2 0.7 0.4 3.4 2.3 2.7 1.8 8.9 7.1 15.9 16.9 22.5 26 2.8 3.8 7.5 5.6 11.8 3.1 3.7-2.2 5.9-8 3.1-11.8-8.2-11.1-16.6-23-27.7-31.4-6.3-4.7-14.5-7.6-21.7-3-6.7 4.2-9.6 12.5-11.9 19.6-3.2 9.9-5.5 20-8.6 29.9 5.3-0.7 10.5-1.4 15.8-2.1-7.8-15.5-24.8-50.1-48-41.7-14.1 5.1-19.7 23-22.9 36.2-0.9 3.8-1.8 7.7-2.3 11.6-0.6 4.6 1.1 9.3 6 10.6 4.2 1 10.2-1.5 10.8-6.1z" fill="#040000" ></path></svg>`,
        },
        {
          name: `12`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M485.538528 993.072489a362.00362 481.804818 3.149 1 0 52.933731-962.15464 362.00362 481.804818 3.149 1 0-52.933731 962.15464Z" fill="#AADCF0" ></path><path d="M688.2 334.1c-15.1 7.6-30.2 15.6-44.3 25-5.9 3.9-17 10.4-14.6 19.1 1.8 6.5 12 11.2 17.3 14.3 15.7 9.3 32.1 17.6 48.3 25.9 8.6 4.4 16.2-8.5 7.6-13-14.1-7.3-28.3-14.5-42.1-22.3-3.9-2.2-7.9-4.5-11.7-6.9-1.2-0.8-2.4-1.5-3.5-2.4-0.6-0.4-1.1-0.8-1.6-1.2 2.2 1.7-0.3-0.3-0.3-0.3-0.9 0.1-1.5-3.2-0.2 0.5 0.9 2.4 1.1 3.8 0.3 5.8 0.6-1.5-0.9 0.8-0.1 0 0.5-0.5 1-1.1 1.6-1.6 0.5-0.5 1-0.9 1.6-1.3 0.6-0.5 0 0 1.2-0.9 1.7-1.3 3.5-2.5 5.3-3.6 8.4-5.5 17.2-10.4 26-15.2 5.6-3 11.2-6 16.8-8.9 8.6-4.4 1-17.4-7.6-13zM375.8 347c13.4 6.8 26.7 14 39.5 21.9 1.8 1.2 3.7 2.3 5.5 3.5 0.9 0.6 1.7 1.2 2.6 1.8 0.9 0.6 1.9 1.4 1.6 1.1 1.1 0.9 2.1 1.9 3.1 2.8 1.2 1 0-0.3 0.1 0 0-0.2-0.8-2.4-0.3-4.1 1.5-5.5 2.3-2.7 0.8-2-0.4 0.2-0.9 0.8-1.3 1.1 1.7-1.4-1.6 1.1-2.3 1.6-3.4 2.3-6.9 4.4-10.4 6.4-14.9 8.6-30.3 16.4-45.6 24.3-8.6 4.4-1 17.4 7.6 13 15-7.7 30.1-15.4 44.8-23.8 6.2-3.6 13.8-7.3 18.7-12.7 7.6-8.3-3.8-16.6-9.9-20.9-8.7-6.1-18-11.3-27.3-16.4-6.5-3.6-13-7.1-19.6-10.4-8.6-4.5-16.3 8.5-7.6 12.8zM412.8 570.9c13.5 7.7 28.5 13.3 43.3 17.9 29.8 9.2 61.7 13.1 92.6 7.3 20.6-3.9 40-12.5 56.6-25.2 2.8-2.2 4.3-5.6 2.3-9-1.6-2.8-6.2-4.5-9-2.3-48.3 36.9-113.3 30-165.6 6.7-4.6-2.1-9.2-4.2-13.7-6.7-7.3-4.2-13.9 7.2-6.5 11.3z" fill="#040000" ></path><path d="M644.6 505.2c-30.1 21.5-60.6 62.5-39.1 99.8 10.7 18.6 30.3 30.9 49.1 40.1 7.8 3.8 14.6-7.9 6.8-11.7-23.6-11.5-53.7-31.4-49.4-60.9 2.8-18.9 15.8-34.6 29.5-47.2 2.5-2.3 5.1-4.6 7.8-6.7 0.5-0.4 0.9-0.7 1.4-1.1-0.4 0.3-1.2 0.9-0.1 0.1l0.9-0.6c6.9-5.1 0.2-16.8-6.9-11.8z" fill="#040000" ></path></svg>`,
        },
        {
          name: `13`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M235.1 76.9c75.6-26.5 297.3-90.1 514.2-16.6 16.3 5.5 29.8 17.4 37.1 33 57.5 122.4 127.1 602.1 62.1 785.6a62.58 62.58 0 0 1-32.5 35.8c-109.5 51.8-428.1 136.7-609.3 37.2-14.4-7.9-25-21.3-29.7-37.1-41.9-140.6-37-627.7 19.1-798 6.1-18.7 20.5-33.4 39-39.9z" fill="#F9DABD" ></path><path d="M392.2 360.2m-35.2 0a35.2 35.2 0 1 0 70.4 0 35.2 35.2 0 1 0-70.4 0Z" fill="#040000" ></path><path d="M618.6 360.2m-35.2 0a35.2 35.2 0 1 0 70.4 0 35.2 35.2 0 1 0-70.4 0Z" fill="#040000" ></path><path d="M512 562.6c-36 0-65.3-29.3-65.3-65.3S476 432 512 432s65.3 29.3 65.3 65.3-29.3 65.3-65.3 65.3z m0-122.9c-31.7 0-57.6 25.8-57.6 57.6s25.8 57.6 57.6 57.6c31.7 0 57.6-25.8 57.6-57.6s-25.9-57.6-57.6-57.6z" fill="#040000" ></path></svg>`,
        },
        {
          name: `14`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M178.1 971.5c38.1 15.9 98.7 26.6 171.3-12.3 3.7-2 8.4-1.6 11.6 1.1 43.3 35.9 123.3 80.8 236 10.9 3.8-2.4 8.7-2.4 12.6-0.2 41.8 23.9 191.6 58.2 246.6 14.2 4.4-3.5 9.1-6.6 14.5-8.5C1065 909.5 678.2-652 194.3 351c-37.5 77.8-38.4 94.1-71.9 211.3-27.6 96.3-29.1 231.3 1.4 348.1 7.2 27.3 27.3 49.9 54.3 61.1z" fill="#ABAAAA" ></path><path d="M468.9 349H418c-6.1 0-11.1-5-11.1-11.1V336c0-6.1 5-11.1 11.1-11.1h50.9c6.1 0 11.1 5 11.1 11.1v1.9c0 6.1-5 11.1-11.1 11.1zM643 471.9H390c-6.6 0-12-5.4-12-12s5.4-12 12-12h253c6.6 0 12 5.4 12 12s-5.4 12-12 12zM609 349h-61.2c-6 0-11-4.9-11-11v-2.1c0-6 4.9-11 11-11H609c6 0 11 4.9 11 11v2.1c0 6.1-4.9 11-11 11z" fill="#040000" ></path></svg>`,
        },
        {
          name: `15`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M673.1 318.7c3.7-17.5 5.6-35.7 5.6-54.4 0-137.9-105.5-249.7-235.6-249.7S207.4 126.4 207.4 264.3c0 55.4 17.1 106.7 45.9 148.1-55.2 63.3-88.6 145.9-88.6 236.3 0 199.2 162.1 360.6 362.1 360.6 200 0 362.1-161.5 362.1-360.6 0.1-147.3-88.7-274-215.8-330z" fill="#4F8A54" ></path><path d="M392 246.2m-47.1 0a47.1 47.1 0 1 0 94.2 0 47.1 47.1 0 1 0-94.2 0Z" fill="#FFFFFF" ></path><path d="M386 252.8m-26.4 0a26.4 26.4 0 1 0 52.8 0 26.4 26.4 0 1 0-52.8 0Z" fill="#040000" ></path><path d="M505.6 246.2m-47.1 0a47.1 47.1 0 1 0 94.2 0 47.1 47.1 0 1 0-94.2 0Z" fill="#FFFFFF" ></path><path d="M501.4 252.8m-26.4 0a26.4 26.4 0 1 0 52.8 0 26.4 26.4 0 1 0-52.8 0Z" fill="#040000" ></path><path d="M474.3 364.8h-50.9c-6.1 0-11.1-5-11.1-11.1v-1.9c0-6.1 5-11.1 11.1-11.1h50.9c6.1 0 11.1 5 11.1 11.1v1.9c0 6.2-5 11.1-11.1 11.1z" fill="#040000" ></path></svg>`,
        },
        {
          name: `16`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M246.4 227.6c-166.9 101.1-461.9 344 87 564.1 1.5 0.6 2.9 1.1 4.4 1.6 80.7 27.7 392.8 165.4 641-198.1 40-58.6 38.5-136.2-3.7-193.3C892 289.5 727 201.1 429.1 182.7c-64.1-4-127.8 11.6-182.7 44.9z" fill="#CF92BE" ></path><path d="M617.1 393.4c-17.4 8.8-34.9 18.1-51.2 28.9-6.9 4.6-20.3 12.3-17.4 22.6 1.2 4.3 5.6 7 9 9.5 3.7 2.7 7.6 5 11.5 7.3 18.2 10.8 37.1 20.3 55.9 30 10 5.1 18.9-10 8.8-15.1-16.4-8.4-32.9-16.9-49-26-4.5-2.6-9.1-5.2-13.5-8l-4.5-3c-0.7-0.5-1.3-1-2-1.5 1.6 1.2 0.7 0.4-0.2-0.2-1.3-0.9-0.3-0.9-0.5-0.3 0.2 0.2 0.4 0.5 0.6 0.7 1 1.9 1.3 3.7 0.8 5.7 0.1-0.6 0.7-1.4-0.6 1.3 0.7-1.5-0.1 0-0.2 0.1 0.6-0.6 1.2-1.3 1.9-1.9l1.8-1.5c1.8-1.6-0.6 0.3 1.2-0.9 2-1.5 4.1-2.9 6.2-4.3 10-6.5 20.4-12.4 30.9-18 6.5-3.5 13.1-7 19.7-10.4 9.6-5 0.8-20.1-9.2-15zM323.1 408.5c15.9 8.1 31.7 16.5 46.8 26 2.2 1.4 4.3 2.8 6.5 4.2 1 0.7 1.9 1.3 2.8 2 0.5 0.3 1 0.7 1.4 1.1-1.1-0.9-0.3-0.3 0.3 0.3 1.1 1 2.2 2.2 3.3 3.1 1.4 1.1-1-1.7-0.1-0.1-0.6-1.1-0.9-4.1 0.3-6.7 2.2-4.8 0.7 0.1 0-0.5 0 0-1.1 0.9-1.3 1 2.3-1.9 0 0-0.5 0.4-0.8 0.5-1.5 1.1-2.3 1.6-4 2.7-8.1 5.1-12.3 7.5-17.3 10-35.1 19.1-52.8 28.2-10 5.1-1.2 20.2 8.8 15.1 17.5-9 35-17.9 52-27.7 7.3-4.2 15.9-8.6 21.8-14.7 9.3-9.7-4.3-19.7-11.5-24.7-10.1-7.1-20.9-13.1-31.7-19-7.6-4.2-15.2-8.2-22.9-12.1-9.7-5.2-18.6 9.9-8.6 15zM513 592.1c-12.2 0-24.6-1.4-36.3-4.3-8-2-13.9-8.2-15.4-16.2s1.7-15.8 8.4-20.5c23.2-16.3 60.5-31.9 106.2-13 6.4 2.6 11 8.3 12.3 15.1 1.3 6.7-0.8 13.6-5.7 18.3-13.5 13.1-40.9 20.6-69.5 20.6z m-37.4-32.5c-3.4 2.4-4.9 6.2-4.2 10.2 0.8 4.1 3.6 7.1 7.7 8.1 39.1 9.7 81.2 0.7 96.1-13.7 2.4-2.3 3.4-5.6 2.7-8.9-0.7-3.4-2.9-6.2-6.1-7.5-41.2-17.2-75.1-3.1-96.2 11.8z" fill="#040000" ></path></svg>`,
        },
        {
          name: `17`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M1008.6 465.7c0-124.9-95.5-226.2-213.4-226.2-12 0-23.8 1.1-35.2 3.1v-3.1c0-124.9-95.5-226.2-213.4-226.2S333.4 114.6 333.4 239.5c0 2.4 0 4.8 0.1 7.2-17.1-4.7-35-7.2-53.4-7.2-117.8 0-213.4 101.3-213.4 226.2 0 92.1 51.9 171.3 126.3 206.6-13.7 29.9-21.4 63.4-21.4 98.8 0 124.9 95.5 226.2 213.4 226.2 68.8 0 130-34.5 169-88.1 39 53.6 100.2 88.1 169 88.1 117.8 0 213.4-101.3 213.4-226.2 0-41.2-10.4-79.9-28.6-113.1 60.5-39.9 100.8-111.1 100.8-192.3z" fill="#8CC66D" ></path><path d="M437.8 400.7m-24.7 0a24.7 24.7 0 1 0 49.4 0 24.7 24.7 0 1 0-49.4 0Z" fill="#040000" ></path><path d="M649.7 400.7m-24.7 0a24.7 24.7 0 1 0 49.4 0 24.7 24.7 0 1 0-49.4 0Z" fill="#040000" ></path><path d="M527.3 625.9c6.3-14.2 13.1-28.3 17.9-43 6.2-19 8.3-38.6 10.5-58.3l2.1-19.2c0.7-6.2-9-6.1-9.7 0-1.7 16.3-2.8 32.8-5.7 48.9-4.2 23.7-13.8 45-23.5 66.7-2.5 5.6 5.9 10.5 8.4 4.9z" fill="#252525" ></path><path d="M447.7 522.3c20.3-0.1 40.6-0.2 61-0.4l96.6-0.6c7.5 0 14.9-0.1 22.4-0.1 16.6-0.1 16.7-25.9 0-25.8-20.3 0.1-40.6 0.2-61 0.4l-96.6 0.6c-7.5 0-14.9 0.1-22.4 0.1-16.6 0.1-16.7 25.9 0 25.8z" fill="#040000" ></path><path d="M495.4 508.2c-10.3 3.8-9.2 20.9-9.2 29.5 0.1 16 2.1 32.3 6.1 47.8 3.5 13.7 8.7 29.9 20.6 38.7 12.9 9.5 27.6 2.1 37.6-7.9 10.2-10.3 17.8-23 24.7-35.6 11.6-21.3 20.9-43.8 29.7-66.4 3-7.8-9.5-11.1-12.5-3.4-7.4 19.1-15.3 38.1-24.7 56.4-5.9 11.5-12.2 23-20.3 33.1-2.8 3.5-5.8 6.9-9.2 9.8-1.9 1.7-1.4 1.3-3.3 2.5-1.3 0.8-2.6 1.6-3.9 2.2-0.7 0.3 1-0.2-0.8 0.3-0.6 0.2-1.2 0.3-1.8 0.5-1.1 0.3-1.2 0.2-0.5 0.1-0.6 0-1.3 0-1.9 0.1-2.2 0.1 0.6 0.5-1.8-0.2l-1.8-0.6c1.5 0.5 0.2 0.1-0.5-0.3-0.8-0.5-2.9-2.1-1.7-1.1-1-0.9-2-1.7-2.8-2.7-0.4-0.5-0.9-1-1.3-1.5 0.4 0.5 0.1 0.2-0.5-0.7-0.8-1.3-1.7-2.5-2.4-3.9-0.7-1.3-1.4-2.5-2-3.8-0.4-0.8-0.8-1.6-1.1-2.4-0.1-0.2-0.5-1.1 0 0l-0.6-1.5a86.8 86.8 0 0 1-3.3-9.8c-4.4-14.9-6.2-27.9-6.8-42.8-0.3-6.6-0.3-13.1 0.4-19.7 0.2-1.5-0.3 1.5 0.1-0.5l0.3-1.8c0.2-0.9 0.5-1.8 0.7-2.8 0.4-1.9-0.7 1.1 0.3-0.7 0.5-1-1.3 1.2-0.3 0.5-0.3 0.3-1.1 0.8-2 1.1 7.7-2.9 4.3-15.4-3.5-12.5z" fill="#040000" ></path></svg>`,
        },
        {
          name: `18`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M75.4 739.8c-78.7-134.4-194-455.7 401.4-579.6 9.8-2 19.2-6.2 29.2-7.5C656.8 133 947.3 205 1000.1 578.4c42.6 223.8 29.7 392.1-822 233.6-43.1-8-80.6-34.4-102.7-72.2z" fill="#F09495" ></path><path d="M704.6 875.4c-129 0-301.8-20.5-526.6-62.3-43.5-8.1-81.2-34.6-103.5-72.7-19.3-32.9-44.8-84.3-57.1-142.5-13.9-65.1-8.8-125.3 15.1-179.2 54.3-122.3 203.7-209.6 444-259.6 4.1-0.9 8.3-2.1 12.3-3.4 5.5-1.7 11.1-3.4 16.9-4.2 29-3.8 75.7-5.9 133.8 5.7 54.5 10.9 105.3 31 150.8 59.9C843.7 251 888.2 296 922.7 351c39.7 63.1 66.1 139.6 78.5 227.3 8.1 42.4 15.2 87.3 12.5 127.9-2.8 42.6-16.4 75.5-41.5 100.7-42.5 42.7-120.3 65-237.8 68.1-9.6 0.2-19.6 0.4-29.8 0.4zM76.3 739.3c22 37.6 59.2 63.7 102.1 71.7 242.5 45.1 424.4 65.3 556.1 61.9 116.9-3.1 194.1-25.2 236.3-67.5 55.4-55.6 44.4-142.5 28.3-226.7C976 415.8 903.4 291.5 789.2 219c-124-78.7-248.1-69.9-283.2-65.3-5.6 0.7-11.2 2.4-16.6 4.1-4.1 1.2-8.3 2.5-12.5 3.4C237.3 211.1 88.5 298 34.5 419.6c-54.6 122.8 2.8 253 41.8 319.7z" fill="#FFFFFF" ></path><path d="M424.1 442.5m-24.7 0a24.7 24.7 0 1 0 49.4 0 24.7 24.7 0 1 0-49.4 0Z" fill="#040000" ></path><path d="M635.9 442.5m-24.7 0a24.7 24.7 0 1 0 49.4 0 24.7 24.7 0 1 0-49.4 0Z" fill="#040000" ></path><path d="M426.2 543.3c17.1 7.9 36.6 26 25.5 46.1-6.9 12.5-19.8 21.2-31.7 28.4-4.5 2.7-0.4 9.8 4.1 7.1 17.4-10.5 41.6-27.6 39-51.1-1.6-14-12.4-24.8-23.5-32.3-3-2-6.1-3.9-9.3-5.4-4.8-2.1-8.9 5-4.1 7.2zM629.5 535.4c-21.8 11.7-40.6 37-25.7 61.3 8.2 13.4 22.2 22.7 35.7 30.3 4.7 2.7 8.9-4.6 4.2-7.2-15.5-8.7-39.9-23.9-36.9-45.2 1.6-11.4 10.7-20.7 19.6-27.2 2.4-1.7 4.8-3.4 7.4-4.8 4.7-2.5 0.4-9.8-4.3-7.2z" fill="#040000" ></path><path d="M457.2 584.6c25.6 25.6 66.7 41 101.8 28.3 18.2-6.6 33.2-19.1 45.5-33.8 4.2-5.1-3-12.4-7.3-7.3-18.5 22-43.3 38.1-73 35-18.6-1.9-36.2-10.8-50.9-22-2.9-2.2-6.1-4.8-8.8-7.5-4.7-4.7-12 2.6-7.3 7.3z" fill="#040000" ></path></svg>`,
        },
        {
          name: `19`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M915.9 510.5c8.4-19 13.1-39.8 13.1-61.7 0-90-78.9-162.9-176.2-162.9-3.2 0-6.3 0.1-9.5 0.2v-0.2c0-94.8-116.2-171.6-259.6-171.6S224 191.2 224 286v2c-96.2 0-174.1 72-174.1 160.9 0 38 14.3 73 38.2 100.5-41.8 29.4-68.8 75.9-68.8 128.2 0 88.9 78 160.9 174.1 160.9 17.1 0 33.6-2.3 49.3-6.5 28.9 46.1 88.7 77.7 157.6 77.7 49.4 0 94-16.2 126-42.3 32 26.1 76.6 42.3 126 42.3 77.3 0 143-39.7 166.7-95 3.1 0.2 6.3 0.2 9.5 0.2 97.3 0 176.2-72.9 176.2-162.9 0-60.6-35.7-113.4-88.8-141.5z" fill="#5A74B8" ></path><path d="M357.6 449.5a46.6 73.2 0 1 0 93.2 0 46.6 73.2 0 1 0-93.2 0Z" fill="#FEFEFD" ></path><path d="M357.5 449.5a25.1 39.4 0 1 0 50.2 0 25.1 39.4 0 1 0-50.2 0Z" fill="#040000" ></path><path d="M531.3 449.5a46.6 73.2 0 1 0 93.2 0 46.6 73.2 0 1 0-93.2 0Z" fill="#FEFEFD" ></path><path d="M531.2 449.5a25.1 39.4 0 1 0 50.2 0 25.1 39.4 0 1 0-50.2 0Z" fill="#040000" ></path><path d="M426.7 574.6c20.9 29.9 59.7 52.2 96.2 38.6 19.2-7.2 34.7-21.2 47.6-36.9 2.8-3.5 3.4-8.3 0-11.7-2.9-2.9-8.9-3.5-11.7 0-16.5 20.2-40.9 40.9-68.1 35.5-17.3-3.4-31-13.2-42.9-25.9-2-2.2-3.9-4.4-5.8-6.7-1.6-1.9 1.1 1.5-0.4-0.6-0.2-0.2-0.3-0.5-0.5-0.7-6.2-8.7-20.6-0.4-14.4 8.4z" fill="#040000" ></path></svg>`,
        },
        {
          name: `20`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024" ><path d="M792.8 301.4c-8.2 0-16.2 0.4-24.2 1.3-12.3-81.8-129.2-145.9-271.8-145.9-137.1 0-250.5 59.3-269.9 136.6C105.3 295.5 7.4 391.2 7.4 508.9c0 119.1 100.2 215.6 223.7 215.6 5.3 0 10.6-0.2 15.8-0.5 14.4 80.5 130.4 143.2 271.3 143.2 135.9 0 248.6-58.3 269.4-134.6 1.7 0 3.4 0.1 5.1 0.1 123.6 0 223.7-96.5 223.7-215.6s-100-215.7-223.6-215.7z" fill="#F6CD50" ></path><path d="M435.9 431.5m-52.2 0a52.2 52.2 0 1 0 104.4 0 52.2 52.2 0 1 0-104.4 0Z" fill="#FAFAFA" ></path><path d="M588.1 431.5m-52.2 0a52.2 52.2 0 1 0 104.4 0 52.2 52.2 0 1 0-104.4 0Z" fill="#FAFAFA" ></path><path d="M435.9 431.5m-27.8 0a27.8 27.8 0 1 0 55.6 0 27.8 27.8 0 1 0-55.6 0Z" fill="#040000" ></path><path d="M601.9 407.4c-5.7 2.9-11.3 5.9-16.9 9-6.8 3.8-15.3 7.8-20.5 13.8-5.6 6.5 1.6 11.1 6.7 14.4 11.2 7.1 23.3 13 35.1 19 5.7 2.9 10.8-5.7 5.1-8.6-10.9-5.6-21.9-11.1-32.4-17.4-2.4-1.4-4.6-3.1-7-4.6 1 0.6-0.4-0.4-0.4-0.4-1.9-0.3-0.5 4.2 0.5 4.1-0.1 0-0.6 0.3 0.3-0.3 0.5-0.3 1-0.9 1.5-1.3 9.7-7.9 21.9-13.5 33.1-19.2 5.7-2.7 0.6-11.4-5.1-8.5zM406.6 547.6c11.5 14.4 27 26.7 42.7 36.3 32.2 19.8 71.2 27.2 107.6 15.4 29.5-9.6 54.6-29.1 75.5-51.6 10.8-11.6-6.6-29.1-17.5-17.5-9.4 10.1-19.5 19.7-30.8 27.7-4.6 3.2-9.3 6.2-14.2 8.9-5 2.8-9.9 5.1-14.1 6.7-4.6 1.7-9.3 3.2-14.1 4.4-2.2 0.5-4.4 1-6.6 1.4-1 0.2-2 0.3-2.9 0.5 2.6-0.4-2.1 0.2-2.5 0.3-4.1 0.4-8.3 0.5-12.5 0.4-2.2-0.1-4.4-0.2-6.6-0.4-1.1-0.1-2.2-0.2-3.2-0.3-1.5-0.2-1.4-0.2 0.1 0l-2.1-0.3c-7.8-1.3-15.4-3.4-22.8-6.2-0.9-0.4-1.8-0.7-2.8-1.1-3.1-1.2 2.3 1.1-0.7-0.3-1.5-0.7-2.9-1.3-4.4-2-3.7-1.8-7.2-3.7-10.8-5.8-5.7-3.4-11.1-7.1-16.4-11.1 3 2.3-1.1-0.9-1.8-1.5-1.1-0.9-2.1-1.7-3.1-2.6-2.1-1.8-4.2-3.7-6.3-5.6-4.4-4.1-8.7-8.4-12.4-13.1-4.2-5.2-13.1-4.3-17.5 0-5 5.1-4 12.2 0.2 17.4z" fill="#040000" ></path></svg>`,
        },
      ],
    },
    {
      name: `标记图标`,
      type: `sign`,
      list: [
        {
          name: `1`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M809.728 429.696a18.901333 18.901333 0 0 0-15.274667-12.885333l-183.466666-26.624-81.92-166.272a18.901333 18.901333 0 0 0-34.005334 0l-81.92 166.272-183.594666 26.624a19.029333 19.029333 0 0 0-10.496 32.298666l132.693333 129.536-31.274667 182.741334a18.816 18.816 0 0 0 27.477334 19.84l164.138666-86.186667 164.096 86.058667a18.773333 18.773333 0 1 0 27.434667-19.84l-31.36-182.741334 132.693333-129.408a18.901333 18.901333 0 0 0 4.778667-19.413333z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `2`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M644.565333 306.901333c32.128 0 65.834667-5.76 101.077334-17.237333a17.066667 17.066667 0 0 1 22.357333 16.213333v328.32c-1.109333 0.768 10.325333 27.093333-99.370667 19.84-109.653333-7.210667-181.76-45.098667-246.869333-45.098666-65.152 0-49.322667 2.688-74.154667 8.405333v168.064a24.746667 24.746667 0 0 1-24.490666 25.258667 22.528 22.528 0 0 1-17.28-7.253334 24.149333 24.149333 0 0 1-7.168-18.005333V281.258667C299.776 280.490667 328.106667 256 421.76 256s164.437333 50.901333 222.805333 50.901333z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `3`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M524.074667 225.408l274.517333 274.517333a17.066667 17.066667 0 0 1 0 24.149334l-274.517333 274.517333a17.066667 17.066667 0 0 1-24.149334 0l-274.517333-274.517333a17.066667 17.066667 0 0 1 0-24.149334l274.517333-274.517333a17.066667 17.066667 0 0 1 24.149334 0z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `4`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M317.866667 300.8h388.266666c9.386667 0 17.066667 7.68 17.066667 17.066667v388.266666a17.066667 17.066667 0 0 1-17.066667 17.066667h-388.266666a17.066667 17.066667 0 0 1-17.066667-17.066667v-388.266666c0-9.386667 7.68-17.066667 17.066667-17.066667z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `5`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M498.346667 279.082667L248.789333 701.44a15.829333 15.829333 0 0 0 13.653334 23.893333h499.114666a15.829333 15.829333 0 0 0 13.653334-23.893333l-249.6-422.357333a15.829333 15.829333 0 0 0-27.264 0z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `6`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M497.749333 798.549333l-31.445333-28.501333C313.941333 631.722667 213.333333 540.501333 213.333333 428.8a160.981333 160.981333 0 0 1 162.730667-162.730667c51.498667 0 100.906667 23.978667 133.12 61.696a177.536 177.536 0 0 1 133.162667-61.696 160.981333 160.981333 0 0 1 162.730666 162.730667c0 111.701333-100.608 202.965333-252.970666 341.333333l-31.445334 28.458667a17.066667 17.066667 0 0 1-22.912 0z" fill="#FFFFFF"></path><path d="M634.538667 487.808L555.050667 426.24 507.306667 256a201.002667 201.002667 0 0 0-23.594667 20.394667l-0.256-0.256L525.653333 426.666667l-133.290666 59.946666a14.08 14.08 0 0 0-8.021334 15.957334l28.757334 126.378666a14.208 14.208 0 0 0 27.733333-6.229333l-26.24-115.114667 126.037333-56.704 76.416 59.136a14.250667 14.250667 0 0 0 19.968-2.474666 14.08 14.08 0 0 0-2.474666-19.797334z" fill="#6D768D"></path></svg>`,
        },
        {
          name: `7`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M497.749333 798.549333l-31.445333-28.501333C313.941333 631.722667 213.333333 540.501333 213.333333 428.8a160.981333 160.981333 0 0 1 162.730667-162.730667c51.498667 0 100.906667 23.978667 133.12 61.696a177.536 177.536 0 0 1 133.162667-61.696 160.981333 160.981333 0 0 1 162.730666 162.730667c0 111.701333-100.608 202.965333-252.970666 341.333333l-31.445334 28.458667a17.066667 17.066667 0 0 1-22.912 0z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `8`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M374.656 273.194667c5.973333 4.48 12.117333 9.6 18.346667 15.36 6.272 5.717333 11.904 12.373333 16.896 19.84 2.517333 4.010667 5.504 8.490667 9.002666 13.482666a529.493333 529.493333 0 0 1 20.266667 32.213334h155.221333a169.813333 169.813333 0 0 0 9.770667-15.744c2.474667-4.48 5.248-8.96 8.234667-13.482667a460.842667 460.842667 0 0 1 23.253333-31.829333c4.992-6.229333 12.245333-12.373333 21.76-18.346667a34.261333 34.261333 0 0 0 10.112-9.728 31.274667 31.274667 0 0 0 5.248-11.989333 18.56 18.56 0 0 0-1.536-11.605334 17.664 17.664 0 0 0-10.112-8.618666c-4.48-1.493333-8.362667-2.005333-11.605333-1.493334a46.933333 46.933333 0 0 0-9.770667 2.602667c-3.242667 1.28-6.613333 2.645333-10.112 4.138667a32.426667 32.426667 0 0 1-12.757333 2.261333 26.026667 26.026667 0 0 1-12.373334-2.645333 45.653333 45.653333 0 0 1-8.96-6.357334l-8.661333-7.850666a30.336 30.336 0 0 0-11.989333-6.4c-9.984-3.968-18.005333-4.693333-24.021334-2.218667-5.973333 2.474667-11.946667 6.485333-17.962666 11.946667a88.618667 88.618667 0 0 1-11.989334 10.496 7.338667 7.338667 0 0 1-3.754666 1.493333 46.165333 46.165333 0 0 1-8.277334-5.205333 71.808 71.808 0 0 1-7.125333-4.906667 37.973333 37.973333 0 0 1-6.4-6.357333c-3.968-3.968-9.941333-6.613333-17.92-7.850667a31.061333 31.061333 0 0 0-21.76 4.138667c-8.533333 5.461333-14.506667 10.069333-18.048 13.824a29.354667 29.354667 0 0 1-15.744 7.893333 23.978667 23.978667 0 0 1-13.098667-0.768 987.733333 987.733333 0 0 0-14.634666-4.48 80.725333 80.725333 0 0 0-14.250667-2.986667 16.768 16.768 0 0 0-11.989333 2.986667c-6.997333 5.461333-9.258667 12.074667-6.741334 19.84a34.56 34.56 0 0 0 13.482667 18.346667z" fill="#FFFFFF"></path><path d="M780.757333 545.152a219.306667 219.306667 0 0 0-19.882666-65.536 224.981333 224.981333 0 0 0-33.365334-49.792 430.336 430.336 0 0 0-37.12-37.12c-14.506667-11.946667-27.264-23.296-38.272-34.048a544.512 544.512 0 0 1-27.733333-28.842667 305.28 305.28 0 0 1-22.485333-26.197333h-168.746667c-6.485333 8.490667-13.994667 17.493333-22.485333 26.965333a360.96 360.96 0 0 1-26.24 28.074667c-10.538667 10.24-22.272 21.12-35.285334 32.597333a305.493333 305.493333 0 0 0-41.6 44.16 250.026667 250.026667 0 0 0-49.493333 117.589334 216.106667 216.106667 0 0 0 1.877333 70.4 220.586667 220.586667 0 0 0 75.349334 126.549333c21.248 18.005333 47.146667 32.597333 77.653333 43.818667 30.464 11.264 65.493333 16.853333 104.96 16.853333 38.528 0 72.874667-4.864 103.125333-14.592a265.045333 265.045333 0 0 0 78.378667-39.338667c21.973333-16.469333 39.594667-35.797333 52.864-58.026666 13.226667-22.186667 22.101333-45.824 26.624-70.784 4.992-30.421333 5.632-58.026667 1.877333-82.773334z" fill="#FFFFFF"></path><path d="M593.322667 647.509333a20.48 20.48 0 0 1-11.861334 3.2h-50.133333v14.165334c0 4.266667-1.792 8.362667-5.376 12.373333a15.914667 15.914667 0 0 1-13.952 5.333333 24.917333 24.917333 0 0 1-14.336-3.882666c-3.84-2.602667-5.973333-7.210667-6.4-13.824v-14.165334h-48.725333a17.792 17.792 0 0 1-11.818667-3.882666 10.24 10.24 0 0 1-3.968-9.6c0-4.266667 1.578667-7.68 4.693333-10.24a16.768 16.768 0 0 1 11.093334-3.925334h48.682666v-24.789333h-48.682666a15.573333 15.573333 0 0 1-11.52-4.266667 13.525333 13.525333 0 0 1-4.266667-9.941333 15.36 15.36 0 0 1 4.693333-10.624 14.72 14.72 0 0 1 11.093334-4.949333h48.682666l0.725334-14.890667a1053.568 1053.568 0 0 1-40.832-42.538667l-10.752-9.898666a41.216 41.216 0 0 1-6.442667-11.690667c-1.92-4.992-0.938667-10.069333 2.858667-15.274667a13.653333 13.653333 0 0 1 15.786666-3.84c6.186667 2.090667 11.221333 4.821333 15.018667 8.106667 1.92 2.389333 5.248 5.888 10.026667 10.666667l15.061333 14.848 19.328 19.157333 22.186667-20.565333a987.605333 987.605333 0 0 1 29.397333-25.514667 21.162667 21.162667 0 0 1 14.293333-5.674667c5.290667 0 9.557333 2.133333 12.928 6.4 6.186667 7.082667 3.84 15.36-7.168 24.789334a179.072 179.072 0 0 0-12.885333 12.373333c-5.76 5.973333-11.52 11.733333-17.194667 17.408-6.698667 7.082667-14.08 14.378667-22.186666 21.973333v13.44h46.506666c6.698667 0 11.605333 1.536 14.72 4.608a14.165333 14.165333 0 0 1 4.650667 10.282667c0 4.266667-1.450667 7.936-4.309333 11.008-2.858667 3.029333-7.637333 4.352-14.336 3.84l-46.506667 0.768-0.768 24.064h45.866667c13.354667 0 20.053333 4.992 20.053333 14.933333 0.469333 4.693333-0.853333 8.106667-3.925333 10.24z" fill="#6D768D"></path></svg>`,
        },
        {
          name: `9`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M512 213.333333l234.666667 341.333334h-128v213.333333h-213.333334v-213.333333h-128L512 213.333333z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `10`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M533.333333 810.666667L298.666667 469.333333h128V256h213.333333v213.333333h128l-234.666667 341.333334z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `11`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M213.333333 533.333333L554.666667 298.666667v128h213.333333v213.333333h-213.333333v128l-341.333334-234.666667z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `12`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M810.666667 533.333333L469.333333 768v-128H256v-213.333333h213.333333V298.666667l341.333334 234.666666z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `13`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M0 512c0 282.752 229.248 512 512 512s512-229.248 512-512S794.752 0 512 0 0 229.248 0 512z" fill="#6D768D"></path><path d="M571.349333 508.586667l162.389334-162.346667a44.330667 44.330667 0 1 0-62.72-62.72l-162.389334 162.389333-162.517333-162.389333a44.330667 44.330667 0 1 0-62.72 62.72l162.389333 162.389333-162.389333 162.474667a44.330667 44.330667 0 1 0 62.72 62.72l162.389333-162.346667 162.389334 162.389334a44.330667 44.330667 0 1 0 62.72-62.72l-162.261334-162.56z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `14`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C233.386667 0 0 225.877333 0 512s225.877333 512 512 512 512-225.877333 512-512S790.613333 0 512 0z" fill="#6D768D"></path><path d="M726.144 311.210667l-277.333333 305.066666-124.8-124.8c-13.866667-13.866667-41.6-13.866667-55.466667 0-13.866667 13.866667-13.866667 41.6 0 55.466667l159.445333 152.533333c13.866667 13.866667 41.6 13.866667 55.466667 0l305.066667-332.8c13.866667-13.866667 13.866667-41.6 0-55.466666-20.778667-13.866667-48.512-13.866667-62.378667 0z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `15`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M541.952 755.626667a40.618667 40.618667 0 0 1-29.824 12.373333 41.344 41.344 0 0 1-30.122667-12.373333 40.106667 40.106667 0 0 1-12.672-30.122667c0-11.605333 4.096-21.845333 12.672-30.122667a40.405333 40.405333 0 0 1 30.122667-12.714666c11.605333 0 21.546667 4.138667 29.824 12.714666a40.32 40.32 0 0 1 12.714667 30.122667c0 11.861333-4.096 21.76-12.714667 30.122667zM450.986667 241.28A77.866667 77.866667 0 0 1 512.256 213.333333c24.874667 0 45.354667 8.917333 61.354667 27.946667 15.488 18.432 23.722667 41.685333 23.722666 69.674667 0 23.765333-33.152 200.533333-44.672 329.045333h-80.128C463.146667 511.402667 426.666667 334.677333 426.666667 310.954667c0-27.392 8.277333-50.645333 24.32-69.674667z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `16`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 0C229.248 0 0 229.248 0 512s229.248 512 512 512 512-229.248 512-512S794.794667 0 512 0z" fill="#6D768D"></path><path d="M490.666667 682.666667a64 64 0 1 1 0 128 64 64 0 0 1 0-128z m13.994666-490.752c61.397333 0 112.341333 14.634667 153.002667 43.946666 40.533333 29.269333 60.885333 72.618667 60.885333 130.133334 0 35.242667-12.373333 64.938667-29.952 89.045333-10.282667 14.677333-33.664 33.408-62.890666 56.192l-32.426667 22.357333c-15.701333 12.202667-29.696 26.453333-34.858667 42.666667-1.706667 5.546667-3.072 14.677333-3.968 24.533333-0.426667 4.949333-4.864 15.018667-15.232 15.018667h-83.328c-13.568 0-15.957333-10.581333-15.744-15.786667 1.493333-34.005333 4.608-64.213333 18.474667-80.469333 28.074667-32.896 91.904-73.813333 91.904-73.813333a104.106667 104.106667 0 0 0 23.552-24.021334c10.837333-14.933333 19.797333-31.317333 19.797333-49.237333 0-20.565333-6.016-39.338667-18.090666-56.32-12.032-16.938667-34.090667-25.386667-66.005334-25.386667-31.445333 0-53.76 10.410667-66.901333 31.274667-9.685333 15.445333-15.786667 29.610667-18.346667 45.013333-0.853333 5.461333-4.394667 16.981333-16.042666 16.981334H327.210667c-17.322667 0-21.12-11.221333-20.650667-16.64 6.272-68.138667 32.896-114.688 80-144.597334 32-20.565333 71.381333-30.890667 118.101333-30.890666z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `17`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M336.256 410.026667H253.312a40.021333 40.021333 0 0 0-39.850667 43.264l23.296 278.101333c1.706667 20.693333 19.072 36.608 39.850667 36.608h59.648c11.050667 0 20.010667-8.96 20.010667-19.968v-318.037333a19.968 19.968 0 0 0-20.010667-19.968z m434.432 0h-178.944C653.312 182.314667 548.949333 170.666667 548.949333 170.666667c-44.288 0-35.114667 34.986667-38.442666 40.832 0 84.48-68.010667 155.093333-101.034667 184.362666a39.552 39.552 0 0 0-13.226667 29.653334v322.56c0 11.008 8.96 19.925333 20.010667 19.925333h233.728c30.378667 0 58.154667-17.152 71.68-44.373333 18.176-36.736 40.448-90.112 54.656-133.973334 13.781333-42.410667 26.24-94.976 33.578667-131.968a39.850667 39.850667 0 0 0-39.253334-47.658666z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `18`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M796.16 413.909333c-31.146667-0.298667-115.626667-0.085333-146.858667-0.085333h-158.464c8.533333-7.68 15.914667-14.506667 23.594667-20.906667 29.781333-24.874667 25.813333-71.082667-14.208-88.874666-22.954667-10.24-44.970667-5.632-64 11.52-34.944 31.274667-69.632 62.677333-104.277333 93.994666a15.488 15.488 0 0 1-11.178667 4.437334c-11.221333-0.085333-26.88-0.128-46.933333-0.170667a17.066667 17.066667 0 0 0-17.109334 17.066667L256 719.701333a17.066667 17.066667 0 0 0 17.066667 17.152l49.578666-0.085333c3.968 0 7.466667 0.768 10.88 2.602667 15.829333 8.832 31.701333 17.493333 47.616 26.24a18.133333 18.133333 0 0 0 9.301334 2.346666h168.405333c6.186667 0 11.946667-0.981333 17.834667-2.56 29.44-7.253333 40.021333-30.293333 38.528-52.565333-0.768-9.728-4.266667-18.346667-9.984-26.24 19.626667-5.76 35.114667-16.213333 42.112-36.096 7.125333-20.394667 1.621333-38.4-12.672-53.333333 28.16-19.754667 34.858667-44.672 18.645333-75.648h140.458667c6.570667 0 13.013333-0.597333 19.370666-2.645334 31.957333-9.813333 48.810667-42.88 35.626667-71.552-10.154667-22.186667-28.629333-33.152-52.608-33.450666z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `19`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M270.506667 413.909333c31.146667-0.298667 115.626667-0.085333 146.858666-0.085333h158.464c-8.533333-7.68-15.914667-14.506667-23.594666-20.906667-29.781333-24.874667-25.813333-71.082667 14.208-88.874666 22.954667-10.24 44.970667-5.632 64 11.52 34.944 31.274667 69.632 62.677333 104.277333 93.994666 3.413333 2.986667 6.528 4.437333 11.178667 4.437334 11.221333-0.085333 26.88-0.128 46.933333-0.170667a17.066667 17.066667 0 0 1 17.109333 17.066667l0.682667 288.853333a17.066667 17.066667 0 0 1-17.066667 17.152l-49.578666-0.085333a22.101333 22.101333 0 0 0-10.88 2.602666c-15.829333 8.832-31.701333 17.493333-47.616 26.24a18.133333 18.133333 0 0 1-9.301334 2.346667h-168.405333a68.693333 68.693333 0 0 1-17.834667-2.56c-29.44-7.253333-40.021333-30.293333-38.528-52.565333 0.768-9.728 4.266667-18.346667 9.984-26.24-19.626667-5.76-35.114667-16.213333-42.112-36.096-7.125333-20.394667-1.621333-38.4 12.672-53.333334-28.16-19.754667-34.858667-44.672-18.645333-75.648H272.853333c-6.570667 0-13.013333-0.597333-19.370666-2.645333-31.957333-9.813333-48.810667-42.88-35.626667-71.552 10.154667-22.186667 28.629333-33.152 52.608-33.450667z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `20`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M667.733333 480.128H400v-111.36a97.706667 97.706667 0 0 1 97.621333-97.621333 97.706667 97.706667 0 0 1 97.578667 97.621333 28.885333 28.885333 0 0 0 57.813333 0A155.605333 155.605333 0 0 0 497.621333 213.333333a155.605333 155.605333 0 0 0-155.392 155.434667v111.36h-14.677333A28.885333 28.885333 0 0 0 298.666667 509.013333v292.010667a28.885333 28.885333 0 0 0 28.885333 28.885333h340.138667a28.885333 28.885333 0 0 0 28.928-28.885333V509.013333a28.885333 28.885333 0 0 0-28.928-28.885333z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `21`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M400.042667 437.461333v-111.36a97.706667 97.706667 0 0 1 97.621333-97.621333 97.706667 97.706667 0 0 1 97.578667 97.621333 28.885333 28.885333 0 0 0 57.813333 0A155.605333 155.605333 0 0 0 497.621333 170.666667a155.605333 155.605333 0 0 0-155.392 155.434666v111.36h-14.677333A28.885333 28.885333 0 0 0 298.666667 466.346667v292.010666a28.885333 28.885333 0 0 0 28.885333 28.885334h340.138667a28.885333 28.885333 0 0 0 28.928-28.885334V466.346667a28.885333 28.885333 0 0 0-28.928-28.885334H400.042667z" fill="#FFFFFF"></path><path d="M595.242667 437.461333v-111.36a97.706667 97.706667 0 0 0-97.621334-97.621333 97.706667 97.706667 0 0 0-97.578666 97.621333 28.885333 28.885333 0 0 1-57.813334 0A155.605333 155.605333 0 0 1 497.621333 170.666667a155.605333 155.605333 0 0 1 155.434667 155.434666v111.36h14.634667c16 0 28.928 12.928 28.928 28.885334v292.010666a28.885333 28.885333 0 0 1-28.928 28.885334H327.552A28.885333 28.885333 0 0 1 298.666667 758.357333V466.346667c0-15.957333 12.928-28.885333 28.885333-28.885334h267.690667z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `22`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M511.999787 512.000213m-511.999787 0a511.999787 511.999787 0 1 0 1023.999573 0 511.999787 511.999787 0 1 0-1023.999573 0Z" fill="#6D768D"></path><path d="M381.354508 364.586941c0 54.015977 29.013321 103.935957 75.946635 130.986613a152.53327 152.53327 0 0 0 151.935936 0 151.12527 151.12527 0 0 0 75.946636-130.986613A151.594604 151.594604 0 0 0 533.333111 213.333671a151.594604 151.594604 0 0 0-151.89327 151.25327zM660.479725 498.901552a185.258589 185.258589 0 0 1-127.146614 50.346646c-49.066646 0-93.866628-19.199992-127.06128-50.346646C317.141201 544.853533 255.999893 637.440161 255.999893 744.106783c0 13.183995 10.709329 23.850657 23.978657 23.850657h506.709122a23.893323 23.893323 0 0 0 23.978657-23.893323c0-106.538622-61.098641-199.25325-150.186604-245.205232z" fill="#FFFFFF"></path></svg>`,
        },
        {
          name: `23`,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1024 1024"><path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="#6D768D"></path><path d="M445.610667 401.578667a129.322667 129.322667 0 1 0 258.645333 0 129.322667 129.322667 0 0 0-258.645333 0z m237.568 114.901333a157.354667 157.354667 0 0 1-216.362667 0 236.373333 236.373333 0 0 0-127.957333 209.706667c0 11.264 9.130667 20.394667 20.394666 20.394666h431.402667a20.394667 20.394667 0 0 0 20.394667-20.394666 236.373333 236.373333 0 0 0-127.872-209.706667zM409.813333 401.578667c0-40.362667 14.592-77.397333 38.698667-106.112a112.725333 112.725333 0 0 0-29.013333-3.925334 112.64 112.64 0 0 0-112.426667 112.469334 112.64 112.64 0 0 0 144.853333 107.648 164.693333 164.693333 0 0 1-42.112-110.08z m-18.602666 136.704a136.533333 136.533333 0 0 1-65.706667-34.474667 205.44 205.44 0 0 0-111.232 182.4c0 9.813333 7.936 17.706667 17.706667 17.706667H303.36a273.621333 273.621333 0 0 1 87.893333-165.632z" fill="#FFFFFF"></path></svg>`,
        },
      ],
    },
  ],
  No = {
    hyperlink: ko,
    note: Ao,
    attachment: jo,
    nodeIconList: Mo,
    getNodeIconListIcon: (e, t = []) => {
      let n = e.split(`_`),
        r = da([...Mo, ...t]).find((e) => e.type === n[0]);
      if (r) {
        let e = r.list.find((e) => e.name === n[1]);
        return e ? e.icon : ``;
      } else return ``;
    },
  },
  Po = (e, t) => {
    let n = new q(),
      r = new K().text(e);
    return (t.text(r), n.add(r), n.bbox());
  },
  Fo = { radius: 3, fontSize: 12, fill: ``, height: 20, paddingX: 8 };
function Io() {
  let e = this.getData(`image`);
  return (this.mindMap.renderer.renderTree.data.imgMap || {})[e] || e;
}
function Lo() {
  let e = this.getImageUrl();
  if (!e) return;
  e = (this.mindMap.renderer.renderTree.data.imgMap || {})[e] || e;
  let t = this.getImgShowSize(),
    n = new Kn().load(e).size(...t),
    { defaultNodeImage: r } = this.mindMap.opt;
  if (r) {
    let t = new Image();
    ((t.onerror = () => {
      n.load(r);
    }),
      (t.src = e));
  }
  return (
    this.getData(`imageTitle`) && n.attr(`title`, this.getData(`imageTitle`)),
    n.on(`click`, (e) => {
      this.mindMap.emit(`node_img_click`, this, n, e);
    }),
    n.on(`dblclick`, (e) => {
      this.mindMap.emit(`node_img_dblclick`, this, e, n);
    }),
    n.on(`mouseenter`, (e) => {
      this.mindMap.emit(`node_img_mouseenter`, this, n, e);
    }),
    n.on(`mouseleave`, (e) => {
      this.mindMap.emit(`node_img_mouseleave`, this, n, e);
    }),
    n.on(`mousemove`, (e) => {
      this.mindMap.emit(`node_img_mousemove`, this, n, e);
    }),
    { node: n, width: t[0], height: t[1] }
  );
}
function Ro() {
  let { custom: e, width: t, height: n } = this.getData(`imageSize`);
  return e
    ? [t, n]
    : Li(
        t,
        n,
        this.mindMap.themeConfig.imgMaxWidth,
        this.mindMap.themeConfig.imgMaxHeight,
      );
}
function zo() {
  let e = this.getData();
  if (!e.icon || e.icon.length <= 0) return [];
  let t = this.mindMap.themeConfig.iconSize;
  return e.icon.map((e) => {
    let n = No.getNodeIconListIcon(e, this.mindMap.opt.iconList || []),
      r = null;
    return (
      (r = /^<svg/.test(n) ? J(n) : new Kn().load(n)),
      r.size(t, t),
      r.on(`click`, (t) => {
        this.mindMap.emit(`node_icon_click`, this, e, t, r);
      }),
      r.on(`mouseenter`, (t) => {
        this.mindMap.emit(`node_icon_mouseenter`, this, e, t, r);
      }),
      r.on(`mouseleave`, (t) => {
        this.mindMap.emit(`node_icon_mouseleave`, this, e, t, r);
      }),
      { node: r, width: t, height: t }
    );
  });
}
function Bo(e) {
  let t = this.hasCustomWidth(),
    n = typeof e == `string` ? e : this.getData(`text`),
    { textAutoWrapWidth: r, emptyTextMeasureHeightText: i } = this.mindMap.opt;
  r = t ? this.customTextWidth : r;
  let a = new q(),
    o = !1;
  (this.getData(`resetRichText`) &&
    (delete this.nodeData.data.resetRichText, (o = !0)),
    o &&
      !ea(n) &&
      ((n = na(n) ? sa(n) : `<p>${n}</p>`), this.setData({ text: n })));
  let s = [],
    c = za(this);
  (Object.keys(c).forEach((e) => {
    s.push([e, c[e]]);
  }),
    this.mindMap.commonCaches.measureRichtextNodeTextSizeEl ||
      ((this.mindMap.commonCaches.measureRichtextNodeTextSizeEl =
        document.createElement(`div`)),
      (this.mindMap.commonCaches.measureRichtextNodeTextSizeEl.style.position = `fixed`),
      (this.mindMap.commonCaches.measureRichtextNodeTextSizeEl.style.left = `-999999px`),
      this.mindMap.el.appendChild(
        this.mindMap.commonCaches.measureRichtextNodeTextSizeEl,
      )));
  let l = this.mindMap.commonCaches.measureRichtextNodeTextSizeEl;
  (s.forEach(([e, t]) => {
    l.style[e] = t;
  }),
    (l.style.lineHeight = 1.2));
  let u = `<div>${n}</div>`;
  l.innerHTML = u;
  let d = l.children[0];
  (d.classList.add(`smm-richtext-node-wrap`),
    Ia(d),
    (d.style.maxWidth = r + `px`),
    t ? (d.style.width = this.customTextWidth + `px`) : (d.style.width = ``));
  let { width: f, height: p } = d.getBoundingClientRect();
  if (p <= 0) {
    l.innerHTML = `<p>${i}</p>`;
    let e = l.children[0];
    (e.classList.add(`smm-richtext-node-wrap`),
      (p = e.getBoundingClientRect().height),
      (l.innerHTML = u));
  }
  ((f = Math.min(Math.ceil(f) + 1, r)),
    (p = Math.ceil(p)),
    a.attr(`data-width`, f),
    a.attr(`data-height`, p));
  let m = Pa({ el: l.children[0], width: f, height: p }),
    h = { "line-height": 1.2 };
  return (
    s.forEach(([e, t]) => {
      h[Gi(e)] = t;
    }),
    m.css(h),
    a.add(m),
    { node: a, nodeContent: m, width: f, height: p }
  );
}
function Vo(e) {
  if (
    (this.getData(`needUpdate`) && delete this.nodeData.data.needUpdate,
    this.getData(`richText`))
  )
    return this.createRichTextNode(e);
  let t = typeof e == `string` ? e : this.getData(`text`);
  this.getData(`resetRichText`) && delete this.nodeData.data.resetRichText;
  let n = new q(),
    r = this.getStyle(`fontSize`, !1),
    i = this.getStyle(`textAlign`, !1),
    a = [];
  ea(t) || (a = String(t).split(/\n/gim));
  let { textAutoWrapWidth: o, emptyTextMeasureHeightText: s } =
      this.mindMap.opt,
    c = a.length > 1;
  (a.forEach((e, t) => {
    let n = e.split(``),
      r = [],
      i = [];
    for (; n.length;) {
      let e = n.shift();
      Po([...i, e].join(``), this.style).width <= o
        ? i.push(e)
        : (r.push(i.join(``)), (i = [e]));
    }
    (i.length > 0 && r.push(i.join(``)),
      r.length > 1 && (c = !0),
      (a[t] = r.join(`
`)));
  }),
    (a = a
      .join(
        `
`,
      )
      .replace(/\n$/g, ``)
      .split(/\n/gim)),
    a.forEach((e, t) => {
      e === `` && (e = `﻿`);
      let a = new K().text(e);
      (a.addClass(`smm-text-node-wrap`),
        a.attr(
          `text-anchor`,
          { left: `start`, center: `middle`, right: `end` }[i] || `start`,
        ),
        this.style.text(a),
        a.y(r * T * t + ((T - 1) * r) / 2),
        n.add(a));
    }));
  let { width: l, height: u } = n.bbox();
  if (u <= 0) {
    let e = new K().text(s);
    (this.style.text(e), (u = e.bbox().height));
  }
  return (
    (l = Math.min(Math.ceil(l), o)),
    (u = Math.ceil(u)),
    n.attr(`data-width`, l),
    n.attr(`data-height`, u),
    n.attr(`data-ismultiLine`, c || a.length > 1),
    { node: n, width: l, height: u }
  );
}
function Ho() {
  let { hyperlink: e, hyperlinkTitle: t } = this.getData();
  if (!e) return;
  let { customHyperlinkJump: n, hyperlinkIcon: r } = this.mindMap.opt,
    { icon: i, style: a } = r,
    o = this.getNodeIconSize(`hyperlinkIcon`),
    s = new J().size(o, o),
    c = new Ti().to(e).target(`_blank`);
  (c.node.addEventListener(`click`, (t) => {
    typeof n == `function` && (t.preventDefault(), n(e, this));
  }),
    t && s.add(J(`<title>${t}</title>`)),
    c.rect(o, o).fill({ color: `transparent` }));
  let l = J(i || No.hyperlink).size(o, o);
  return (
    this.style.iconNode(l, a.color),
    c.add(l),
    s.add(c),
    { node: s, width: o, height: o }
  );
}
function Uo() {
  let e = this.getData(`tag`);
  if (!e || e.length <= 0) return [];
  let { maxTag: t, tagsColorMap: n } = this.mindMap.opt;
  n ||= {};
  let r = [];
  return (
    e.slice(0, t).forEach((e, t) => {
      let i = ``,
        a = { ...Fo };
      typeof e == `string`
        ? (i = e)
        : ((i = e.text), (a = { ...Fo, ...e.style }));
      let o = a.width !== void 0,
        s = new q();
      s.on(`click`, () => {
        this.mindMap.emit(`node_tag_click`, this, e, t, s);
      });
      let c = new K().text(i);
      this.style.tagText(c, a);
      let { width: l, height: u } = c.bbox(),
        d = o ? a.width : l + a.paddingX * 2,
        f = o ? Math.max(d, l) : d,
        p = Math.max(a.height, u);
      (o ? c.x((f - l) / 2) : c.x(o ? 0 : a.paddingX), c.cy(-p / 2));
      let m = new W().size(d, a.height).cy(-p / 2);
      (o && m.x((f - d) / 2),
        this.style.tagRect(m, {
          ...a,
          fill: a.fill || n[c.node.textContent] || ya(c.node.textContent),
        }),
        s.add(m).add(c),
        r.push({ node: s, width: f, height: p }));
    }),
    r
  );
}
function Wo() {
  if (!this.getData(`note`)) return null;
  let { icon: e, style: t } = this.mindMap.opt.noteIcon,
    n = this.getNodeIconSize(`noteIcon`),
    r = new J().attr(`cursor`, `pointer`).addClass(`smm-node-note`).size(n, n);
  r.add(new W().size(n, n).fill({ color: `transparent` }));
  let i = J(e || No.note).size(n, n);
  return (
    this.style.iconNode(i, t.color),
    r.add(i),
    this.mindMap.opt.customNoteContentShow ||
      (this.noteEl ||
        ((this.noteEl = document.createElement(`div`)),
        (this.noteEl.style.cssText = `
          position: fixed;
          padding: 10px;
          border-radius: 5px;
          box-shadow: 0 2px 5px rgb(0 0 0 / 10%);
          display: none;
          background-color: #fff;
          z-index: ${this.mindMap.opt.nodeNoteTooltipZIndex}
      `),
        (this.mindMap.opt.customInnerElsAppendTo || document.body).appendChild(
          this.noteEl,
        )),
      (this.noteEl.innerText = this.getData(`note`))),
    r.on(`mouseover`, () => {
      let { left: e, top: t } = this.getNoteContentPosition();
      this.mindMap.opt.customNoteContentShow
        ? this.mindMap.opt.customNoteContentShow.show(
            this.getData(`note`),
            e,
            t,
            this,
          )
        : ((this.noteEl.style.left = e + `px`),
          (this.noteEl.style.top = t + `px`),
          (this.noteEl.style.display = `block`));
    }),
    r.on(`mouseout`, () => {
      this.mindMap.opt.customNoteContentShow
        ? this.mindMap.opt.customNoteContentShow.hide()
        : (this.noteEl.style.display = `none`);
    }),
    r.on(`click`, (e) => {
      this.mindMap.emit(`node_note_click`, this, e, r);
    }),
    r.on(`dblclick`, (e) => {
      this.mindMap.emit(`node_note_dblclick`, this, e, r);
    }),
    { node: r, width: n, height: n }
  );
}
function Go() {
  let { attachmentUrl: e, attachmentName: t } = this.getData();
  if (!e) return;
  let n = this.getNodeIconSize(`attachmentIcon`),
    { icon: r, style: i } = this.mindMap.opt.attachmentIcon,
    a = new J().attr(`cursor`, `pointer`).size(n, n);
  (t && a.add(J(`<title>${t}</title>`)),
    a.add(new W().size(n, n).fill({ color: `transparent` })));
  let o = J(r || No.attachment).size(n, n);
  return (
    this.style.iconNode(o, i.color),
    a.add(o),
    a.on(`click`, (e) => {
      this.mindMap.emit(`node_attachmentClick`, this, e, a);
    }),
    a.on(`contextmenu`, (e) => {
      this.mindMap.emit(`node_attachmentContextmenu`, this, e, a);
    }),
    { node: a, width: n, height: n }
  );
}
function Ko(e) {
  let { style: t } = this.mindMap.opt[e];
  return ea(t.size) ? this.mindMap.themeConfig.iconSize : t.size;
}
function qo() {
  let e = this.getNodeIconSize(`noteIcon`),
    { scaleY: t } = this.mindMap.view.getTransformData().transform,
    n = e * t,
    { left: r, top: i } = this._noteData.node.node.getBoundingClientRect();
  return ((i += n), { left: r, top: i });
}
function Jo(e) {
  (this.mindMap.commonCaches.measureCustomNodeContentSizeEl ||
    ((this.mindMap.commonCaches.measureCustomNodeContentSizeEl =
      document.createElement(`div`)),
    (this.mindMap.commonCaches.measureCustomNodeContentSizeEl.style.cssText = `
      position: fixed;
      left: -99999px;
      top: -99999px;
    `),
    this.mindMap.el.appendChild(
      this.mindMap.commonCaches.measureCustomNodeContentSizeEl,
    )),
    (this.mindMap.commonCaches.measureCustomNodeContentSizeEl.innerHTML = ``),
    this.mindMap.commonCaches.measureCustomNodeContentSizeEl.appendChild(e));
  let t =
    this.mindMap.commonCaches.measureCustomNodeContentSizeEl.getBoundingClientRect();
  return { width: t.width, height: t.height };
}
function Yo() {
  return !!this._customNodeContent;
}
var Xo = {
  getImageUrl: Io,
  createImgNode: Lo,
  getImgShowSize: Ro,
  createIconNode: zo,
  createRichTextNode: Bo,
  createTextNode: Vo,
  createHyperlinkNode: Ho,
  createTagNode: Uo,
  createNoteNode: Wo,
  createAttachmentNode: Go,
  getNoteContentPosition: qo,
  getNodeIconSize: Ko,
  measureCustomNodeContentSize: Jo,
  isUseCustomNodeContent: Yo,
};
function Zo() {
  if (this.getChildrenLength() <= 0 || this.isRoot) return;
  let {
    alwaysShowExpandBtn: e,
    notShowExpandBtn: t,
    expandBtnSize: n,
  } = this.mindMap.opt;
  if (!e && !t) {
    let { width: e, height: t } = this;
    (this._unVisibleRectRegionNode ||
      ((this._unVisibleRectRegionNode = new W()),
      this._unVisibleRectRegionNode.fill({ color: `transparent` })),
      this.group.add(this._unVisibleRectRegionNode),
      this.renderer.layout.renderExpandBtnRect(
        this._unVisibleRectRegionNode,
        n,
        e,
        t,
        this,
      ));
  }
}
function Qo() {
  this._unVisibleRectRegionNode &&=
    (this._unVisibleRectRegionNode.remove(), null);
}
function $o() {
  (this.needRerenderExpandBtnPlaceholderRect &&
    ((this.needRerenderExpandBtnPlaceholderRect = !1),
    this.renderExpandBtnPlaceholderRect()),
    this.getChildrenLength() > 0
      ? this._unVisibleRectRegionNode || this.renderExpandBtnPlaceholderRect()
      : this._unVisibleRectRegionNode && this.clearExpandBtnPlaceholderRect());
}
var es = {
  renderExpandBtnPlaceholderRect: Zo,
  clearExpandBtnPlaceholderRect: Qo,
  updateExpandBtnPlaceholderRect: $o,
};
function ts() {
  this.checkEnableDragModifyNodeWidth() &&
    ((this._dragHandleNodes = null),
    (this.dragHandleWidth = 4),
    (this.dragHandleMousedownX = 0),
    (this.isDragHandleMousedown = !1),
    (this.dragHandleIndex = 0),
    (this.dragHandleMousedownCustomTextWidth = 0),
    (this.dragHandleMousedownBodyCursor = ``),
    (this.dragHandleMousedownLeft = 0),
    (this.onDragMousemoveHandle = this.onDragMousemoveHandle.bind(this)),
    window.addEventListener(`mousemove`, this.onDragMousemoveHandle),
    (this.onDragMouseupHandle = this.onDragMouseupHandle.bind(this)),
    window.addEventListener(`mouseup`, this.onDragMouseupHandle),
    this.mindMap.on(`node_mouseup`, this.onDragMouseupHandle));
}
function ns(e) {
  if (!this.isDragHandleMousedown) return;
  (e.stopPropagation(), e.preventDefault());
  let {
      minNodeTextModifyWidth: t,
      maxNodeTextModifyWidth: n,
      isUseCustomNodeContent: r,
      customCreateNodeContent: i,
    } = this.mindMap.opt,
    a = r && i && this._customNodeContent;
  ((document.body.style.cursor = `ew-resize`),
    this.group.css({ cursor: `ew-resize` }));
  let { scaleX: o } = this.mindMap.draw.transform(),
    s = e.clientX - this.dragHandleMousedownX,
    c =
      this.dragHandleMousedownCustomTextWidth +
      (this.dragHandleIndex === 0 ? -s : s) / o;
  if (
    ((c = Math.max(c, t)),
    n !== -1 && (c = Math.min(c, n)),
    !a && this.getData(`image`))
  ) {
    let e = this.getImgShowSize();
    this._rectInfo.textContentWidth - this.customTextWidth + c <= e[0] &&
      (c = e[0] + this.customTextWidth - this._rectInfo.textContentWidth);
  }
  ((this.customTextWidth = c),
    this.dragHandleIndex === 0 &&
      (this.left = this.dragHandleMousedownLeft + s / o),
    this.reRender(a ? [] : [`text`], { ignoreUpdateCustomTextWidth: !0 }));
}
function rs() {
  this.isDragHandleMousedown &&
    ((document.body.style.cursor = this.dragHandleMousedownBodyCursor),
    this.group.css({ cursor: `default` }),
    (this.isDragHandleMousedown = !1),
    (this.dragHandleMousedownX = 0),
    (this.dragHandleIndex = 0),
    (this.dragHandleMousedownCustomTextWidth = 0),
    this.setData({ customTextWidth: this.customTextWidth }),
    this.mindMap.render(),
    this.mindMap.emit(`dragModifyNodeWidthEnd`, this));
}
function is() {
  let e = [new W(), new W()];
  return (
    e.forEach((e, t) => {
      (e
        .size(this.dragHandleWidth, this.height)
        .fill({ color: `transparent` })
        .css({ cursor: `ew-resize` }),
        e.on(`mousedown`, (e) => {
          (e.stopPropagation(),
            e.preventDefault(),
            (this.dragHandleMousedownX = e.clientX),
            (this.dragHandleIndex = t),
            (this.dragHandleMousedownCustomTextWidth =
              this.customTextWidth === void 0
                ? this._textData
                  ? this._textData.width
                  : this.width
                : this.customTextWidth),
            (this.dragHandleMousedownBodyCursor = document.body.style.cursor),
            (this.dragHandleMousedownLeft = this.left),
            (this.isDragHandleMousedown = !0));
        }));
    }),
    e
  );
}
function as() {
  this.checkEnableDragModifyNodeWidth() &&
    ((this._dragHandleNodes ||= this.createDragHandleNode()),
    this.getData(`isActive`)
      ? (this._dragHandleNodes.forEach((e) => {
          (e.height(this.height), this.group.add(e));
        }),
        this._dragHandleNodes[1].x(this.width - this.dragHandleWidth))
      : this._dragHandleNodes.forEach((e) => {
          e.remove();
        }));
}
var os = {
  initDragHandle: ts,
  onDragMousemoveHandle: ns,
  onDragMouseupHandle: rs,
  createDragHandleNode: is,
  updateDragHandle: as,
};
function ss() {
  this.mindMap.cooperate &&
    ((this._userListGroup = new q()), this.group.add(this._userListGroup));
}
function cs(e) {
  let { avatarSize: t, fontSize: n } = this.mindMap.opt.cooperateStyle,
    r = new q(),
    i = e.isMore ? e.name : String(e.name)[0],
    a = new fi().size(t, t);
  a.fill({ color: e.color || ya(i) });
  let o = new K()
    .text(i)
    .fill({ color: `#fff` })
    .css({ "font-size": n + `px` })
    .dx(-n / 2)
    .dy((t - n) / 2);
  return (r.add(a).add(o), r);
}
function ls(e) {
  let { avatarSize: t } = this.mindMap.opt.cooperateStyle;
  return new Kn().load(e.avatar).size(t, t);
}
function us() {
  if (!this._userListGroup) return;
  let { avatarSize: e } = this.mindMap.opt.cooperateStyle;
  this._userListGroup.clear();
  let t = this.userList.length,
    n = Math.floor(this.width / e),
    r = [];
  (t > n
    ? r.push(...this.userList.slice(0, n - 1), {
        isMore: !0,
        name: `+` + (t - n + 1),
      })
    : r.push(...this.userList),
    r.forEach((t, n) => {
      let r = null;
      ((r = t.avatar ? this.createImageAvatar(t) : this.createTextAvatar(t)),
        r.on(`click`, (e) => {
          this.mindMap.emit(`node_cooperate_avatar_click`, t, this, r, e);
        }),
        r.on(`mouseenter`, (e) => {
          this.mindMap.emit(`node_cooperate_avatar_mouseenter`, t, this, r, e);
        }),
        r.on(`mouseleave`, (e) => {
          this.mindMap.emit(`node_cooperate_avatar_mouseleave`, t, this, r, e);
        }),
        r.x(n * e).cy(-e / 2),
        this._userListGroup.add(r));
    }));
}
function ds(e) {
  this.userList.find((t) => t.id == e.id) ||
    (this.userList.push(e), this.updateUserListNode());
}
function fs(e) {
  let t = this.userList.findIndex((t) => t.id == e.id);
  t !== -1 && (this.userList.splice(t, 1), this.updateUserListNode());
}
function ps() {
  ((this.userList = []), this.updateUserListNode());
}
var ms = {
  createUserListNode: ss,
  updateUserListNode: us,
  createTextAvatar: cs,
  createImageAvatar: ls,
  addUser: ds,
  removeUser: fs,
  emptyUser: ps,
};
function hs() {
  this.isGeneralization ||
    ((this._quickCreateChildBtn = null), (this._showQuickCreateChildBtn = !1));
}
function gs() {
  if (!(this.isGeneralization || this.getChildrenLength() > 0)) {
    if (this._quickCreateChildBtn) this.group.add(this._quickCreateChildBtn);
    else {
      let {
          quickCreateChildBtnIcon: e,
          expandBtnStyle: t,
          expandBtnSize: n,
        } = this.mindMap.opt,
        { icon: r, style: i } = e,
        { color: a, fill: o } = t || { color: `#808080`, fill: `#fff` };
      a = i.color || a;
      let s = J(r || oo.quickCreateChild).size(n, n);
      (s.css({ cursor: `pointer` }),
        s.x(0).y(-n / 2),
        this.style.iconNode(s, a));
      let c = new fi().size(n);
      (c.x(0).y(-n / 2),
        c.fill({ color: o }).css({ cursor: `pointer` }),
        (this._quickCreateChildBtn = new q()),
        this._quickCreateChildBtn.add(c).add(s),
        this._quickCreateChildBtn.on(`click`, (e) => {
          (e.stopPropagation(),
            this.mindMap.emit(`quick_create_btn_click`, this));
          let { customQuickCreateChildBtnClick: t } = this.mindMap.opt;
          if (typeof t == `function`) {
            t(this);
            return;
          }
          this.mindMap.execCommand(`INSERT_CHILD_NODE`, !0, [this]);
        }),
        this._quickCreateChildBtn.on(`dblclick`, (e) => {
          e.stopPropagation();
        }),
        this._quickCreateChildBtn.addClass(`smm-quick-create-child-btn`),
        this.group.add(this._quickCreateChildBtn));
    }
    ((this._showQuickCreateChildBtn = !0),
      this.renderer.layout.renderExpandBtn(this, this._quickCreateChildBtn));
  }
}
function _s() {
  this.isGeneralization ||
    (this._quickCreateChildBtn &&
      this._showQuickCreateChildBtn &&
      (this._quickCreateChildBtn.remove(),
      (this._showQuickCreateChildBtn = !1)));
}
function vs() {
  if (this.isGeneralization) return;
  let { isActive: e } = this.getData();
  e || this.removeQuickCreateChildBtn();
}
var ys = {
  initQuickCreateChildBtn: hs,
  showQuickCreateChildBtn: gs,
  removeQuickCreateChildBtn: _s,
  hideQuickCreateChildBtn: vs,
};
function bs(e, t, n, r, i) {
  let { imgTextMargin: a } = this.mindMap.opt;
  return e === `v` ? (r > 0 && i > 0 ? a : 0) : t > 0 && n > 0 ? a : 0;
}
function xs(e) {
  let t = 0,
    n = this._tagData.reduce(
      (e, n) => ((t = Math.max(t, n.height)), (e += n.width)),
      0,
    );
  return ((n += (this._tagData.length - 1) * e), { width: n, height: t });
}
function Ss() {
  if (this.isUseCustomNodeContent()) {
    let e = this.measureCustomNodeContentSize(
      this._customNodeContent.cloneNode(!0),
    );
    return {
      width: this.hasCustomWidth() ? this.customTextWidth : e.width,
      height: e.height,
    };
  }
  let { TAG_PLACEMENT: e, IMG_PLACEMENT: t } = w,
    { textContentMargin: n } = this.mindMap.opt,
    r = (this.getStyle(`tagPlacement`) || e.RIGHT) === e.BOTTOM,
    i = this.getStyle(`imgPlacement`) || t.TOP,
    a = 0,
    o = 0,
    s = 0,
    c = 0,
    l = 0,
    u = 0,
    d = 0;
  if (
    (this._imgData && ((a = this._imgData.width), (o = this._imgData.height)),
    this.mindMap.nodeInnerPrefixList.forEach((e) => {
      let t = this[`_${e.name}Data`];
      t && ((s += t.width), (c = Math.max(c, t.height)), d++);
    }),
    this._prefixData &&
      ((s += this._prefixData.width),
      (c = Math.max(c, this._prefixData.height)),
      d++),
    this._iconData.length > 0 &&
      ((s +=
        this._iconData.reduce(
          (e, t) => ((c = Math.max(c, t.height)), (e += t.width)),
          0,
        ) +
        (this._iconData.length - 1) * n),
      d++),
    this._textData &&
      ((s += this._textData.width),
      (c = Math.max(c, this._textData.height)),
      d++),
    this._hyperlinkData &&
      ((s += this._hyperlinkData.width),
      (c = Math.max(c, this._hyperlinkData.height)),
      d++),
    this._tagData.length > 0)
  ) {
    let { width: e, height: t } = this.getTagContentSize(n);
    r ? ((l = e), (u = t)) : ((s += e), (c = Math.max(c, t)), d++);
  }
  (this._noteData &&
    ((s += this._noteData.width),
    (c = Math.max(c, this._noteData.height)),
    d++),
    this._attachmentData &&
      ((s += this._attachmentData.width),
      (c = Math.max(c, this._attachmentData.height)),
      d++),
    this._postfixData &&
      ((s += this._postfixData.width),
      (c = Math.max(c, this._postfixData.height)),
      d++),
    this.mindMap.nodeInnerPostfixList.forEach((e) => {
      let t = this[`_${e.name}Data`];
      t && ((s += t.width), (c = Math.max(c, t.height)), d++);
    }),
    (s += (d - 1) * n),
    r &&
      s > 0 &&
      u > 0 &&
      ((this._rectInfo.textContentWidthWithoutTag = s),
      (s = Math.max(s, l)),
      (c = c + n + u)),
    (this._rectInfo.textContentWidth = s),
    (this._rectInfo.textContentHeight = c));
  let f = 0,
    p = 0;
  [t.TOP, t.BOTTOM].includes(i)
    ? ((f = Math.max(a, s)),
      (p = o + c + this.getImgTextMarin(`v`, 0, 0, o, c)))
    : ((f = a + s + this.getImgTextMarin(`h`, a, s)), (p = Math.max(o, c)));
  let { paddingX: m, paddingY: h } = this.getPaddingVale(),
    { paddingX: g, paddingY: _ } = this.shapeInstance.getShapePadding(
      f,
      p,
      m,
      h,
    );
  ((this.shapePadding.paddingX = g), (this.shapePadding.paddingY = _));
  let v = this.getBorderWidth();
  return { width: f + m * 2 + g * 2 + v, height: p + h * 2 + _ * 2 + v };
}
function Cs(e, t) {
  let { hoverRectPadding: n } = this.mindMap.opt;
  ((this.hoverNode = new W()
    .size(e + n * 2, t + n * 2)
    .x(-n)
    .y(-n)),
    this.hoverNode.addClass(`smm-hover-node`),
    this.style.hoverNode(this.hoverNode, e, t),
    this.group.add(this.hoverNode));
}
function ws() {
  if (!this.group || !this.isUseCustomNodeContent()) return;
  (this.shapeNode && this.shapeNode.remove(),
    this._unVisibleRectRegionNode && this._unVisibleRectRegionNode.remove(),
    this.hoverNode && this.hoverNode.remove());
  let { width: e, height: t } = this,
    n = this.getBorderWidth() / 2;
  ((this.shapeNode = this.shapeInstance.createShape()),
    this.shapeNode.addClass(`smm-node-shape`),
    this.shapeNode.translate(n, n),
    this.style.shape(this.shapeNode),
    this.group.add(this.shapeNode),
    this.renderExpandBtnPlaceholderRect(),
    this.isGeneralization &&
      this.generalizationBelongNode &&
      this.group.addClass(
        `generalization_` + this.generalizationBelongNode.uid,
      ),
    this.addHoverNode(e, t),
    this.shapeNode.back(),
    this.group.findOne(`foreignObject`).size(e, t));
}
function Ts() {
  if (!this.group) return;
  this.group.clear();
  let {
      openRealtimeRenderOnNodeTextEdit: e,
      textContentMargin: t,
      addCustomContentToNode: n,
    } = this.mindMap.opt,
    { width: r, height: i } = this,
    { paddingX: a, paddingY: o } = this.getPaddingVale(),
    s = this.getBorderWidth() / 2;
  if (
    ((a += this.shapePadding.paddingX + s),
    (o += this.shapePadding.paddingY + s),
    (this.shapeNode = this.shapeInstance.createShape()),
    this.shapeNode.addClass(`smm-node-shape`),
    this.shapeNode.translate(s, s),
    this.style.shape(this.shapeNode),
    this.group.add(this.shapeNode),
    this.renderExpandBtnPlaceholderRect(),
    this.createUserListNode && this.createUserListNode(),
    this.isGeneralization &&
      this.generalizationBelongNode &&
      this.group.addClass(
        `generalization_` + this.generalizationBelongNode.uid,
      ),
    this.isUseCustomNodeContent())
  ) {
    let e = Pa({ el: this._customNodeContent, width: r, height: i });
    (this.group.add(e), this.addHoverNode(r, i));
    return;
  }
  let { IMG_PLACEMENT: c, TAG_PLACEMENT: l } = w,
    u = this.getStyle(`imgPlacement`) || c.TOP,
    d = (this.getStyle(`tagPlacement`) || l.RIGHT) === l.BOTTOM,
    {
      textContentWidth: f,
      textContentHeight: p,
      textContentWidthWithoutTag: m,
    } = this._rectInfo,
    h = p,
    g = 0,
    _ = 0,
    v = this._tagData && this._tagData.length > 0;
  if (v) {
    let e = this.getTagContentSize(t);
    ((g = e.width), (_ = e.height), d && (p -= _ + t));
  }
  let y = 0,
    ee = 0;
  if (this._imgData)
    switch (
      ((y = this._imgData.width),
      (ee = this._imgData.height),
      this.group.add(this._imgData.node),
      u)
    ) {
      case c.TOP:
        this._imgData.node.cx(r / 2).y(o);
        break;
      case c.BOTTOM:
        this._imgData.node.cx(r / 2).y(i - o - ee);
        break;
      case c.LEFT:
        this._imgData.node.x(a).cy(i / 2);
        break;
      case c.RIGHT:
        this._imgData.node.x(r - a - y).cy(i / 2);
        break;
      default:
        break;
    }
  let b = new q(),
    x = 0;
  if (
    (v && d && (x = m < f ? (f - m) / 2 : 0),
    this.mindMap.nodeInnerPrefixList.forEach((e) => {
      let n = this[`_${e.name}Data`];
      n &&
        (n.node.x(x).y((p - n.height) / 2), b.add(n.node), (x += n.width + t));
    }),
    this._prefixData)
  ) {
    let e = Pa({
      el: this._prefixData.el,
      width: this._prefixData.width,
      height: this._prefixData.height,
    });
    (e.x(x).y((p - this._prefixData.height) / 2),
      b.add(e),
      (x += this._prefixData.width + t));
  }
  let te = new q();
  if (this._iconData && this._iconData.length > 0) {
    let e = 0;
    (this._iconData.forEach((n) => {
      (n.node.x(x + e).y((p - n.height) / 2),
        te.add(n.node),
        (e += n.width + t));
    }),
      b.add(te),
      (x += e));
  }
  if (this._textData) {
    let n = this._textData.node.attr(`data-offsetx`) || 0;
    (this._textData.node.attr(`data-offsetx`, x),
      (this._textData.nodeContent || this._textData.node)
        .x(-n)
        .x(x)
        .y((p - this._textData.height) / 2),
      e &&
        this._textData.node.opacity(
          this.mindMap.renderer.textEdit.getCurrentEditNode() === this ? 0 : 1,
        ),
      b.add(this._textData.node),
      (x += this._textData.width + t));
  }
  this._hyperlinkData &&
    (this._hyperlinkData.node.x(x).y((p - this._hyperlinkData.height) / 2),
    b.add(this._hyperlinkData.node),
    (x += this._hyperlinkData.width + t));
  let ne = new q();
  if (v)
    if (d) {
      let e = 0;
      (this._tagData.forEach((n) => {
        (n.node.x(e).y((_ - n.height) / 2), ne.add(n.node), (e += n.width + t));
      }),
        ne.x((f - g) / 2).y(h - _),
        b.add(ne));
    } else {
      let e = 0;
      (this._tagData.forEach((n) => {
        (n.node.x(x + e).y((p - n.height) / 2),
          ne.add(n.node),
          (e += n.width + t));
      }),
        b.add(ne),
        (x += e));
    }
  if (
    (this._noteData &&
      (this._noteData.node.x(x).y((p - this._noteData.height) / 2),
      b.add(this._noteData.node),
      (x += this._noteData.width + t)),
    this._attachmentData &&
      (this._attachmentData.node.x(x).y((p - this._attachmentData.height) / 2),
      b.add(this._attachmentData.node),
      (x += this._attachmentData.width + t)),
    this._postfixData)
  ) {
    let e = Pa({
      el: this._postfixData.el,
      width: this._postfixData.width,
      height: this._postfixData.height,
    });
    (e.x(x).y((p - this._postfixData.height) / 2),
      b.add(e),
      (x += this._postfixData.width + t));
  }
  (this.mindMap.nodeInnerPostfixList.forEach((e) => {
    let n = this[`_${e.name}Data`];
    n && (n.node.x(x).y((p - n.height) / 2), b.add(n.node), (x += n.width + t));
  }),
    this.group.add(b));
  let { width: re, height: ie } = b.bbox(),
    S = 0,
    C = 0;
  switch (u) {
    case c.TOP:
      ((S = r / 2 - re / 2),
        (C = o + ee + this.getImgTextMarin(`v`, 0, 0, ee, h)));
      break;
    case c.BOTTOM:
      ((S = r / 2 - re / 2), (C = o));
      break;
    case c.LEFT:
      ((S = y + a + this.getImgTextMarin(`h`, y, f)), (C = i / 2 - ie / 2));
      break;
    case c.RIGHT:
      ((S = a), (C = i / 2 - ie / 2));
      break;
  }
  if (
    (b.translate(S, C),
    this.addHoverNode(r, i),
    this._customContentAddToNodeAdd && this._customContentAddToNodeAdd.el)
  ) {
    let e = Pa(this._customContentAddToNodeAdd);
    (this.group.add(e),
      n &&
        typeof n.handle == `function` &&
        n.handle({
          content: this._customContentAddToNodeAdd,
          element: e,
          node: this,
        }));
  }
  this.mindMap.emit(`node_layout_end`, this);
}
var Es = {
    getImgTextMarin: bs,
    getTagContentSize: xs,
    getNodeRect: Ss,
    addHoverNode: Cs,
    layout: Ts,
    customNodeContentRealtimeLayout: ws,
  },
  Ds = class e {
    constructor(e = {}) {
      ((this.opt = e),
        (this.nodeData = this.handleData(e.data || {})),
        (this.nodeDataSnapshot = ``),
        (this.uid = e.uid),
        (this.mindMap = e.mindMap),
        (this.renderer = e.renderer),
        (this.draw = this.mindMap.draw),
        (this.nodeDraw = this.mindMap.nodeDraw),
        (this.lineDraw = this.mindMap.lineDraw),
        (this.style = new Ha(this)),
        (this.effectiveStyles = {}),
        (this.shapeInstance = new Ua(this)),
        (this.shapePadding = { paddingX: 0, paddingY: 0 }),
        (this.isRoot = e.isRoot === void 0 ? !1 : e.isRoot),
        (this.isGeneralization =
          e.isGeneralization === void 0 ? !1 : e.isGeneralization),
        (this.generalizationBelongNode = null),
        (this.layerIndex = e.layerIndex === void 0 ? 0 : e.layerIndex),
        (this.width = e.width || 0),
        (this.height = e.height || 0),
        (this.customTextWidth = e.data.data.customTextWidth || void 0),
        (this._left = e.left || 0),
        (this._top = e.top || 0),
        (this.customLeft = e.data.data.customLeft || void 0),
        (this.customTop = e.data.data.customTop || void 0),
        (this.isDrag = !1),
        (this.parent = e.parent || null),
        (this.children = e.children || []),
        (this.userList = []),
        (this.group = null),
        (this.shapeNode = null),
        (this.hoverNode = null),
        (this._customNodeContent = null),
        (this._imgData = null),
        (this._iconData = null),
        (this._textData = null),
        (this._hyperlinkData = null),
        (this._tagData = null),
        (this._noteData = null),
        (this.noteEl = null),
        (this.noteContentIsShow = !1),
        (this._attachmentData = null),
        (this._prefixData = null),
        (this._postfixData = null),
        (this._expandBtn = null),
        (this._lastExpandBtnType = null),
        (this._showExpandBtn = !1),
        (this._openExpandNode = null),
        (this._closeExpandNode = null),
        (this._fillExpandNode = null),
        (this._userListGroup = null),
        (this._lines = []),
        (this._generalizationList = []),
        (this._unVisibleRectRegionNode = null),
        (this._isMouseenter = !1),
        (this._customContentAddToNodeAdd = null),
        (this._rectInfo = {
          textContentWidth: 0,
          textContentHeight: 0,
          textContentWidthWithoutTag: 0,
        }),
        (this._generalizationNodeWidth = 0),
        (this._generalizationNodeHeight = 0),
        (this.expandBtnSize = this.mindMap.opt.expandBtnSize),
        (this.isMultipleChoice = !1),
        (this.needLayout = !1),
        (this.isHide = !1));
      let t = Object.getPrototypeOf(this);
      ((t.bindEvent ||=
        (Object.keys(Es).forEach((e) => {
          t[e] = Es[e];
        }),
        Object.keys(ao).forEach((e) => {
          t[e] = ao[e];
        }),
        Object.keys(go).forEach((e) => {
          t[e] = go[e];
        }),
        Object.keys(es).forEach((e) => {
          t[e] = es[e];
        }),
        Object.keys(Oo).forEach((e) => {
          t[e] = Oo[e];
        }),
        Object.keys(Xo).forEach((e) => {
          t[e] = Xo[e];
        }),
        this.mindMap.cooperate &&
          Object.keys(ms).forEach((e) => {
            t[e] = ms[e];
          }),
        Object.keys(os).forEach((e) => {
          t[e] = os[e];
        }),
        this.mindMap.opt.isShowCreateChildBtnIcon &&
          (Object.keys(ys).forEach((e) => {
            t[e] = ys[e];
          }),
          this.initQuickCreateChildBtn()),
        !0)),
        this.getSize(),
        this.updateGeneralization(),
        this.initDragHandle());
    }
    get left() {
      return this.customLeft || this._left;
    }
    set left(e) {
      this._left = e;
    }
    get top() {
      return this.customTop || this._top;
    }
    set top(e) {
      this._top = e;
    }
    reset() {
      ((this.children = []),
        (this.parent = null),
        (this.isRoot = !1),
        (this.layerIndex = 0),
        (this.left = 0),
        (this.top = 0));
    }
    resetWhenDelete() {
      this._isMouseenter = !1;
    }
    handleData(e) {
      return (
        (e.data.expand = e.data.expand !== !1),
        (e.data.isActive = e.data.isActive === !0),
        (e.children = e.children || []),
        e
      );
    }
    createNodeData(e) {
      let {
          isUseCustomNodeContent: t,
          customCreateNodeContent: n,
          createNodePrefixContent: r,
          createNodePostfixContent: i,
          addCustomContentToNode: a,
        } = this.mindMap.opt,
        o = [
          `custom`,
          `image`,
          `icon`,
          `text`,
          `hyperlink`,
          `tag`,
          `note`,
          `attachment`,
          `prefix`,
          `postfix`,
          ...this.mindMap.nodeInnerPrefixList.map((e) => e.name),
          ...this.mindMap.nodeInnerPostfixList.map((e) => e.name),
        ],
        s = {};
      if (
        (Array.isArray(e)
          ? o.forEach((t) => {
              e.includes(t) && (s[t] = !0);
            })
          : o.forEach((e) => {
              s[e] = !0;
            }),
        t && n && s.custom && (this._customNodeContent = n(this)),
        this._customNodeContent)
      ) {
        Ia(this._customNodeContent);
        return;
      }
      (s.image && (this._imgData = this.createImgNode()),
        s.icon && (this._iconData = this.createIconNode()),
        s.text && (this._textData = this.createTextNode()),
        s.hyperlink && (this._hyperlinkData = this.createHyperlinkNode()),
        s.tag && (this._tagData = this.createTagNode()),
        s.note && (this._noteData = this.createNoteNode()),
        s.attachment && (this._attachmentData = this.createAttachmentNode()),
        this.mindMap.nodeInnerPrefixList.forEach((e) => {
          s[e.name] && (this[`_${e.name}Data`] = e.createContent(this));
        }),
        s.prefix &&
          ((this._prefixData = r ? r(this) : null),
          this._prefixData && this._prefixData.el && Ia(this._prefixData.el)),
        s.postfix &&
          ((this._postfixData = i ? i(this) : null),
          this._postfixData &&
            this._postfixData.el &&
            Ia(this._postfixData.el)),
        this.mindMap.nodeInnerPostfixList.forEach((e) => {
          s[e.name] && (this[`_${e.name}Data`] = e.createContent(this));
        }),
        a &&
          typeof a.create == `function` &&
          ((this._customContentAddToNodeAdd = a.create(this)),
          this._customContentAddToNodeAdd &&
            this._customContentAddToNodeAdd.el &&
            Ia(this._customContentAddToNodeAdd.el)));
    }
    getSize(e, t = {}) {
      (t.ignoreUpdateCustomTextWidth ||
        (this.customTextWidth = this.getData(`customTextWidth`) || void 0),
        (this.customLeft = this.getData(`customLeft`) || void 0),
        (this.customTop = this.getData(`customTop`) || void 0),
        this.createNodeData(e));
      let { width: n, height: r } = this.getNodeRect(),
        i = this.width !== n || this.height !== r;
      return ((this.width = n), (this.height = r), i);
    }
    bindGroupEvent() {
      (this.group.on(`click`, (e) => {
        if ((this.mindMap.emit(`node_click`, this, e), this.isMultipleChoice)) {
          (e.stopPropagation(), (this.isMultipleChoice = !1));
          return;
        }
        (this.mindMap.opt.onlyOneEnableActiveNodeOnCooperate &&
          this.userList.length > 0) ||
          this.active(e);
      }),
        this.group.on(`mousedown`, (e) => {
          let {
            readonly: t,
            enableCtrlKeyNodeSelection: n,
            useLeftKeySelectionRightKeyDrag: r,
            mousedownEventPreventDefault: i,
          } = this.mindMap.opt;
          if (
            (i && e.preventDefault(),
            t ||
              (this.isRoot
                ? e.which === 3 && !r && e.stopPropagation()
                : e.which !== 2 && e.stopPropagation()),
            !t && (e.ctrlKey || e.metaKey) && n)
          ) {
            this.isMultipleChoice = !0;
            let e = this.getData(`isActive`);
            (e ||
              this.mindMap.emit(
                `before_node_active`,
                this,
                this.renderer.activeNodeList,
              ),
              this.mindMap.renderer[
                e ? `removeNodeFromActiveList` : `addNodeToActiveList`
              ](this, !0),
              this.renderer.emitNodeActiveEvent(e ? null : this));
          }
          this.mindMap.emit(`node_mousedown`, this, e);
        }),
        this.group.on(`mouseup`, (e) => {
          (!this.isRoot &&
            e.which !== 2 &&
            !this.mindMap.opt.readonly &&
            e.stopPropagation(),
            this.mindMap.emit(`node_mouseup`, this, e));
        }),
        this.group.on(`mouseenter`, (e) => {
          this.isDrag ||
            ((this._isMouseenter = !0),
            this.showExpandBtn(),
            this.isGeneralization && this.handleGeneralizationMouseenter(),
            this.mindMap.emit(`node_mouseenter`, this, e));
        }),
        this.group.on(`mouseleave`, (e) => {
          this._isMouseenter &&
            ((this._isMouseenter = !1),
            this.hideExpandBtn(),
            this.isGeneralization && this.handleGeneralizationMouseleave(),
            this.mindMap.emit(`node_mouseleave`, this, e));
        }),
        this.group.on(`dblclick`, (e) => {
          let { readonly: t, onlyOneEnableActiveNodeOnCooperate: n } =
            this.mindMap.opt;
          t ||
            e.ctrlKey ||
            e.metaKey ||
            (e.stopPropagation(),
            !(n && this.userList.length > 0) &&
              this.mindMap.emit(`node_dblclick`, this, e));
        }),
        this.group.on(`contextmenu`, (e) => {
          let { readonly: t, useLeftKeySelectionRightKeyDrag: n } =
            this.mindMap.opt;
          t ||
            e.ctrlKey ||
            (e.stopPropagation(),
            e.preventDefault(),
            !(
              this.mindMap.select &&
              !n &&
              this.mindMap.select.hasSelectRange()
            ) &&
              ((this.getData(`isActive`) &&
                this.renderer.activeNodeList.length === 1) ||
                (this.renderer.clearActiveNodeList(), this.active(e)),
              this.mindMap.emit(`node_contextmenu`, e, this)));
        }));
    }
    active(e) {
      this.mindMap.opt.readonly ||
        (e && e.stopPropagation(),
        !this.getData(`isActive`) &&
          (this.mindMap.emit(
            `before_node_active`,
            this,
            this.renderer.activeNodeList,
          ),
          this.renderer.clearActiveNodeList(),
          this.renderer.addNodeToActiveList(this, !0),
          this.renderer.emitNodeActiveEvent(this)));
    }
    deactivate() {
      (this.mindMap.renderer.removeNodeFromActiveList(this),
        this.mindMap.renderer.emitNodeActiveEvent());
    }
    update(e) {
      if (!this.group) return;
      this.updateNodeActiveClass();
      let {
          alwaysShowExpandBtn: t,
          notShowExpandBtn: n,
          isShowCreateChildBtnIcon: r,
          readonly: i,
        } = this.mindMap.opt,
        a = this.getChildrenLength();
      if (!n)
        if (t)
          this._expandBtn && a <= 0
            ? this.removeExpandBtn()
            : this.renderExpandBtn();
        else {
          let { isActive: e, expand: t } = this.getData();
          a <= 0
            ? this.removeExpandBtn()
            : t && !e && !this._isMouseenter
              ? this.hideExpandBtn()
              : this.showExpandBtn();
        }
      if (r)
        if (a > 0) this.removeQuickCreateChildBtn();
        else {
          let { isActive: e } = this.getData();
          e ? this.showQuickCreateChildBtn() : this.hideQuickCreateChildBtn();
        }
      (this.updateDragHandle(),
        this.renderGeneralization(e),
        this.updateUserListNode && this.updateUserListNode());
      let o = this.group.transform();
      ((this.nodeDataSnapshot = i ? `` : JSON.stringify(this.getData())),
        (this.left !== o.translateX || this.top !== o.translateY) &&
          this.group.translate(
            this.left - o.translateX,
            this.top - o.translateY,
          ));
    }
    getNodePosInClient(e, t) {
      let {
        scaleX: n,
        scaleY: r,
        translateX: i,
        translateY: a,
      } = this.mindMap.draw.transform();
      return { left: e * n + i, top: t * r + a };
    }
    checkIsInClient(e = 0) {
      let { left: t, top: n } = this.getNodePosInClient(this.left, this.top);
      return (
        t + this.width > 0 - e &&
        n + this.height > 0 - e &&
        t < this.mindMap.width + e &&
        n < this.mindMap.height + e
      );
    }
    reRender(e, t) {
      let n = this.getSize(e, t);
      return (this.layout(), this.update(), n);
    }
    updateNodeActiveClass() {
      if (!this.group) return;
      let e = this.getData(`isActive`);
      this.group[e ? `addClass` : `removeClass`](`active`);
    }
    updateNodeByActive(e) {
      if (this.group) {
        let { isShowCreateChildBtnIcon: t } = this.mindMap.opt;
        (e
          ? (this.showExpandBtn(), t && this.showQuickCreateChildBtn())
          : (this.hideExpandBtn(), t && this.hideQuickCreateChildBtn()),
          this.updateNodeActiveClass(),
          this.updateDragHandle());
      }
    }
    render(e = () => {}, t = !1, n = !1) {
      this.renderLine();
      let { openPerformance: r, performanceConfig: i } = this.mindMap.opt;
      if (
        (t || !r || this.checkIsInClient(i.padding) || this.isRoot
          ? this.group
            ? (this.nodeDraw.has(this.group) || this.nodeDraw.add(this.group),
              this.needLayout && ((this.needLayout = !1), this.layout()),
              this.updateExpandBtnPlaceholderRect(),
              this.update(t))
            : ((this.group = new q()),
              this.group.addClass(`smm-node`),
              this.group.css({ cursor: `default` }),
              this.bindGroupEvent(),
              this.nodeDraw.add(this.group),
              this.layout(),
              this.update(t))
          : r && i.removeNodeWhenOutCanvas && this.removeSelf(),
        this.children && this.children.length && this.getData(`expand`) !== !1)
      ) {
        let r = 0;
        this.children.forEach((i) => {
          let a = () => {
            i.render(
              () => {
                (r++, r >= this.children.length && e());
              },
              t,
              n,
            );
          };
          n ? setTimeout(a, 0) : a();
        });
      } else e();
      this.nodeData.inserting &&
        (delete this.nodeData.inserting,
        this.active(),
        this.mindMap.emit(`node_dblclick`, this, null, !0));
    }
    removeSelf() {
      this.group && (this.group.remove(), this.removeGeneralization());
    }
    remove() {
      this.group &&
        (this.group.remove(),
        this.removeGeneralization(),
        this.removeLine(),
        this.children &&
          this.children.length &&
          this.children.forEach((e) => {
            e.remove();
          }));
    }
    destroy() {
      (this.removeLine(),
        this.parent && this.parent.removeLine(),
        this.group &&
          (this.emptyUser && this.emptyUser(),
          this.resetWhenDelete(),
          this.group.remove(),
          this.removeGeneralization(),
          (this.group = null),
          this.style.onRemove()));
    }
    hide() {
      if (
        (this.group && this.group.hide(),
        this.hideGeneralization(),
        this.parent)
      ) {
        let e = this.parent.children.indexOf(this);
        (this.parent._lines[e] && this.parent._lines[e].hide(),
          this._lines.forEach((e) => {
            e.hide();
          }));
      }
      this.children &&
        this.children.length &&
        this.children.forEach((e) => {
          e.hide();
        });
    }
    show() {
      if (this.group) {
        if ((this.group.show(), this.showGeneralization(), this.parent)) {
          let e = this.parent.children.indexOf(this);
          (this.parent._lines[e] && this.parent._lines[e].show(),
            this._lines.forEach((e) => {
              e.show();
            }));
        }
        this.children &&
          this.children.length &&
          this.children.forEach((e) => {
            e.show();
          });
      }
    }
    setOpacity(e) {
      (this.group && this.group.opacity(e),
        this._lines.forEach((t) => {
          t.opacity(e);
        }),
        this.children.forEach((t) => {
          t.setOpacity(e);
        }),
        this.setGeneralizationOpacity(e));
    }
    hideChildren() {
      (this._lines.forEach((e) => {
        e.hide();
      }),
        this.children &&
          this.children.length &&
          this.children.forEach((e) => {
            e.hide();
          }));
    }
    showChildren() {
      (this._lines.forEach((e) => {
        e.show();
      }),
        this.children &&
          this.children.length &&
          this.children.forEach((e) => {
            e.show();
          }));
    }
    startDrag() {
      ((this.isDrag = !0),
        this.group && this.group.addClass(`smm-node-dragging`));
    }
    endDrag() {
      ((this.isDrag = !1),
        this.group && this.group.removeClass(`smm-node-dragging`));
    }
    renderLine(e = !1) {
      if (this.getData(`expand`) === !1) return;
      let t = this.getChildrenLength();
      (this.mindMap.renderer.layout.nodeIsRemoveAllLines &&
        this.mindMap.renderer.layout.nodeIsRemoveAllLines(this) &&
        (t = 0),
        t > this._lines.length
          ? Array(t - this._lines.length)
              .fill(0)
              .forEach(() => {
                this._lines.push(this.lineDraw.path());
              })
          : t < this._lines.length &&
            (this._lines.slice(t).forEach((e) => {
              e.remove();
            }),
            (this._lines = this._lines.slice(0, t))),
        this.renderer.layout.renderLine(
          this,
          this._lines,
          (...e) => {
            this.styleLine(...e);
          },
          this.style.getStyle(`lineStyle`, !0),
        ),
        e &&
          this.children &&
          this.children.length > 0 &&
          this.children.forEach((t) => {
            t.renderLine(e);
          }));
    }
    getShape() {
      return this.mindMap.themeConfig.nodeUseLineStyle
        ? w.SHAPE.RECTANGLE
        : this.style.getStyle(`shape`, !1, !1);
    }
    hasCustomPosition() {
      return this.customLeft !== void 0 && this.customTop !== void 0;
    }
    ancestorHasCustomPosition() {
      let e = this;
      for (; e;) {
        if (e.hasCustomPosition()) return !0;
        e = e.parent;
      }
      return !1;
    }
    ancestorHasGeneralization() {
      let e = this.parent;
      for (; e;) {
        if (e.checkHasGeneralization()) return !0;
        e = e.parent;
      }
      return !1;
    }
    addChildren(e) {
      this.children.push(e);
    }
    styleLine(e, t, n) {
      let { enableInheritAncestorLineStyle: r } = this.mindMap.opt,
        i = r ? `getSelfInhertStyle` : `getSelfStyle`,
        a = t[i](`lineWidth`) || t.getStyle(`lineWidth`, !0),
        o =
          t[i](`lineColor`) ||
          this.getRainbowLineColor(t) ||
          t.getStyle(`lineColor`, !0),
        s = t[i](`lineDasharray`) || t.getStyle(`lineDasharray`, !0);
      this.style.line(e, { width: a, color: o, dasharray: s }, n, t);
    }
    getRainbowLineColor(e) {
      return this.mindMap.rainbowLines
        ? this.mindMap.rainbowLines.getNodeColor(e)
        : ``;
    }
    removeLine() {
      (this._lines.forEach((e) => {
        e.remove();
      }),
        (this._lines = []));
    }
    isAncestor(e) {
      if (this.uid === e.uid) return !1;
      let t = e.parent;
      for (; t;) {
        if (this.uid === t.uid) return !0;
        t = t.parent;
      }
      return !1;
    }
    isParent(e) {
      if (this.uid === e.uid) return !1;
      let t = e.parent;
      return !!(t && this.uid === t.uid);
    }
    isBrother(e) {
      return !this.parent || this.uid === e.uid
        ? !1
        : this.parent.children.find((t) => t.uid === e.uid);
    }
    getIndexInBrothers() {
      return this.parent && this.parent.children
        ? this.parent.children.findIndex((e) => e.uid === this.uid)
        : -1;
    }
    getPaddingVale() {
      return {
        paddingX: this.getStyle(`paddingX`),
        paddingY: this.getStyle(`paddingY`),
      };
    }
    getStyle(e, t) {
      let n = this.style.merge(e, t);
      return n === void 0 ? `` : n;
    }
    getSelfStyle(e) {
      return this.style.getSelfStyle(e);
    }
    getParentSelfStyle(e) {
      return this.parent
        ? this.parent.getSelfStyle(e) || this.parent.getParentSelfStyle(e)
        : null;
    }
    getSelfInhertStyle(e) {
      return this.getSelfStyle(e) || this.getParentSelfStyle(e);
    }
    getBorderWidth() {
      return this.style.merge(`borderWidth`, !1) || 0;
    }
    getData(e) {
      return e ? this.nodeData.data[e] : this.nodeData.data;
    }
    getPureData(e = !0, t = !1) {
      return Bi({}, this, e, t);
    }
    getAncestorNodes() {
      let e = [],
        t = this.parent;
      for (; t;) (e.unshift(t), (t = t.parent));
      return e;
    }
    hasCustomStyle() {
      return this.style.hasCustomStyle();
    }
    getRect() {
      return this.group ? this.group.rbox() : null;
    }
    getRectInSvg() {
      let {
          scaleX: e,
          scaleY: t,
          translateX: n,
          translateY: r,
        } = this.mindMap.draw.transform(),
        { left: i, top: a, width: o, height: s } = this,
        c = (i + o) * e + n,
        l = (a + s) * t + r;
      return (
        (i = i * e + n),
        (a = a * t + r),
        { left: i, right: c, top: a, bottom: l, width: o * e, height: s * t }
      );
    }
    highlight() {
      this.group && this.group.addClass(`smm-node-highlight`);
    }
    closeHighlight() {
      this.group && this.group.removeClass(`smm-node-highlight`);
    }
    fakeClone() {
      let t = new e({ ...this.opt, uid: Zi() });
      return (
        Object.keys(this).forEach((e) => {
          t[e] = this[e];
        }),
        t
      );
    }
    createSvgTextNode(e = ``) {
      return new K().text(e);
    }
    getSvgObjects() {
      return { SVG: J, G: q, Rect: W };
    }
    checkEnableDragModifyNodeWidth() {
      let {
        enableDragModifyNodeWidth: e,
        isUseCustomNodeContent: t,
        customCreateNodeContent: n,
      } = this.mindMap.opt;
      return e && (this.mindMap.richText || (t && n));
    }
    hasCustomWidth() {
      return (
        this.checkEnableDragModifyNodeWidth() && this.customTextWidth !== void 0
      );
    }
    getChildrenLength() {
      return this.nodeData.children ? this.nodeData.children.length : 0;
    }
  },
  Os = class {
    constructor(e) {
      ((this.max = e || 1e3), (this.size = 0), (this.pool = new Map()));
    }
    add(e, t) {
      return !this.has(e) && this.size >= this.max
        ? !1
        : (this.delete(e), this.pool.set(e, t), this.size++, !0);
    }
    delete(e) {
      this.pool.has(e) && (this.pool.delete(e), this.size--);
    }
    has(e) {
      return this.pool.has(e);
    }
    get(e) {
      if (this.pool.has(e)) return this.pool.get(e);
    }
    clear() {
      ((this.size = 0), (this.pool = new Map()));
    }
  },
  ks = class {
    constructor(e) {
      ((this.renderer = e),
        (this.mindMap = e.mindMap),
        (this.draw = this.mindMap.draw),
        (this.lineDraw = this.mindMap.lineDraw),
        (this.root = null),
        (this.lru = new Os(this.mindMap.opt.maxNodeCacheCount)),
        (this.rootNodeCenterOffset = null));
    }
    doLayout() {
      throw Error(`【computed】方法为必要方法，需要子类进行重写！`);
    }
    renderLine() {
      throw Error(`【renderLine】方法为必要方法，需要子类进行重写！`);
    }
    renderExpandBtn() {
      throw Error(`【renderExpandBtn】方法为必要方法，需要子类进行重写！`);
    }
    renderGeneralization() {}
    cacheNode(e, t) {
      ((this.renderer.nodeCache[e] = t), this.lru.add(e, t));
    }
    checkIsNeedResizeSources() {
      return this.renderer.checkHasRenderSource(w.CHANGE_THEME);
    }
    checkIsLayerTypeChange(e, t) {
      if (e >= 2 && t >= 2) return !1;
      if ((e >= 2 && t < 2) || (e < 2 && t >= 2)) return !0;
    }
    checkIsLayoutChangeRerenderExpandBtnPlaceholderRect(e) {
      this.renderer.checkHasRenderSource(w.CHANGE_LAYOUT) &&
        (e.needRerenderExpandBtnPlaceholderRect = !0);
    }
    checkIsNodeDataChange(e, t) {
      if (e)
        ((e = typeof e == `string` ? JSON.parse(e) : e),
          (e.isActive = t.isActive),
          (e.expand = t.expand),
          (e = JSON.stringify(e)));
      else return !1;
      return e !== JSON.stringify(t);
    }
    checkNodeFixChange(e, t, n) {
      let r = !1;
      this.mindMap.nodeInnerPrefixList.forEach((n) => {
        if (n.updateNodeData) {
          let i = n.updateNodeData(e, t);
          i && (r = i);
        }
      });
      let i = !1;
      return (
        this.mindMap.nodeInnerPostfixList.forEach((t) => {
          if (t.updateNodeData) {
            let r = t.updateNodeData(e, n);
            r && (i = r);
          }
        }),
        r || i
      );
    }
    createNode(e, t, n, r, i, a) {
      let o = {};
      this.mindMap.nodeInnerPrefixList.forEach((n) => {
        if (n.createNodeData) {
          let [s, c] = n.createNodeData({
            data: e,
            parent: t,
            ancestors: a,
            layerIndex: r,
            index: i,
          });
          o[s] = c;
        }
      });
      let s = {};
      this.mindMap.nodeInnerPostfixList.forEach((n) => {
        if (n.createNodeData) {
          let [o, c] = n.createNodeData({
            data: e,
            parent: t,
            ancestors: a,
            layerIndex: r,
            index: i,
          });
          s[o] = c;
        }
      });
      let c = e.data.uid,
        l = null;
      if (e && e._node && !this.renderer.reRender) {
        l = e._node;
        let i = this.checkIsLayerTypeChange(l.layerIndex, r);
        (l.reset(),
          (l.layerIndex = r),
          n ? (l.isRoot = !0) : (l.parent = t._node),
          this.cacheNode(e._node.uid, l),
          this.checkIsLayoutChangeRerenderExpandBtnPlaceholderRect(l));
        let a = this.checkNodeFixChange(l, o, s),
          c = this.checkIsNeedResizeSources(),
          u = this.checkIsNodeDataChange(e._node.nodeDataSnapshot, e.data);
        ((c ||
          u ||
          i ||
          (l.getData(`resetRichText`) && !l.isUseCustomNodeContent()) ||
          l.getData(`needUpdate`) ||
          a) &&
          (l.getSize(), (l.needLayout = !0)),
          this.checkGetGeneralizationChange(l, c));
      } else if (
        (this.lru.has(c) || this.renderer.lastNodeCache[c]) &&
        !this.renderer.reRender
      ) {
        l = this.lru.get(c) || this.renderer.lastNodeCache[c];
        let i = JSON.stringify(l.getData()),
          a = this.checkIsLayerTypeChange(l.layerIndex, r);
        (l.reset(),
          (l.nodeData = l.handleData(e || {})),
          (l.layerIndex = r),
          n ? (l.isRoot = !0) : (l.parent = t._node),
          this.cacheNode(c, l),
          this.checkIsLayoutChangeRerenderExpandBtnPlaceholderRect(l),
          (e._node = l));
        let u = this.checkIsNeedResizeSources(),
          d = this.checkIsNodeDataChange(i, e.data),
          f = this.checkNodeFixChange(l, o, s);
        ((u ||
          d ||
          a ||
          (l.getData(`resetRichText`) && !l.isUseCustomNodeContent()) ||
          l.getData(`needUpdate`) ||
          f) &&
          (l.getSize(), (l.needLayout = !0)),
          this.checkGetGeneralizationChange(l, u));
      } else {
        let i = c || Zi();
        ((l = new Ds({
          data: e,
          uid: i,
          renderer: this.renderer,
          mindMap: this.mindMap,
          draw: this.draw,
          layerIndex: r,
          isRoot: n,
          parent: n ? null : t._node,
          ...o,
        })),
          (e.data.uid = i),
          this.cacheNode(i, l),
          (e._node = l));
      }
      return (
        e.data.isActive && this.renderer.addNodeToActiveList(l),
        this.mindMap.renderer.findActiveNodeIndex(l) !== -1 &&
          l.setData({ isActive: !0 }),
        n ? (this.root = l) : t._node.addChildren(l),
        l
      );
    }
    checkGetGeneralizationChange(e, t) {
      let n = e.getData(`generalization`);
      n &&
        e._generalizationList &&
        e._generalizationList.length > 0 &&
        e._generalizationList.forEach((e, r) => {
          let i = e.generalizationNode,
            a = i.getData(),
            o = n[r];
          (t || (o && JSON.stringify(a) !== JSON.stringify(o))) &&
            (o && (i.nodeData.data = o), i.getSize(), (i.needLayout = !0));
        });
    }
    formatPosition(e, t, n) {
      return typeof e == `number`
        ? e
        : le[e] === void 0
          ? /^\d\d*%$/.test(e)
            ? (Number.parseFloat(e) / 100) * t
            : (t - n) / 2
          : t * le[e];
    }
    formatInitRootNodePosition(e) {
      let { CENTER: t } = w.INIT_ROOT_NODE_POSITION;
      return ((!e || !Array.isArray(e) || e.length < 2) && (e = [t, t]), e);
    }
    setNodeCenter(e, t) {
      let { initRootNodePosition: n } = this.mindMap.opt;
      ((n = this.formatInitRootNodePosition(t || n)),
        (e.left = this.formatPosition(n[0], this.mindMap.width, e.width)),
        (e.top = this.formatPosition(n[1], this.mindMap.height, e.height)));
    }
    getRootCenterOffset(e, t) {
      if (this.rootNodeCenterOffset) return this.rootNodeCenterOffset;
      let { initRootNodePosition: n } = this.mindMap.opt,
        { CENTER: r } = w.INIT_ROOT_NODE_POSITION;
      if (((n = this.formatInitRootNodePosition(n)), n[0] === r && n[1] === r))
        this.rootNodeCenterOffset = { x: 0, y: 0 };
      else {
        let n = { width: e, height: t },
          i = { width: e, height: t };
        (this.setNodeCenter(n, [r, r]),
          this.setNodeCenter(i),
          (this.rootNodeCenterOffset = {
            x: i.left - n.left,
            y: i.top - n.top,
          }));
      }
      return this.rootNodeCenterOffset;
    }
    updateChildren(e, t, n) {
      e.forEach((e) => {
        ((e[t] += n),
          e.children &&
            e.children.length &&
            !e.hasCustomPosition() &&
            this.updateChildren(e.children, t, n));
      });
    }
    updateChildrenPro(e, t) {
      e.forEach((e) => {
        (Object.keys(t).forEach((n) => {
          e[n] += t[n];
        }),
          e.children &&
            e.children.length &&
            !e.hasCustomPosition() &&
            this.updateChildrenPro(e.children, t));
      });
    }
    getNodeAreaWidth(e, t = !1) {
      let n = [],
        r = 0,
        i = (e, a) => {
          (t && e.checkHasGeneralization() && (r += e._generalizationNodeWidth),
            e.children.length
              ? ((a += e.width / 2),
                e.children.forEach((e) => {
                  i(e, a);
                }))
              : ((a += e.width), n.push(a)));
        };
      return (i(e, 0), Math.max(...n) + r);
    }
    quadraticCurvePath(e, t, n, r, i = !1) {
      let a, o;
      return (
        i
          ? ((a = e + (n - e) * 0.8), (o = t + (r - t) * 0.2))
          : ((a = e + (n - e) * 0.2), (o = t + (r - t) * 0.8)),
        `M ${e},${t} Q ${a},${o} ${n},${r}`
      );
    }
    cubicBezierPath(e, t, n, r, i = !1) {
      let a, o, s, c;
      return (
        i
          ? ((a = e), (o = t + (r - t) / 2), (s = n), (c = o))
          : ((a = e + (n - e) / 2), (o = t), (s = a), (c = r)),
        `M ${e},${t} C ${a},${o} ${s},${c} ${n},${r}`
      );
    }
    computeNewPoint(e, t, n = 0) {
      if (e[0] === t[0])
        return t[1] > e[1] ? [t[0], t[1] - n] : [t[0], t[1] + n];
      if (e[1] === t[1])
        return t[0] > e[0] ? [t[0] - n, t[1]] : [t[0] + n, t[1]];
    }
    createFoldLine(e) {
      let { lineRadius: t } = this.mindMap.themeConfig,
        n = e.length,
        r = ``,
        i = ``;
      if (n >= 3 && t > 0) {
        let r = e[n - 3],
          a = e[n - 2],
          o = e[n - 1];
        if (!(
          (r[0].toFixed(0) === a[0].toFixed(0) &&
            a[0].toFixed(0) === o[0].toFixed(0)) ||
          (r[1].toFixed(0) === a[1].toFixed(0) &&
            a[1].toFixed(0) === o[1].toFixed(0))
        )) {
          let s = this.computeNewPoint(r, a, t),
            c = this.computeNewPoint(o, a, t);
          ((i = `Q ${a[0]},${a[1]} ${c[0]},${c[1]}`), e.splice(n - 2, 1, s, i));
        }
      }
      return (
        e.forEach((e, t) => {
          if (typeof e == `string`) r += e;
          else {
            let [n, i] = e;
            t === 0 ? (r += `M ${n},${i}`) : (r += `L ${n},${i}`);
          }
        }),
        r
      );
    }
    getMarginX(e) {
      let { themeConfig: t, opt: n } = this.mindMap,
        { second: r, node: i } = t,
        a = n.hoverRectPadding * 2;
      return e === 1 ? r.marginX + a : i.marginX + a;
    }
    getMarginY(e) {
      let { themeConfig: t, opt: n } = this.mindMap,
        { second: r, node: i } = t,
        a = n.hoverRectPadding * 2;
      return e === 1 ? r.marginY + a : i.marginY + a;
    }
    getNodeWidthWithGeneralization(e) {
      return Math.max(
        e.width,
        e.checkHasGeneralization() ? e._generalizationNodeWidth : 0,
      );
    }
    getNodeHeightWithGeneralization(e) {
      return Math.max(
        e.height,
        e.checkHasGeneralization() ? e._generalizationNodeHeight : 0,
      );
    }
    getNodeBoundaries(e, t) {
      let { generalizationLineMargin: n, generalizationNodeMargin: r } =
          this.mindMap.themeConfig,
        i = (e) => {
          let n = 1 / 0,
            a = -1 / 0,
            o = 1 / 0,
            s = -1 / 0;
          e.children &&
            e.children.length > 0 &&
            e.children.forEach((e) => {
              let { left: c, right: l, top: u, bottom: d } = i(e),
                f =
                  e.checkHasGeneralization() && e.getData(`expand`)
                    ? e._generalizationNodeWidth + r
                    : 0,
                p =
                  e.checkHasGeneralization() && e.getData(`expand`)
                    ? e._generalizationNodeHeight + r
                    : 0;
              (c - (t === `h` ? f : 0) < n && (n = c - (t === `h` ? f : 0)),
                l + (t === `h` ? f : 0) > a && (a = l + (t === `h` ? f : 0)),
                u < o && (o = u),
                d + (t === `v` ? p : 0) > s && (s = d + (t === `v` ? p : 0)));
            });
          let c = {
            left: e.left,
            right: e.left + e.width,
            top: e.top,
            bottom: e.top + e.height,
          };
          return {
            left: c.left < n ? c.left : n,
            right: c.right > a ? c.right : a,
            top: c.top < o ? c.top : o,
            bottom: c.bottom > s ? c.bottom : s,
          };
        },
        { left: a, right: o, top: s, bottom: c } = i(e);
      return {
        left: a,
        right: o,
        top: s,
        bottom: c,
        generalizationLineMargin: n,
        generalizationNodeMargin: r,
      };
    }
    getChildrenBoundaries(e, t, n = 0, r) {
      let { generalizationLineMargin: i, generalizationNodeMargin: a } =
          this.mindMap.themeConfig,
        o = e.children.slice(n, r + 1),
        s = 1 / 0,
        c = -1 / 0,
        l = 1 / 0,
        u = -1 / 0;
      return (
        o.forEach((e) => {
          let n = this.getNodeBoundaries(e, t);
          ((s = n.left < s ? n.left : s),
            (c = n.right > c ? n.right : c),
            (l = n.top < l ? n.top : l),
            (u = n.bottom > u ? n.bottom : u));
        }),
        {
          left: s,
          right: c,
          top: l,
          bottom: u,
          generalizationLineMargin: i,
          generalizationNodeMargin: a,
        }
      );
    }
    getNodeGeneralizationRenderBoundaries(e, t) {
      let n = null;
      return (
        (n = e.range
          ? this.getChildrenBoundaries(e.node, t, e.range[0], e.range[1])
          : this.getNodeBoundaries(e.node, t)),
        n
      );
    }
    getNodeActChildrenLength(e) {
      return e.nodeData.children && e.nodeData.children.length;
    }
    setLineStyle(e, t, n, r) {
      (t.plot(this.transformPath(n)), e && e(t, r, !0));
    }
    transformPath(e) {
      let { customTransformNodeLinePath: t } = this.mindMap.opt;
      return t ? t(e) : e;
    }
  },
  As = class extends ks {
    constructor(e = {}, t) {
      (super(e), (this.isUseLeft = t === w.LAYOUT.LOGICAL_STRUCTURE_LEFT));
    }
    doLayout(e) {
      Ui([
        () => {
          this.computedBaseValue();
        },
        () => {
          this.computedTopValue();
        },
        () => {
          this.adjustTopValue();
        },
        () => {
          e(this.root);
        },
      ]);
    }
    computedBaseValue() {
      let e = 0;
      Y(
        this.renderer.renderTree,
        null,
        (t, n, r, i, a, o) => {
          let s = this.createNode(t, n, r, i, a, o);
          if (
            ((s.sortIndex = e),
            e++,
            r
              ? this.setNodeCenter(s)
              : this.isUseLeft
                ? (s.left = n._node.left - s.width - this.getMarginX(i))
                : (s.left = n._node.left + n._node.width + this.getMarginX(i)),
            !t.data.expand)
          )
            return !0;
        },
        (e, t, n, r) => {
          let i = e.data.expand === !1 ? 0 : e._node.children.length;
          e._node.childrenAreaHeight = i
            ? e._node.children.reduce((e, t) => e + t.height, 0) +
              (i + 1) * this.getMarginY(r + 1)
            : 0;
          let a = e._node.checkHasGeneralization()
            ? e._node._generalizationNodeHeight + this.getMarginY(r + 1)
            : 0;
          e._node.childrenAreaHeight2 = Math.max(e._node.childrenAreaHeight, a);
        },
        !0,
        0,
      );
    }
    computedTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (e.getData(`expand`) && e.children && e.children.length) {
            let t = this.getMarginY(r + 1),
              n = e.top + e.height / 2 - e.childrenAreaHeight / 2 + t;
            e.children.forEach((e) => {
              ((e.top = n), (n += e.height + t));
            });
          }
        },
        null,
        !0,
      );
    }
    adjustTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (!e.getData(`expand`)) return;
          let i = e.childrenAreaHeight2 - this.getMarginY(r + 1) * 2 - e.height;
          i > 0 && this.updateBrothers(e, i / 2);
        },
        null,
        !0,
      );
    }
    updateBrothers(e, t) {
      if (e.parent) {
        let n = e.parent.children,
          r = Q(e, n);
        (n.forEach((n, i) => {
          if (n.uid === e.uid || n.hasCustomPosition()) return;
          let a = 0;
          (i < r ? (a = -t) : i > r && (a = t),
            (n.top += a),
            n.children &&
              n.children.length &&
              this.updateChildren(n.children, `top`, a));
        }),
          this.updateBrothers(e.parent, t));
      }
    }
    renderLine(e, t, n, r) {
      r === `curve`
        ? this.renderLineCurve(e, t, n)
        : r === `direct`
          ? this.renderLineDirect(e, t, n)
          : this.renderLineStraight(e, t, n);
    }
    renderLineStraight(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      (!c || l) && (s = 0);
      let u = (this.getMarginX(e.layerIndex + 1) - s) * 0.6;
      this.isUseLeft && (u *= -1);
      let d = this.mindMap.themeConfig.nodeUseLineStyle;
      e.children.forEach((c, l) => {
        let f;
        f = this.isUseLeft
          ? e.layerIndex === 0
            ? r
            : r - s
          : e.layerIndex === 0
            ? r + a
            : r + a + s;
        let p = i + o / 2,
          m = this.isUseLeft ? c.left + c.width : c.left,
          h = c.top + c.height / 2,
          g = d ? c.width * (this.isUseLeft ? -1 : 1) : 0;
        ((p = d && !e.isRoot ? p + o / 2 : p), (h = d ? h + c.height / 2 : h));
        let _ = this.createFoldLine([
          [f, p],
          [f + u, p],
          [f + u, h],
          [m + g, h],
        ]);
        this.setLineStyle(n, t[l], _, c);
      });
    }
    renderLineDirect(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      (!c || l) && (s = 0);
      let { nodeUseLineStyle: u } = this.mindMap.themeConfig;
      e.children.forEach((c, l) => {
        e.layerIndex === 0 && (s = 0);
        let d = this.isUseLeft ? r - s : r + a + s,
          f = i + o / 2,
          p = this.isUseLeft ? c.left + c.width : c.left,
          m = c.top + c.height / 2;
        ((f = u && !e.isRoot ? f + o / 2 : f), (m = u ? m + c.height / 2 : m));
        let h = u
            ? ` L ${this.isUseLeft ? c.left : c.left + c.width},${m}`
            : ``,
          g = `M ${d},${f} L ${p},${m}` + h;
        this.setLineStyle(n, t[l], g, c);
      });
    }
    renderLineCurve(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      (!c || l) && (s = 0);
      let {
        nodeUseLineStyle: u,
        rootLineStartPositionKeepSameInCurve: d,
        rootLineKeepSameInCurve: f,
      } = this.mindMap.themeConfig;
      e.children.forEach((c, l) => {
        e.layerIndex === 0 && (s = 0);
        let p;
        p = this.isUseLeft
          ? e.layerIndex === 0 && !d
            ? r + a / 2
            : r - s
          : e.layerIndex === 0 && !d
            ? r + a / 2
            : r + a + s;
        let m = i + o / 2,
          h = this.isUseLeft ? c.left + c.width : c.left,
          g = c.top + c.height / 2,
          _ = ``;
        ((m = u && !e.isRoot ? m + o / 2 : m), (g = u ? g + c.height / 2 : g));
        let v;
        ((v = this.isUseLeft
          ? u
            ? ` L ${c.left},${g}`
            : ``
          : u
            ? ` L ${c.left + c.width},${g}`
            : ``),
          (_ =
            e.isRoot && !f
              ? this.quadraticCurvePath(p, m, h, g) + v
              : this.cubicBezierPath(p, m, h, g) + v),
          this.setLineStyle(n, t[l], _, c));
      });
    }
    renderExpandBtn(e, t) {
      let { width: n, height: r, expandBtnSize: i, layerIndex: a } = e;
      a === 0 && (i = 0);
      let { translateX: o, translateY: s } = t.transform(),
        c = this.mindMap.themeConfig.nodeUseLineStyle ? r / 2 : 0,
        l = this.isUseLeft ? 0 - i : n,
        u = r / 2 + c;
      (l === o && u === s) || t.translate(l - o, u - s);
    }
    renderGeneralization(e) {
      e.forEach((e) => {
        let {
            left: t,
            top: n,
            bottom: r,
            right: i,
            generalizationLineMargin: a,
            generalizationNodeMargin: o,
          } = this.getNodeGeneralizationRenderBoundaries(e, `h`),
          s = this.isUseLeft ? t - a : i + a,
          c = s,
          l = n,
          u = s,
          d = r,
          f = `M ${c},${l} Q ${c + (this.isUseLeft ? -20 : 20)},${l + (d - l) / 2} ${u},${d}`;
        (e.generalizationLine.plot(f),
          (e.generalizationNode.left =
            s +
            (this.isUseLeft ? -o : o) -
            (this.isUseLeft ? e.generalizationNode.width : 0)),
          (e.generalizationNode.top =
            n + (r - n - e.generalizationNode.height) / 2));
      });
    }
    renderExpandBtnRect(e, t, n, r) {
      this.isUseLeft ? e.size(t, r).x(-t).y(0) : e.size(t, r).x(n).y(0);
    }
  },
  js = class extends ks {
    constructor(e = {}) {
      super(e);
    }
    doLayout(e) {
      Ui([
        () => {
          this.computedBaseValue();
        },
        () => {
          this.computedTopValue();
        },
        () => {
          this.adjustTopValue();
        },
        () => {
          e(this.root);
        },
      ]);
    }
    computedBaseValue() {
      Y(
        this.renderer.renderTree,
        null,
        (e, t, n, r, i, a) => {
          let o = this.createNode(e, t, n, r, i, a);
          if (
            (n
              ? this.setNodeCenter(o)
              : (t._node.dir
                  ? (o.dir = t._node.dir)
                  : (o.dir =
                      o.getData(`dir`) ||
                      (i % 2 == 0
                        ? w.LAYOUT_GROW_DIR.RIGHT
                        : w.LAYOUT_GROW_DIR.LEFT)),
                (o.left =
                  o.dir === w.LAYOUT_GROW_DIR.RIGHT
                    ? t._node.left + t._node.width + this.getMarginX(r)
                    : t._node.left - this.getMarginX(r) - o.width)),
            !e.data.expand)
          )
            return !0;
        },
        (e, t, n, r) => {
          if (!e.data.expand) {
            ((e._node.leftChildrenAreaHeight = 0),
              (e._node.rightChildrenAreaHeight = 0));
            return;
          }
          let i = 0,
            a = 0,
            o = 0,
            s = 0;
          (e._node.children.forEach((e) => {
            e.dir === w.LAYOUT_GROW_DIR.LEFT
              ? (i++, (o += e.height))
              : (a++, (s += e.height));
          }),
            (e._node.leftChildrenAreaHeight =
              o + (i + 1) * this.getMarginY(r + 1)),
            (e._node.rightChildrenAreaHeight =
              s + (a + 1) * this.getMarginY(r + 1)));
          let c = e._node.checkHasGeneralization()
            ? e._node._generalizationNodeHeight + this.getMarginY(r + 1)
            : 0;
          ((e._node.leftChildrenAreaHeight2 = Math.max(
            e._node.leftChildrenAreaHeight,
            c,
          )),
            (e._node.rightChildrenAreaHeight2 = Math.max(
              e._node.rightChildrenAreaHeight,
              c,
            )));
        },
        !0,
        0,
      );
    }
    computedTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (e.getData(`expand`) && e.children && e.children.length) {
            let t = this.getMarginY(r + 1),
              n = e.top + e.height / 2 + t,
              i = n - e.leftChildrenAreaHeight / 2,
              a = n - e.rightChildrenAreaHeight / 2;
            e.children.forEach((e) => {
              e.dir === w.LAYOUT_GROW_DIR.LEFT
                ? ((e.top = i), (i += e.height + t))
                : ((e.top = a), (a += e.height + t));
            });
          }
        },
        null,
        !0,
      );
    }
    adjustTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (!e.getData(`expand`)) return;
          let i = this.getMarginY(r + 1) * 2 + e.height,
            a = e.leftChildrenAreaHeight2 - i,
            o = e.rightChildrenAreaHeight2 - i;
          (a > 0 || o > 0) && this.updateBrothers(e, a / 2, o / 2);
        },
        null,
        !0,
      );
    }
    updateBrothers(e, t, n) {
      if (e.parent) {
        let r = e.parent.children.filter((t) => t.dir === e.dir),
          i = Q(e, r);
        (r.forEach((e, r) => {
          if (e.hasCustomPosition()) return;
          let a = 0,
            o = e.dir === w.LAYOUT_GROW_DIR.LEFT ? t : n;
          (r < i ? (a = -o) : r > i && (a = o),
            (e.top += a),
            e.children &&
              e.children.length &&
              this.updateChildren(e.children, `top`, a));
        }),
          this.updateBrothers(e.parent, t, n));
      }
    }
    renderLine(e, t, n, r) {
      r === `curve`
        ? this.renderLineCurve(e, t, n)
        : r === `direct`
          ? this.renderLineDirect(e, t, n)
          : this.renderLineStraight(e, t, n);
    }
    renderLineStraight(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      (!c || l) && (s = 0);
      let u = (this.getMarginX(e.layerIndex + 1) - s) * 0.6,
        d = this.mindMap.themeConfig.nodeUseLineStyle;
      e.children.forEach((c, l) => {
        let f = 0,
          p = 0,
          m = d ? c.width : 0;
        c.dir === w.LAYOUT_GROW_DIR.LEFT
          ? ((p = -u), (f = e.layerIndex === 0 ? r : r - s), (m = -m))
          : ((p = u), (f = e.layerIndex === 0 ? r + a : r + a + s));
        let h = i + o / 2,
          g = c.dir === w.LAYOUT_GROW_DIR.LEFT ? c.left + c.width : c.left,
          _ = c.top + c.height / 2;
        ((h = d && !e.isRoot ? h + o / 2 : h), (_ = d ? _ + c.height / 2 : _));
        let v = this.createFoldLine([
          [f, h],
          [f + p, h],
          [f + p, _],
          [g + m, _],
        ]);
        this.setLineStyle(n, t[l], v, c);
      });
    }
    renderLineDirect(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      (!c || l) && (s = 0);
      let { nodeUseLineStyle: u } = this.mindMap.themeConfig;
      e.children.forEach((c, l) => {
        e.layerIndex === 0 && (s = 0);
        let d = c.dir === w.LAYOUT_GROW_DIR.LEFT ? r - s : r + a + s,
          f = i + o / 2,
          p = c.dir === w.LAYOUT_GROW_DIR.LEFT ? c.left + c.width : c.left,
          m = c.top + c.height / 2;
        ((f = u && !e.isRoot ? f + o / 2 : f), (m = u ? m + c.height / 2 : m));
        let h = ``;
        u &&
          (h =
            c.dir === w.LAYOUT_GROW_DIR.LEFT
              ? ` L ${c.left},${m}`
              : ` L ${c.left + c.width},${m}`);
        let g = `M ${d},${f} L ${p},${m}` + h;
        this.setLineStyle(n, t[l], g, c);
      });
    }
    renderLineCurve(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      (!c || l) && (s = 0);
      let {
        nodeUseLineStyle: u,
        rootLineKeepSameInCurve: d,
        rootLineStartPositionKeepSameInCurve: f,
      } = this.mindMap.themeConfig;
      e.children.forEach((c, l) => {
        e.layerIndex === 0 && (s = 0);
        let p =
            e.layerIndex === 0 && !f
              ? r + a / 2
              : c.dir === w.LAYOUT_GROW_DIR.LEFT
                ? r - s
                : r + a + s,
          m = i + o / 2,
          h = c.dir === w.LAYOUT_GROW_DIR.LEFT ? c.left + c.width : c.left,
          g = c.top + c.height / 2,
          _ = ``;
        ((m = u && !e.isRoot ? m + o / 2 : m), (g = u ? g + c.height / 2 : g));
        let v = ``;
        (u &&
          (v =
            c.dir === w.LAYOUT_GROW_DIR.LEFT
              ? ` L ${c.left},${g}`
              : ` L ${c.left + c.width},${g}`),
          (_ =
            e.isRoot && !d
              ? this.quadraticCurvePath(p, m, h, g) + v
              : this.cubicBezierPath(p, m, h, g) + v),
          this.setLineStyle(n, t[l], _, c));
      });
    }
    renderExpandBtn(e, t) {
      let { width: n, height: r, expandBtnSize: i } = e,
        { translateX: a, translateY: o } = t.transform(),
        s = this.mindMap.themeConfig.nodeUseLineStyle ? r / 2 : 0,
        c = e.dir === w.LAYOUT_GROW_DIR.LEFT ? 0 - i : n,
        l = r / 2 + s;
      if (c === a && l === o) return;
      let u = c - a,
        d = l - o;
      t.translate(u, d);
    }
    renderGeneralization(e) {
      e.forEach((e) => {
        let t = e.node.dir === w.LAYOUT_GROW_DIR.LEFT,
          {
            top: n,
            bottom: r,
            left: i,
            right: a,
            generalizationLineMargin: o,
            generalizationNodeMargin: s,
          } = this.getNodeGeneralizationRenderBoundaries(e, `h`),
          c = t ? i - o : a + o,
          l = c,
          u = n,
          d = c,
          f = r,
          p = `M ${l},${u} Q ${l + (t ? -20 : 20)},${u + (f - u) / 2} ${d},${f}`;
        (e.generalizationLine.plot(p),
          (e.generalizationNode.left =
            c + (t ? -s : s) - (t ? e.generalizationNode.width : 0)),
          (e.generalizationNode.top =
            n + (r - n - e.generalizationNode.height) / 2));
      });
    }
    renderExpandBtnRect(e, t, n, r, i) {
      i.dir === w.LAYOUT_GROW_DIR.LEFT
        ? e.size(t, r).x(-t).y(0)
        : e.size(t, r).x(n).y(0);
    }
  },
  Ms = class extends ks {
    constructor(e = {}) {
      super(e);
    }
    doLayout(e) {
      Ui([
        () => {
          this.computedBaseValue();
        },
        () => {
          this.computedLeftTopValue();
        },
        () => {
          this.adjustLeftTopValue();
        },
        () => {
          e(this.root);
        },
      ]);
    }
    computedBaseValue() {
      Y(
        this.renderer.renderTree,
        null,
        (e, t, n, r, i, a) => {
          let o = this.createNode(e, t, n, r, i, a);
          if (
            (n
              ? this.setNodeCenter(o)
              : t._node.isRoot &&
                (o.top = t._node.top + t._node.height + this.getMarginX(r)),
            !e.data.expand)
          )
            return !0;
        },
        (e, t, n, r) => {
          if (n) {
            let t = e.data.expand === !1 ? 0 : e._node.children.length;
            e._node.childrenAreaWidth = t
              ? e._node.children.reduce((e, t) => e + t.width, 0) +
                (t + 1) * this.getMarginX(r + 1)
              : 0;
          }
        },
        !0,
        0,
      );
    }
    computedLeftTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (e.getData(`expand`) && e.children && e.children.length) {
            let t = this.getMarginX(r + 1),
              i = this.getMarginY(r + 1);
            if (n) {
              let n = e.left + e.width / 2 - e.childrenAreaWidth / 2 + t;
              e.children.forEach((e) => {
                ((e.left = n), (n += e.width + t));
              });
            } else {
              let t =
                e.top +
                this.getNodeHeightWithGeneralization(e) +
                i +
                (this.getNodeActChildrenLength(e) > 0 ? e.expandBtnSize : 0);
              e.children.forEach((n) => {
                ((n.left = e.left + e.width * 0.5),
                  (n.top = t),
                  (t +=
                    this.getNodeHeightWithGeneralization(n) +
                    i +
                    (this.getNodeActChildrenLength(n) > 0
                      ? n.expandBtnSize
                      : 0)));
              });
            }
          }
        },
        null,
        !0,
      );
    }
    adjustLeftTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (!e.getData(`expand`)) return;
          if (t && t.isRoot) {
            let t = this.getNodeAreaWidth(e, !0) - e.width;
            t > 0 && this.updateBrothersLeft(e, t);
          }
          let i = e.children.length;
          if (t && !t.isRoot && i > 0) {
            let t = this.getMarginY(r + 1),
              n =
                e.children.reduce(
                  (e, t) =>
                    e +
                    this.getNodeHeightWithGeneralization(t) +
                    (this.getNodeActChildrenLength(t) > 0
                      ? t.expandBtnSize
                      : 0),
                  0,
                ) +
                i * t;
            this.updateBrothersTop(e, n);
          }
        },
        (e, t, n) => {
          if (n) {
            let { right: t, left: n } = this.getNodeBoundaries(e, `h`),
              r = t - n,
              i = e.left - n - (r - e.width) / 2;
            this.updateChildren(e.children, `left`, i);
          }
        },
        !0,
      );
    }
    updateBrothersLeft(e, t) {
      if (e.parent) {
        let n = e.parent.children,
          r = Q(e, n);
        (n.forEach((e, n) => {
          e.hasCustomPosition() ||
            n <= r ||
            ((e.left += t),
            e.children &&
              e.children.length &&
              this.updateChildren(e.children, `left`, t));
        }),
          this.updateBrothersLeft(e.parent, t));
      }
    }
    updateBrothersTop(e, t) {
      if (e.parent && !e.parent.isRoot) {
        let n = e.parent.children,
          r = Q(e, n);
        (n.forEach((e, n) => {
          if (e.hasCustomPosition()) return;
          let i = 0;
          (n > r && (i = t),
            (e.top += i),
            e.children &&
              e.children.length &&
              this.updateChildren(e.children, `top`, i));
        }),
          this.updateBrothersTop(e.parent, t));
      }
    }
    renderLine(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      (!c || l) && (s = 0);
      let u = e.children.length,
        d = this.getMarginX(e.layerIndex + 1);
      if (e.isRoot) {
        let s = r + a / 2,
          c = i + o,
          l = d * 0.7,
          f = 1 / 0,
          p = -1 / 0;
        (e.children.forEach((e, r) => {
          let i = e.left + e.width / 2,
            a = e.top;
          (i < f && (f = i), i > p && (p = i));
          let o = this.mindMap.themeConfig.nodeUseLineStyle
              ? ` L ${e.left},${a} L ${e.left + e.width},${a}`
              : ``,
            s = `M ${i},${c + l} L ${i},${c + l > a ? a + e.height : a}` + o;
          this.setLineStyle(n, t[r], s, e);
        }),
          (f = Math.min(f, s)),
          (p = Math.max(p, s)));
        let m = this.lineDraw.path();
        if (
          (e.style.line(m),
          m.plot(this.transformPath(`M ${s},${c} L ${s},${c + l}`)),
          e._lines.push(m),
          n && n(m, e),
          u > 0)
        ) {
          let t = this.lineDraw.path();
          (e.style.line(t),
            t.plot(this.transformPath(`M ${f},${c + l} L ${p},${c + l}`)),
            e._lines.push(t),
            n && n(t, e));
        }
      } else {
        let r = i + o,
          a = -1 / 0,
          c = e.left + e.width * 0.3;
        if (
          (e.children.forEach((o, s) => {
            let l = o.top + o.height / 2;
            l > a && (a = l);
            let u = ``,
              d = o.left,
              f = o.left + o.width < c,
              p = !1;
            (f
              ? (d = o.left + o.width)
              : o.left < c &&
                o.left + o.width > c &&
                ((p = !0), (l = o.top), (a = l)),
              l > i && l < r
                ? (u = `M ${f ? e.left : e.left + e.width},${l} L ${d},${l}`)
                : l < r
                  ? (p && ((l = o.top + o.height), (d = c)),
                    (u = `M ${c},${i} L ${c},${l} L ${d},${l}`))
                  : (p && (d = c), (u = `M ${c},${l} L ${d},${l}`)));
            let m = this.mindMap.themeConfig.nodeUseLineStyle
              ? ` L ${d},${l - o.height / 2} L ${d},${l + o.height / 2}`
              : ``;
            ((u += m), this.setLineStyle(n, t[s], u, o));
          }),
          u > 0)
        ) {
          let t = this.lineDraw.path();
          ((s = u > 0 ? s : 0),
            e.style.line(t),
            a < r + s
              ? t.hide()
              : (t.plot(this.transformPath(`M ${c},${r + s} L ${c},${a}`)),
                t.show()),
            e._lines.push(t),
            n && n(t, e));
        }
      }
    }
    renderExpandBtn(e, t) {
      let { width: n, height: r, expandBtnSize: i, isRoot: a } = e;
      if (!a) {
        let { translateX: e, translateY: a } = t.transform();
        t.translate(n * 0.3 - i / 2 - e, r + i / 2 - a);
      }
    }
    renderGeneralization(e) {
      e.forEach((e) => {
        let {
            top: t,
            bottom: n,
            right: r,
            generalizationLineMargin: i,
            generalizationNodeMargin: a,
          } = this.getNodeGeneralizationRenderBoundaries(e, `h`),
          o = r + i,
          s = t,
          c = r + i,
          l = n,
          u = `M ${o},${s} Q ${o + 20},${s + (l - s) / 2} ${c},${l}`;
        (e.generalizationLine.plot(this.transformPath(u)),
          (e.generalizationNode.left = r + a),
          (e.generalizationNode.top =
            t + (n - t - e.generalizationNode.height) / 2));
      });
    }
    renderExpandBtnRect(e, t, n, r, i) {
      e.size(n, t).x(0).y(r);
    }
  },
  Ns = class extends ks {
    constructor(e = {}) {
      super(e);
    }
    doLayout(e) {
      Ui([
        () => {
          this.computedBaseValue();
        },
        () => {
          this.computedLeftValue();
        },
        () => {
          this.adjustLeftValue();
        },
        () => {
          e(this.root);
        },
      ]);
    }
    computedBaseValue() {
      Y(
        this.renderer.renderTree,
        null,
        (e, t, n, r, i, a) => {
          let o = this.createNode(e, t, n, r, i, a);
          if (
            (n
              ? this.setNodeCenter(o)
              : (o.top = t._node.top + t._node.height + this.getMarginX(r)),
            !e.data.expand)
          )
            return !0;
        },
        (e, t, n, r) => {
          let i = e.data.expand === !1 ? 0 : e._node.children.length;
          e._node.childrenAreaWidth = i
            ? e._node.children.reduce((e, t) => e + t.width, 0) +
              (i + 1) * this.getMarginY(r + 1)
            : 0;
          let a = e._node.checkHasGeneralization()
            ? e._node._generalizationNodeWidth + this.getMarginY(r + 1)
            : 0;
          e._node.childrenAreaWidth2 = Math.max(e._node.childrenAreaWidth, a);
        },
        !0,
        0,
      );
    }
    computedLeftValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (e.getData(`expand`) && e.children && e.children.length) {
            let t = this.getMarginY(r + 1),
              n = e.left + e.width / 2 - e.childrenAreaWidth / 2 + t;
            e.children.forEach((e) => {
              ((e.left = n), (n += e.width + t));
            });
          }
        },
        null,
        !0,
      );
    }
    adjustLeftValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (!e.getData(`expand`)) return;
          let i = e.childrenAreaWidth2 - this.getMarginY(r + 1) * 2 - e.width;
          i > 0 && this.updateBrothers(e, i / 2);
        },
        null,
        !0,
      );
    }
    updateBrothers(e, t) {
      if (e.parent) {
        let n = e.parent.children,
          r = Q(e, n);
        (n.forEach((e, n) => {
          if (e.hasCustomPosition()) return;
          let i = 0;
          (n < r ? (i = -t) : n > r && (i = t),
            (e.left += i),
            e.children &&
              e.children.length &&
              this.updateChildren(e.children, `left`, i));
        }),
          this.updateBrothers(e.parent, t));
      }
    }
    renderLine(e, t, n, r) {
      r === `curve`
        ? this.renderLineCurve(e, t, n)
        : r === `direct`
          ? this.renderLineDirect(e, t, n)
          : this.renderLineStraight(e, t, n);
    }
    renderLineCurve(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      (!c || l) && (s = 0);
      let {
        nodeUseLineStyle: u,
        rootLineStartPositionKeepSameInCurve: d,
        rootLineKeepSameInCurve: f,
      } = this.mindMap.themeConfig;
      e.children.forEach((c, l) => {
        e.layerIndex === 0 && (s = 0);
        let p = r + a / 2,
          m = e.layerIndex === 0 && !d ? i + o / 2 : i + o + s,
          h = c.left + c.width / 2,
          g = c.top,
          _ = ``,
          v = u ? ` L ${c.left},${g} L ${c.left + c.width},${g}` : ``;
        ((_ =
          e.isRoot && !f
            ? this.quadraticCurvePath(p, m, h, g, !0) + v
            : this.cubicBezierPath(p, m, h, g, !0) + v),
          this.setLineStyle(n, t[l], _, c));
      });
    }
    renderLineDirect(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o } = e,
        { nodeUseLineStyle: s } = this.mindMap.themeConfig,
        c = r + a / 2,
        l = i + o;
      e.children.forEach((e, r) => {
        let i = e.left + e.width / 2,
          a = e.top,
          o = s ? ` L ${e.left},${a} L ${e.left + e.width},${a}` : ``,
          u = `M ${c},${l} L ${i},${a}` + o;
        this.setLineStyle(n, t[r], u, e);
      });
    }
    renderLineStraight(e, t, n) {
      if (e.children.length <= 0) return [];
      let {
          left: r,
          top: i,
          width: a,
          height: o,
          expandBtnSize: s,
          isRoot: c,
        } = e,
        { alwaysShowExpandBtn: l, notShowExpandBtn: u } = this.mindMap.opt;
      (!l || u) && (s = 0);
      let d = r + a / 2,
        f = i + o,
        p = this.getMarginX(e.layerIndex + 1) * 0.7,
        m = 1 / 0,
        h = -1 / 0,
        g = e.children.length;
      (e.children.forEach((e, r) => {
        let i = e.left + e.width / 2,
          a = f + p > e.top ? e.top + e.height : e.top;
        (i < m && (m = i), i > h && (h = i));
        let o = this.mindMap.themeConfig.nodeUseLineStyle
            ? ` L ${e.left},${a} L ${e.left + e.width},${a}`
            : ``,
          s = `M ${i},${f + p} L ${i},${a}` + o;
        this.setLineStyle(n, t[r], s, e);
      }),
        (m = Math.min(d, m)),
        (h = Math.max(d, h)));
      let _ = this.lineDraw.path();
      if (
        (e.style.line(_),
        (s = g > 0 && !c ? s : 0),
        _.plot(this.transformPath(`M ${d},${f + s} L ${d},${f + p}`)),
        e._lines.push(_),
        n && n(_, e),
        g > 0)
      ) {
        let t = this.lineDraw.path();
        (e.style.line(t),
          t.plot(this.transformPath(`M ${m},${f + p} L ${h},${f + p}`)),
          e._lines.push(t),
          n && n(t, e));
      }
    }
    renderExpandBtn(e, t) {
      let { width: n, height: r, expandBtnSize: i } = e,
        { translateX: a, translateY: o } = t.transform();
      t.translate(n / 2 - i / 2 - a, r + i / 2 - o);
    }
    renderGeneralization(e) {
      e.forEach((e) => {
        let {
            bottom: t,
            left: n,
            right: r,
            generalizationLineMargin: i,
            generalizationNodeMargin: a,
          } = this.getNodeGeneralizationRenderBoundaries(e, `v`),
          o = n,
          s = t + i,
          c = r,
          l = t + i,
          u = `M ${o},${s} Q ${o + (c - o) / 2},${s + 20} ${c},${l}`;
        (e.generalizationLine.plot(this.transformPath(u)),
          (e.generalizationNode.top = t + a),
          (e.generalizationNode.left =
            n + (r - n - e.generalizationNode.width) / 2));
      });
    }
    renderExpandBtnRect(e, t, n, r, i) {
      e.size(n, t).x(0).y(r);
    }
  },
  Ps = class extends ks {
    constructor(e = {}, t) {
      (super(e), (this.layout = t));
    }
    doLayout(e) {
      Ui([
        () => {
          this.computedBaseValue();
        },
        () => {
          this.computedLeftTopValue();
        },
        () => {
          this.adjustLeftTopValue();
        },
        () => {
          e(this.root);
        },
      ]);
    }
    computedBaseValue() {
      Y(
        this.renderer.renderTree,
        null,
        (e, t, n, r, i, a) => {
          let o = this.createNode(e, t, n, r, i, a);
          if (
            (n
              ? this.setNodeCenter(o)
              : (this.layout === w.LAYOUT.TIMELINE2
                  ? t._node.dir
                    ? (o.dir = t._node.dir)
                    : (o.dir =
                        i % 2 == 0
                          ? w.LAYOUT_GROW_DIR.BOTTOM
                          : w.LAYOUT_GROW_DIR.TOP)
                  : (o.dir = ``),
                t._node.isRoot &&
                  (o.top =
                    t._node.top +
                    (e._node.height > t._node.height
                      ? -(e._node.height - t._node.height) / 2
                      : (t._node.height - e._node.height) / 2))),
            !e.data.expand)
          )
            return !0;
        },
        null,
        !0,
        0,
      );
    }
    computedLeftTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r, i) => {
          if (e.getData(`expand`) && e.children && e.children.length) {
            let t = this.getMarginX(r + 1),
              i = this.getMarginY(r + 1);
            if (n) {
              let n = e.left + e.width + t;
              e.children.forEach((e) => {
                ((e.left = n), (n += e.width + t));
              });
            } else {
              let t =
                e.top +
                e.height +
                i +
                (this.getNodeActChildrenLength(e) > 0 ? e.expandBtnSize : 0);
              e.children.forEach((n) => {
                ((n.left = e.left + e.width * 0.5),
                  (n.top = t),
                  (t +=
                    n.height +
                    i +
                    (this.getNodeActChildrenLength(n) > 0
                      ? n.expandBtnSize
                      : 0)));
              });
            }
          }
        },
        null,
        !0,
      );
    }
    adjustLeftTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (!e.getData(`expand`)) return;
          e.isRoot && this.updateBrothersLeft(e);
          let i = e.children.length;
          if (t && !t.isRoot && i > 0) {
            let t = this.getMarginY(r + 1),
              n =
                e.children.reduce(
                  (e, t) =>
                    e +
                    t.height +
                    (this.getNodeActChildrenLength(t) > 0
                      ? t.expandBtnSize
                      : 0),
                  0,
                ) +
                i * t;
            this.updateBrothersTop(e, n);
          }
        },
        (e, t, n, r) => {
          t &&
            t.isRoot &&
            e.dir === w.LAYOUT_GROW_DIR.TOP &&
            e.children.forEach((t) => {
              let n = this.getNodeAreaHeight(t),
                r = t.top;
              ((t.top = e.top - (t.top - e.top) - n + e.height),
                this.updateChildren(t.children, `top`, t.top - r));
            });
        },
        !0,
      );
    }
    getNodeAreaHeight(e) {
      let t = 0,
        n = (e) => {
          ((t +=
            e.height +
            (this.getNodeActChildrenLength(e) > 0 ? e.expandBtnSize : 0) +
            this.getMarginY(e.layerIndex)),
            e.children.length &&
              e.children.forEach((e) => {
                n(e);
              }));
        };
      return (n(e), t);
    }
    updateBrothersLeft(e) {
      let t = e.children,
        n = 0;
      t.forEach((e) => {
        ((e.left += n),
          e.children &&
            e.children.length &&
            this.updateChildren(e.children, `left`, n));
        let { left: t, right: r } = this.getNodeBoundaries(e, `h`),
          i = r - t - e.width;
        i > 0 && (n += i);
      });
    }
    updateBrothersTop(e, t) {
      if (e.parent && !e.parent.isRoot) {
        let n = e.parent.children,
          r = Q(e, n);
        (n.forEach((e, n) => {
          if (e.hasCustomPosition()) return;
          let i = 0;
          (n > r && (i = t),
            (e.top += i),
            e.children &&
              e.children.length &&
              this.updateChildren(e.children, `top`, i));
        }),
          this.updateBrothersTop(e.parent, t));
      }
    }
    renderLine(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      (!c || l) && (s = 0);
      let u = e.children.length;
      if (e.isRoot) {
        let r = e;
        e.children.forEach((i, a) => {
          let o = r.left + r.width,
            s = i.left,
            c = e.top + e.height / 2,
            l = `M ${o},${c} L ${s},${c}`;
          (this.setLineStyle(n, t[a], l, i), (r = i));
        });
      } else {
        let r = -1 / 0,
          a = 1 / 0,
          c = e.left + e.width * 0.3;
        if (
          (e.children.forEach((e, i) => {
            let o = e.top + e.height / 2;
            (o > r && (r = o), o < a && (a = o));
            let s = `M ${c},${o} L ${e.left},${o}`;
            this.setLineStyle(n, t[i], s, e);
          }),
          u > 0)
        ) {
          let t = this.lineDraw.path();
          ((s = u > 0 ? s : 0),
            e.parent && e.parent.isRoot && e.dir === w.LAYOUT_GROW_DIR.TOP
              ? t.plot(this.transformPath(`M ${c},${i} L ${c},${a}`))
              : t.plot(this.transformPath(`M ${c},${i + o + s} L ${c},${r}`)),
            e.style.line(t),
            e._lines.push(t),
            n && n(t, e));
        }
      }
    }
    renderExpandBtn(e, t) {
      let { width: n, height: r, expandBtnSize: i, isRoot: a } = e;
      if (!a) {
        let { translateX: a, translateY: o } = t.transform();
        e.parent && e.parent.isRoot && e.dir === w.LAYOUT_GROW_DIR.TOP
          ? t.translate(n * 0.3 - i / 2 - a, -i / 2 - o)
          : t.translate(n * 0.3 - i / 2 - a, r + i / 2 - o);
      }
    }
    renderGeneralization(e) {
      e.forEach((e) => {
        let {
            top: t,
            bottom: n,
            right: r,
            generalizationLineMargin: i,
            generalizationNodeMargin: a,
          } = this.getNodeGeneralizationRenderBoundaries(e, `h`),
          o = r + i,
          s = t,
          c = r + i,
          l = n,
          u = `M ${o},${s} Q ${o + 20},${s + (l - s) / 2} ${c},${l}`;
        (e.generalizationLine.plot(this.transformPath(u)),
          (e.generalizationNode.left = r + a),
          (e.generalizationNode.top =
            t + (n - t - e.generalizationNode.height) / 2));
      });
    }
    renderExpandBtnRect(e, t, n, r, i) {
      if (this.layout === w.LAYOUT.TIMELINE) e.size(n, t).x(0).y(r);
      else {
        let a = ``;
        ((a =
          i.dir === w.LAYOUT_GROW_DIR.TOP && i.layerIndex === 1
            ? w.LAYOUT_GROW_DIR.TOP
            : w.LAYOUT_GROW_DIR.BOTTOM),
          a === w.LAYOUT_GROW_DIR.TOP
            ? e.size(n, t).x(0).y(-t)
            : e.size(n, t).x(0).y(r));
      }
    }
  },
  Fs = class extends ks {
    constructor(e = {}, t) {
      (super(e), (this.layout = t));
    }
    doLayout(e) {
      Ui([
        () => {
          this.computedBaseValue();
        },
        () => {
          this.computedTopValue();
        },
        () => {
          this.adjustLeftTopValue();
        },
        () => {
          e(this.root);
        },
      ]);
    }
    computedBaseValue() {
      Y(
        this.renderer.renderTree,
        null,
        (e, t, n, r, i, a) => {
          let o = this.createNode(e, t, n, r, i, a);
          if (
            (n
              ? this.setNodeCenter(o)
              : (t._node.dir
                  ? (o.dir = t._node.dir)
                  : this.layout === w.LAYOUT.VERTICAL_TIMELINE2
                    ? (o.dir = w.LAYOUT_GROW_DIR.LEFT)
                    : this.layout === w.LAYOUT.VERTICAL_TIMELINE3
                      ? (o.dir = w.LAYOUT_GROW_DIR.RIGHT)
                      : (o.dir =
                          i % 2 == 0
                            ? w.LAYOUT_GROW_DIR.RIGHT
                            : w.LAYOUT_GROW_DIR.LEFT),
                t._node.isRoot
                  ? (o.left =
                      t._node.left +
                      (e._node.width > t._node.width
                        ? -(e._node.width - t._node.width) / 2
                        : (t._node.width - e._node.width) / 2))
                  : (o.left =
                      o.dir === w.LAYOUT_GROW_DIR.RIGHT
                        ? t._node.left + t._node.width + this.getMarginX(r)
                        : t._node.left - this.getMarginX(r) - o.width)),
            !e.data.expand)
          )
            return !0;
        },
        (e, t, n, r) => {
          if (n) return;
          let i = e.data.expand === !1 ? 0 : e._node.children.length;
          e._node.childrenAreaHeight = i
            ? e._node.children.reduce((e, t) => e + t.height, 0) +
              (i + 1) * this.getMarginY(r + 1)
            : 0;
        },
        !0,
        0,
      );
    }
    computedTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r, i) => {
          if (e.getData(`expand`) && e.children && e.children.length) {
            let t = this.getMarginY(r + 1);
            if (n) {
              let n = e.top + e.height + t;
              e.children.forEach((e) => {
                ((e.top = n), (n += e.height + t));
              });
            } else {
              let t = this.getMarginY(r + 1),
                n = e.top + e.height / 2 + t - e.childrenAreaHeight / 2;
              e.children.forEach((e) => {
                ((e.top = n), (n += e.height + t));
              });
            }
          }
        },
        null,
        !0,
      );
    }
    adjustLeftTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (!e.getData(`expand`) || n) return;
          let i = this.getMarginY(r + 1) * 2 + e.height,
            a = e.childrenAreaHeight - i;
          a > 0 && this.updateBrothers(e, a / 2);
        },
        null,
        !0,
      );
    }
    updateBrothers(e, t) {
      if (e.parent) {
        let n = e.parent.children,
          r = Q(e, n);
        (n.forEach((n, i) => {
          if (n.hasCustomPosition() || (!e.parent.isRoot && n.uid === e.uid))
            return;
          let a = 0;
          (e.parent.isRoot
            ? (a = i < r ? 0 : i > r ? t * 2 : t)
            : i < r
              ? (a = -t)
              : i > r && (a = t),
            (n.top += a),
            n.children &&
              n.children.length &&
              this.updateChildren(n.children, `top`, a));
        }),
          this.updateBrothers(e.parent, t));
      }
    }
    updateBrothersTop(e, t) {
      if (e.parent && !e.parent.isRoot) {
        let n = e.parent.children,
          r = Q(e, n);
        (n.forEach((e, n) => {
          if (e.hasCustomPosition()) return;
          let i = 0;
          (n > r && (i = t),
            (e.top += i),
            e.children &&
              e.children.length &&
              this.updateChildren(e.children, `top`, i));
        }),
          this.updateBrothersTop(e.parent, t));
      }
    }
    renderLine(e, t, n, r) {
      r === `curve`
        ? this.renderLineCurve(e, t, n)
        : r === `direct`
          ? this.renderLineDirect(e, t, n)
          : this.renderLineStraight(e, t, n);
    }
    renderLineStraight(e, t, n) {
      if (e.children.length <= 0) return [];
      let { expandBtnSize: r } = e,
        { alwaysShowExpandBtn: i, notShowExpandBtn: a } = this.mindMap.opt;
      if (((!i || a) && (r = 0), e.isRoot)) {
        let r = e;
        e.children.forEach((i, a) => {
          let o = r.top + r.height,
            s = i.top,
            c = e.left + e.width / 2,
            l = `M ${c},${o} L ${c},${s}`;
          (this.setLineStyle(n, t[a], l, i), (r = i));
        });
      } else if (e.dir === w.LAYOUT_GROW_DIR.RIGHT) {
        let i = e.left + e.width,
          a = e.top + e.height / 2,
          o = (this.getMarginX(e.layerIndex + 1) - r) * 0.6;
        e.children.forEach((e, r) => {
          let s = e.left,
            c = e.top + e.height / 2,
            l = this.createFoldLine([
              [i, a],
              [i + o, a],
              [i + o, c],
              [s, c],
            ]);
          this.setLineStyle(n, t[r], l, e);
        });
      } else {
        let i = e.left,
          a = e.top + e.height / 2,
          o = (this.getMarginX(e.layerIndex + 1) - r) * 0.6;
        e.children.forEach((e, r) => {
          let s = e.left + e.width,
            c = e.top + e.height / 2,
            l = this.createFoldLine([
              [i, a],
              [i - o, a],
              [i - o, c],
              [s, c],
            ]);
          this.setLineStyle(n, t[r], l, e);
        });
      }
    }
    renderLineDirect(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      ((!c || l) && (s = 0),
        e.children.forEach((c, l) => {
          if (e.isRoot) {
            let r = e;
            e.children.forEach((i, a) => {
              let o = r.top + r.height,
                s = i.top,
                c = e.left + e.width / 2,
                l = `M ${c},${o} L ${c},${s}`;
              (this.setLineStyle(n, t[a], l, i), (r = i));
            });
          } else {
            let e = `M ${c.dir === w.LAYOUT_GROW_DIR.LEFT ? r - s : r + a + s},${i + o / 2} L ${c.dir === w.LAYOUT_GROW_DIR.LEFT ? c.left + c.width : c.left},${c.top + c.height / 2}`;
            this.setLineStyle(n, t[l], e, c);
          }
        }));
    }
    renderLineCurve(e, t, n) {
      if (e.children.length <= 0) return [];
      let { left: r, top: i, width: a, height: o, expandBtnSize: s } = e,
        { alwaysShowExpandBtn: c, notShowExpandBtn: l } = this.mindMap.opt;
      ((!c || l) && (s = 0),
        e.children.forEach((c, l) => {
          if (e.isRoot) {
            let r = e;
            e.children.forEach((i, a) => {
              let o = r.top + r.height,
                s = i.top,
                c = e.left + e.width / 2,
                l = `M ${c},${o} L ${c},${s}`;
              (this.setLineStyle(n, t[a], l, i), (r = i));
            });
          } else {
            let e = c.dir === w.LAYOUT_GROW_DIR.LEFT ? r - s : r + a + s,
              u = i + o / 2,
              d = c.dir === w.LAYOUT_GROW_DIR.LEFT ? c.left + c.width : c.left,
              f = c.top + c.height / 2,
              p = this.cubicBezierPath(e, u, d, f);
            this.setLineStyle(n, t[l], p, c);
          }
        }));
    }
    renderExpandBtn(e, t) {
      let { width: n, height: r, expandBtnSize: i, isRoot: a } = e;
      if (!a) {
        let { translateX: a, translateY: o } = t.transform();
        e.dir === w.LAYOUT_GROW_DIR.RIGHT
          ? t.translate(n - a, r / 2 - o)
          : t.translate(-i - a, r / 2 - o);
      }
    }
    renderGeneralization(e) {
      e.forEach((e) => {
        let t = e.node.dir === w.LAYOUT_GROW_DIR.LEFT,
          {
            top: n,
            bottom: r,
            left: i,
            right: a,
            generalizationLineMargin: o,
            generalizationNodeMargin: s,
          } = this.getNodeGeneralizationRenderBoundaries(e, `h`),
          c = t ? i - o : a + o,
          l = c,
          u = n,
          d = c,
          f = r,
          p = `M ${l},${u} Q ${l + (t ? -20 : 20)},${u + (f - u) / 2} ${d},${f}`;
        (e.generalizationLine.plot(this.transformPath(p)),
          (e.generalizationNode.left =
            c + (t ? -s : s) - (t ? e.generalizationNode.width : 0)),
          (e.generalizationNode.top =
            n + (r - n - e.generalizationNode.height) / 2));
      });
    }
    renderExpandBtnRect(e, t, n, r, i) {
      i.dir === w.LAYOUT_GROW_DIR.LEFT
        ? e.size(t, r).x(-t).y(0)
        : e.size(t, r).x(n).y(0);
    }
  },
  Is = {
    top: {
      renderExpandBtn({
        node: e,
        btn: t,
        expandBtnSize: n,
        translateX: r,
        translateY: i,
        width: a,
        height: o,
      }) {
        e.parent && e.parent.isRoot
          ? t.translate(a * 0.3 - n / 2 - r, -n / 2 - i)
          : t.translate(a * 0.3 - n / 2 - r, o + n / 2 - i);
      },
      renderLine({
        node: e,
        line: t,
        top: n,
        x: r,
        lineLength: i,
        height: a,
        expandBtnSize: o,
        maxy: s,
        ctx: c,
      }) {
        e.parent && e.parent.isRoot
          ? t.plot(
              c.transformPath(
                `M ${r},${n} L ${r + i},${n - Math.tan(Wi(c.mindMap.opt.fishboneDeg)) * i}`,
              ),
            )
          : t.plot(c.transformPath(`M ${r},${n + a + o} L ${r},${s}`));
      },
      computedLeftTopValue({ layerIndex: e, node: t, ctx: n }) {
        if (e >= 1 && t.children) {
          let r = n.getMarginY(e + 1),
            i = t.left + t.width * n.childIndent,
            a =
              t.top +
              t.height +
              (n.getNodeActChildrenLength(t) > 0 ? t.expandBtnSize : 0) +
              r;
          t.children.forEach((e) => {
            ((e.left = i),
              (e.top += a),
              (a +=
                e.height +
                (n.getNodeActChildrenLength(e) > 0 ? e.expandBtnSize : 0) +
                r));
          });
        }
      },
      adjustLeftTopValueBefore({ node: e, parent: t, ctx: n, layerIndex: r }) {
        let i = e.children.length,
          a = n.getMarginY(r + 1);
        if (t && !t.isRoot && i > 0) {
          let t = e.children.reduce(
            (e, t) =>
              e +
              t.height +
              (n.getNodeActChildrenLength(t) > 0 ? t.expandBtnSize : 0) +
              a,
            0,
          );
          n.updateBrothersTop(e, t);
        }
      },
      adjustLeftTopValueAfter({ parent: e, node: t, ctx: n }) {
        if (e && e.isRoot) {
          let e = n.getMarginY(t.layerIndex + 1),
            r = t.expandBtnSize + e;
          t.children.forEach((e) => {
            let i = n.getNodeAreaHeight(e),
              a = e.top,
              o = e.left;
            ((e.top = t.top - (e.top - t.top) - i + t.height),
              (e.left =
                t.left +
                t.width * n.indent +
                (i + r) / Math.tan(Wi(n.mindMap.opt.fishboneDeg))),
              (r += i),
              n.updateChildrenPro(e.children, {
                top: e.top - a,
                left: e.left - o,
              }));
          });
        }
      },
    },
    bottom: {
      renderExpandBtn({
        node: e,
        btn: t,
        expandBtnSize: n,
        translateX: r,
        translateY: i,
        width: a,
        height: o,
      }) {
        e.parent && e.parent.isRoot
          ? t.translate(a * 0.3 - n / 2 - r, o + n / 2 - i)
          : t.translate(a * 0.3 - n / 2 - r, -n / 2 - i);
      },
      renderLine({
        node: e,
        line: t,
        top: n,
        x: r,
        lineLength: i,
        height: a,
        miny: o,
        ctx: s,
      }) {
        e.parent && e.parent.isRoot
          ? t.plot(
              s.transformPath(
                `M ${r},${n + a} L ${r + i},${n + a + Math.tan(Wi(s.mindMap.opt.fishboneDeg)) * i}`,
              ),
            )
          : t.plot(s.transformPath(`M ${r},${n} L ${r},${o}`));
      },
      computedLeftTopValue({ layerIndex: e, node: t, ctx: n }) {
        let r = n.getMarginY(e + 1);
        if (e === 1 && t.children) {
          let e = t.left + t.width * n.childIndent,
            i =
              t.top +
              t.height +
              (n.getNodeActChildrenLength(t) > 0 ? t.expandBtnSize : 0) +
              r;
          t.children.forEach((t) => {
            ((t.left = e),
              (t.top =
                i + (n.getNodeActChildrenLength(t) > 0 ? t.expandBtnSize : 0)),
              (i +=
                t.height +
                (n.getNodeActChildrenLength(t) > 0 ? t.expandBtnSize : 0) +
                r));
          });
        }
        if (e > 1 && t.children) {
          let e = t.left + t.width * n.childIndent,
            i =
              t.top -
              (n.getNodeActChildrenLength(t) > 0 ? t.expandBtnSize : 0) -
              r;
          t.children.forEach((t) => {
            ((t.left = e),
              (t.top = i - t.height),
              (i -=
                t.height +
                (n.getNodeActChildrenLength(t) > 0 ? t.expandBtnSize : 0) +
                r));
          });
        }
      },
      adjustLeftTopValueBefore({ node: e, ctx: t, layerIndex: n }) {
        let r = t.getMarginY(n + 1),
          i = e.children.length;
        if (n > 2 && i > 0) {
          let n = e.children.reduce(
            (e, n) =>
              e +
              n.height +
              (t.getNodeActChildrenLength(n) > 0 ? n.expandBtnSize : 0) +
              r,
            0,
          );
          t.updateBrothersTop(e, -n);
        }
      },
      adjustLeftTopValueAfter({ parent: e, node: t, ctx: n }) {
        if (e && e.isRoot) {
          let e = n.getMarginY(t.layerIndex + 1),
            r = 0,
            i = t.expandBtnSize;
          t.children.forEach((a) => {
            let o = n.getNodeActChildrenLength(a) > 0,
              s = n.getNodeAreaHeight(a),
              c = o ? s - a.height - (o ? a.expandBtnSize : 0) : 0;
            c -= o ? e : 0;
            let l = r + c,
              u = a.left;
            ((a.top += l),
              (a.left =
                t.left +
                t.width * n.indent +
                (s + i) / Math.tan(Wi(n.mindMap.opt.fishboneDeg))),
              (r += c),
              (i += s),
              n.updateChildrenPro(a.children, { top: l, left: a.left - u }));
          });
        }
      },
    },
  },
  Ls = class extends ks {
    constructor(e = {}, t) {
      (super(e),
        (this.layout = t),
        (this.indent = 0.3),
        (this.childIndent = 0.5),
        (this.fishTail = null),
        (this.maxx = 0),
        (this.headRatio = 1),
        (this.tailRatio = 0.6),
        (this.paddingXRatio = 0.3),
        (this.fishHeadPathStr = `M4,181 C4,181, 0,177, 4,173 Q 96.09523809523809,0, 288.2857142857143,0 L 288.2857142857143,354 Q 48.047619047619044,354, 8,218.18367346938777 C8,218.18367346938777, 6,214.18367346938777, 8,214.18367346938777 L 41.183673469387756,214.18367346938777 Z`),
        (this.fishTailPathStr = `M 606.9342905223708 0 Q 713.1342905223709 -177 819.3342905223708 -177 L 766.2342905223709 0 L 819.3342905223708 177 Q 713.1342905223709 177 606.9342905223708 0 z`),
        this.bindEvent(),
        this.extendShape(),
        (this.beforeChange = this.beforeChange.bind(this)));
    }
    nodeIsRemoveAllLines(e) {
      return e.isRoot || e.layerIndex === 1;
    }
    isFishbone2() {
      return this.layout === w.LAYOUT.FISHBONE2;
    }
    bindEvent() {
      this.isFishbone2() &&
        ((this.onCheckUpdateFishTail = this.onCheckUpdateFishTail.bind(this)),
        this.mindMap.on(`afterExecCommand`, this.onCheckUpdateFishTail));
    }
    unBindEvent() {
      this.mindMap.off(`afterExecCommand`, this.onCheckUpdateFishTail);
    }
    extendShape() {
      this.isFishbone2() &&
        this.mindMap.addShape({
          name: `fishHead`,
          createShape: (e) => {
            let t = J(`<path d="${this.fishHeadPathStr}"></path>`),
              { width: n, height: r } = e.shapeInstance.getNodeSize();
            return (t.size(n, r), t);
          },
          getPadding: ({ width: e, height: t, paddingX: n, paddingY: r }) => {
            ((e += n * 2), (t += r * 2));
            let i = this.paddingXRatio * e,
              a = 0;
            return (
              (e += i * 2),
              (a = (e / this.headRatio - t) / 2),
              { paddingX: i, paddingY: a }
            );
          },
        });
    }
    doLayout(e) {
      Ui([
        () => {
          (this.computedBaseValue(), this.addFishTail());
        },
        () => {
          this.computedLeftTopValue();
        },
        () => {
          (this.adjustLeftTopValue(), this.updateFishTailPosition());
        },
        () => {
          e(this.root);
        },
      ]);
    }
    addFishTail() {
      if (!this.isFishbone2()) return;
      let e = this.mindMap.lineDraw.findOne(`.smm-layout-fishbone-tail`);
      e
        ? (this.fishTail = e)
        : ((this.fishTail = J(`<path d="${this.fishTailPathStr}"></path>`)),
          this.fishTail.addClass(`smm-layout-fishbone-tail`));
      let t = this.root.height,
        n = t * this.tailRatio;
      (this.fishTail.size(n, t),
        this.styleFishTail(),
        this.mindMap.lineDraw.add(this.fishTail));
    }
    onCheckUpdateFishTail(e, t, n) {
      if (e === `SET_NODE_DATA`) {
        let e = !1;
        (Object.keys(n).forEach((t) => {
          Va.includes(t) && (e = !0);
        }),
          e && this.styleFishTail());
      }
    }
    styleFishTail() {
      this.root.style.shape(this.fishTail);
    }
    removeFishTail() {
      let e = this.mindMap.lineDraw.findOne(`.smm-layout-fishbone-tail`);
      e && e.remove();
    }
    updateFishTailPosition() {
      this.isFishbone2() &&
        this.fishTail.x(this.maxx).cy(this.root.top + this.root.height / 2);
    }
    computedBaseValue() {
      Y(
        this.renderer.renderTree,
        null,
        (e, t, n, r, i, a) => {
          n && this.isFishbone2() && (e.data.shape = `fishHead`);
          let o = this.createNode(e, t, n, r, i, a);
          if (n) this.setNodeCenter(o);
          else if (
            (t._node.dir
              ? (o.dir = t._node.dir)
              : (o.dir =
                  i % 2 == 0
                    ? w.LAYOUT_GROW_DIR.TOP
                    : w.LAYOUT_GROW_DIR.BOTTOM),
            t._node.isRoot)
          ) {
            let e = this.getMarginY(r),
              n = this.isFishbone2() ? t._node.height / 4 : 0;
            this.checkIsTop(o)
              ? (o.top = t._node.top - o.height - e + n)
              : (o.top = t._node.top + t._node.height + e - n);
          }
          if (!e.data.expand) return !0;
        },
        null,
        !0,
        0,
      );
    }
    computedLeftTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (e.isRoot) {
            let t = this.getMarginX(r + 1),
              n = this.isFishbone2() ? 2 : 1,
              i = e.left + e.width + e.height / n + t,
              a = e.left + e.width + e.height / n + t;
            e.children.forEach((e) => {
              this.checkIsTop(e)
                ? ((e.left = i), (i += e.width + t))
                : ((e.left = a + 20), (a += e.width + t));
            });
          }
          let i = { layerIndex: r, node: e, ctx: this };
          this.checkIsTop(e)
            ? Is.top.computedLeftTopValue(i)
            : Is.bottom.computedLeftTopValue(i);
        },
        null,
        !0,
      );
    }
    adjustLeftTopValue() {
      Y(
        this.root,
        null,
        (e, t, n, r) => {
          if (!e.getData(`expand`)) return;
          let i = { node: e, parent: t, layerIndex: r, ctx: this };
          this.checkIsTop(e)
            ? Is.top.adjustLeftTopValueBefore(i)
            : Is.bottom.adjustLeftTopValueBefore(i);
        },
        (e, t) => {
          let n = { parent: t, node: e, ctx: this };
          if (
            (this.checkIsTop(e)
              ? Is.top.adjustLeftTopValueAfter(n)
              : Is.bottom.adjustLeftTopValueAfter(n),
            e.isRoot)
          ) {
            let t = 0,
              n = 0,
              r = -1 / 0;
            (e.children.forEach((e) => {
              if (this.checkIsTop(e)) {
                ((e.left += t), this.updateChildren(e.children, `left`, t));
                let { left: n, right: i } = this.getNodeBoundaries(e, `h`);
                (i > r && (r = i), (t += i - n));
              } else {
                ((e.left += n), this.updateChildren(e.children, `left`, n));
                let { left: t, right: i } = this.getNodeBoundaries(e, `h`);
                (i > r && (r = i), (n += i - t));
              }
            }),
              (this.maxx = r));
          }
        },
        !0,
      );
    }
    getNodeAreaHeight(e) {
      let t = 0,
        n = (e) => {
          let r = this.getMarginY(e.layerIndex);
          ((t +=
            e.height +
            (this.getNodeActChildrenLength(e) > 0 ? e.expandBtnSize : 0) +
            r),
            e.children.length &&
              e.children.forEach((e) => {
                n(e);
              }));
        };
      return (n(e), t);
    }
    updateBrothersLeft(e) {
      let t = e.children,
        n = 0;
      t.forEach((e) => {
        ((e.left += n),
          e.children &&
            e.children.length &&
            this.updateChildren(e.children, `left`, n));
        let { left: t, right: r } = this.getNodeBoundaries(e, `h`),
          i = r - t - e.width;
        i > 0 && (n += i);
      });
    }
    updateBrothersTop(e, t) {
      if (e.parent && !e.parent.isRoot) {
        let n = e.parent.children,
          r = Q(e, n);
        (n.forEach((e, n) => {
          if (e.hasCustomPosition()) return;
          let i = 0;
          (n > r && (i = t),
            (e.top += i),
            e.children &&
              e.children.length &&
              this.updateChildren(e.children, `top`, i));
        }),
          this.checkIsTop(e)
            ? this.updateBrothersTop(e.parent, t)
            : this.updateBrothersTop(e.parent, e.layerIndex === 3 ? 0 : t));
      }
    }
    checkIsTop(e) {
      return e.dir === w.LAYOUT_GROW_DIR.TOP;
    }
    renderLine(e, t, n) {
      if (e.layerIndex !== 1 && e.children.length <= 0) return [];
      let { top: r, height: i, expandBtnSize: a } = e,
        { alwaysShowExpandBtn: o, notShowExpandBtn: s } = this.mindMap.opt;
      (!o || s) && (a = 0);
      let c = e.children.length;
      if (e.isRoot) {
        let t = -1 / 0;
        e.children.forEach((r) => {
          r.left > t && (t = r.left);
          let i = this.getMarginY(r.layerIndex),
            a = r.left,
            o = e.height / 2 + i - (this.isFishbone2() ? e.height / 4 : 0),
            s = o / Math.tan(Wi(this.mindMap.opt.fishboneDeg)),
            c = this.lineDraw.path();
          (this.checkIsTop(r)
            ? c.plot(
                this.transformPath(
                  `M ${a - s},${r.top + r.height + o} L ${r.left},${r.top + r.height}`,
                ),
              )
            : c.plot(
                this.transformPath(`M ${a - s},${r.top - o} L ${a},${r.top}`),
              ),
            e.style.line(c),
            e._lines.push(c),
            n && n(c, e));
        });
        let r = e.top + e.height / 2,
          i = e.height / 2 + this.getMarginY(e.layerIndex + 1),
          a = this.lineDraw.path(),
          o = this.isFishbone2()
            ? this.maxx
            : t - i / Math.tan(Wi(this.mindMap.opt.fishboneDeg));
        (a.plot(this.transformPath(`M ${e.left + e.width},${r} L ${o},${r}`)),
          e.style.line(a),
          e._lines.push(a),
          n && n(a, e));
      } else {
        let o = -1 / 0,
          s = 1 / 0,
          l = -1 / 0,
          u = e.left + e.width * this.indent;
        if (
          (e.children.forEach((r, i) => {
            r.left > l && (l = r.left);
            let a = r.top + r.height / 2;
            if ((a > o && (o = a), a < s && (s = a), e.layerIndex > 1)) {
              let e = `M ${u},${a} L ${r.left},${a}`;
              this.setLineStyle(n, t[i], e, r);
            }
          }),
          c >= 0)
        ) {
          let t = this.lineDraw.path();
          a = c > 0 ? a : 0;
          let d = l - e.left - e.width * this.indent;
          d = Math.max(d, 0);
          let f = {
            node: e,
            line: t,
            top: r,
            x: u,
            lineLength: d,
            height: i,
            expandBtnSize: a,
            maxy: o,
            miny: s,
            ctx: this,
          };
          (this.checkIsTop(e) ? Is.top.renderLine(f) : Is.bottom.renderLine(f),
            e.style.line(t),
            e._lines.push(t),
            n && n(t, e));
        }
      }
    }
    renderExpandBtn(e, t) {
      let { width: n, height: r, expandBtnSize: i, isRoot: a } = e;
      if (!a) {
        let { translateX: a, translateY: o } = t.transform(),
          s = {
            node: e,
            btn: t,
            expandBtnSize: i,
            translateX: a,
            translateY: o,
            width: n,
            height: r,
          };
        this.checkIsTop(e)
          ? Is.top.renderExpandBtn(s)
          : Is.bottom.renderExpandBtn(s);
      }
    }
    renderGeneralization(e) {
      e.forEach((e) => {
        let {
            top: t,
            bottom: n,
            right: r,
            generalizationLineMargin: i,
            generalizationNodeMargin: a,
          } = this.getNodeGeneralizationRenderBoundaries(e, `h`),
          o = r + i,
          s = t,
          c = r + i,
          l = n,
          u = `M ${o},${s} Q ${o + 20},${s + (l - s) / 2} ${c},${l}`;
        (e.generalizationLine.plot(this.transformPath(u)),
          (e.generalizationNode.left = r + a),
          (e.generalizationNode.top =
            t + (n - t - e.generalizationNode.height) / 2));
      });
    }
    renderExpandBtnRect(e, t, n, r, i) {
      let a = ``;
      ((a =
        i.dir === w.LAYOUT_GROW_DIR.TOP
          ? i.layerIndex === 1
            ? w.LAYOUT_GROW_DIR.TOP
            : w.LAYOUT_GROW_DIR.BOTTOM
          : i.layerIndex === 1
            ? w.LAYOUT_GROW_DIR.BOTTOM
            : w.LAYOUT_GROW_DIR.TOP),
        a === w.LAYOUT_GROW_DIR.TOP
          ? e.size(n, t).x(0).y(-t)
          : e.size(n, t).x(0).y(r));
    }
    beforeChange() {
      this.isFishbone2() &&
        ((this.root.nodeData.data.shape = w.SHAPE.RECTANGLE),
        this.removeFishTail(),
        this.unBindEvent(),
        this.mindMap.removeShape(`fishHead`));
    }
  },
  Rs = `smm-node-edit-wrap`,
  zs = class {
    constructor(e) {
      ((this.renderer = e),
        (this.mindMap = e.mindMap),
        (this.currentNode = null),
        (this.textEditNode = null),
        (this.showTextEdit = !1),
        (this.cacheEditingText = ``),
        (this.hasBodyMousedown = !1),
        (this.textNodePaddingX = 5),
        (this.textNodePaddingY = 3),
        (this.isNeedUpdateTextEditNode = !1),
        this.mindMap.addEditNodeClass(Rs),
        this.bindEvent());
    }
    bindEvent() {
      ((this.show = this.show.bind(this)),
        (this.onScale = this.onScale.bind(this)),
        (this.onKeydown = this.onKeydown.bind(this)),
        this.mindMap.on(`node_dblclick`, (e, t, n) => {
          this.show({ node: e, e: t, isInserting: n });
        }),
        this.mindMap.on(`draw_click`, () => {
          this.hideEditTextBox();
        }),
        this.mindMap.on(`body_mousedown`, () => {
          this.hasBodyMousedown = !0;
        }),
        this.mindMap.on(`body_click`, () => {
          this.hasBodyMousedown &&
            ((this.hasBodyMousedown = !1),
            this.mindMap.opt.isEndNodeTextEditOnClickOuter &&
              this.hideEditTextBox());
        }),
        this.mindMap.on(`svg_mousedown`, () => {
          this.hideEditTextBox();
        }),
        this.mindMap.on(`expand_btn_click`, () => {
          this.hideEditTextBox();
        }),
        this.mindMap.on(`before_node_active`, () => {
          this.hideEditTextBox();
        }),
        this.mindMap.on(`mousewheel`, () => {
          this.mindMap.opt.mousewheelAction === w.MOUSE_WHEEL_ACTION.MOVE &&
            this.hideEditTextBox();
        }),
        this.mindMap.keyCommand.addShortcut(`F2`, () => {
          this.renderer.activeNodeList.length <= 0 ||
            this.show({ node: this.renderer.activeNodeList[0] });
        }),
        this.mindMap.on(`scale`, this.onScale),
        this.mindMap.opt.enableAutoEnterTextEditWhenKeydown &&
          window.addEventListener(`keydown`, this.onKeydown),
        this.mindMap.on(`beforeDestroy`, () => {
          this.unBindEvent();
        }),
        this.mindMap.on(`after_update_config`, (e, t) => {
          (e.openRealtimeRenderOnNodeTextEdit !==
            t.openRealtimeRenderOnNodeTextEdit &&
            (this.mindMap.richText
              ? this.mindMap.richText.onOpenRealtimeRenderOnNodeTextEditConfigUpdate(
                  e.openRealtimeRenderOnNodeTextEdit,
                )
              : this.onOpenRealtimeRenderOnNodeTextEditConfigUpdate(
                  e.openRealtimeRenderOnNodeTextEdit,
                )),
            e.enableAutoEnterTextEditWhenKeydown !==
              t.enableAutoEnterTextEditWhenKeydown &&
              window[
                e.enableAutoEnterTextEditWhenKeydown
                  ? `addEventListener`
                  : `removeEventListener`
              ](`keydown`, this.onKeydown));
        }),
        this.mindMap.on(`afterExecCommand`, () => {
          this.isShowTextEdit() && (this.isNeedUpdateTextEditNode = !0);
        }),
        this.mindMap.on(`node_tree_render_end`, () => {
          this.isShowTextEdit() &&
            this.isNeedUpdateTextEditNode &&
            ((this.isNeedUpdateTextEditNode = !1), this.updateTextEditNode());
        }));
    }
    unBindEvent() {
      window.removeEventListener(`keydown`, this.onKeydown);
    }
    onKeydown(e) {
      if (e.target !== document.body) return;
      let t = this.mindMap.renderer.activeNodeList;
      if (t.length <= 0 || t.length > 1) return;
      let n = t[0];
      n &&
        this.checkIsAutoEnterTextEditKey(e) &&
        (e.preventDefault(),
        this.show({ node: n, e, isInserting: !1, isFromKeyDown: !0 }));
    }
    checkIsAutoEnterTextEditKey(e) {
      let t = e.keyCode;
      return (
        (t === 229 || (t >= 65 && t <= 90) || (t >= 48 && t <= 57)) &&
        !this.mindMap.keyCommand.hasCombinationKey(e)
      );
    }
    registerTmpShortcut() {
      (this.mindMap.keyCommand.addShortcut(`Enter`, () => {
        this.hideEditTextBox();
      }),
        this.mindMap.keyCommand.addShortcut(`Tab`, () => {
          this.hideEditTextBox();
        }));
    }
    isShowTextEdit() {
      return this.mindMap.richText
        ? this.mindMap.richText.showTextEdit
        : this.showTextEdit;
    }
    setIsShowTextEdit(e) {
      ((this.showTextEdit = e),
        e
          ? this.mindMap.keyCommand.stopCheckInSvg()
          : this.mindMap.keyCommand.recoveryCheckInSvg());
    }
    async show({
      node: e,
      isInserting: t = !1,
      isFromKeyDown: n = !1,
      isFromScale: r = !1,
    }) {
      if (e.isUseCustomNodeContent()) return;
      this.getCurrentEditNode() && this.hideEditTextBox();
      let { beforeTextEdit: i, openRealtimeRenderOnNodeTextEdit: a } =
        this.mindMap.opt;
      if (typeof i == `function`) {
        let n = !1;
        try {
          n = await i(e, t);
        } catch (e) {
          ((n = !1),
            this.mindMap.opt.errorHandler(fe.BEFORE_TEXT_EDIT_ERROR, e));
        }
        if (!n) return;
      }
      let { offsetLeft: o, offsetTop: s } = qi(this.mindMap, e);
      this.mindMap.view.translateXY(o, s);
      let c = e._textData.node;
      a && c.show();
      let l = c.node.getBoundingClientRect();
      a && c.hide();
      let u = {
        node: e,
        rect: l,
        isInserting: t,
        isFromKeyDown: n,
        isFromScale: r,
      };
      if (this.mindMap.richText) {
        this.mindMap.richText.showEditText(u);
        return;
      }
      ((this.currentNode = e), this.showEditTextBox(u));
    }
    onOpenRealtimeRenderOnNodeTextEditConfigUpdate(e) {
      this.textEditNode &&
        ((this.textEditNode.style.background = e
          ? `transparent`
          : this.currentNode
            ? this.getBackground(this.currentNode)
            : ``),
        (this.textEditNode.style.boxShadow = e
          ? `none`
          : `0 0 20px rgba(0,0,0,.5)`));
    }
    onScale() {
      let e = this.getCurrentEditNode();
      e &&
        (this.mindMap.richText
          ? ((this.mindMap.richText.cacheEditingText =
              this.mindMap.richText.getEditText()),
            (this.mindMap.richText.showTextEdit = !1))
          : ((this.cacheEditingText = this.getEditText()),
            this.setIsShowTextEdit(!1)),
        this.show({ node: e, isFromScale: !0 }));
    }
    showEditTextBox({
      node: e,
      rect: t,
      isInserting: n,
      isFromKeyDown: r,
      isFromScale: i,
    }) {
      if (this.showTextEdit) return;
      let {
        nodeTextEditZIndex: a,
        textAutoWrapWidth: o,
        selectTextOnEnterEditText: s,
        openRealtimeRenderOnNodeTextEdit: c,
        autoEmptyTextWhenKeydownEnterEdit: l,
      } = this.mindMap.opt;
      (i || this.mindMap.emit(`before_show_text_edit`),
        this.registerTmpShortcut(),
        this.textEditNode ||
          ((this.textEditNode = document.createElement(`div`)),
          this.textEditNode.classList.add(Rs),
          (this.textEditNode.style.cssText = `
        position: fixed;
        box-sizing: border-box;
        ${c ? `` : `box-shadow: 0 0 20px rgba(0,0,0,.5);`}
        padding: ${this.textNodePaddingY}px ${this.textNodePaddingX}px;
        margin-left: -${this.textNodePaddingX}px;
        margin-top: -${this.textNodePaddingY}px;
        outline: none; 
        word-break: break-all;
        line-break: anywhere;
      `),
          this.textEditNode.setAttribute(`contenteditable`, !0),
          this.textEditNode.addEventListener(`keyup`, (e) => {
            e.stopPropagation();
          }),
          this.textEditNode.addEventListener(`click`, (e) => {
            e.stopPropagation();
          }),
          this.textEditNode.addEventListener(`mousedown`, (e) => {
            e.stopPropagation();
          }),
          this.textEditNode.addEventListener(`keydown`, (e) => {
            this.checkIsAutoEnterTextEditKey(e) && e.stopPropagation();
          }),
          this.textEditNode.addEventListener(`paste`, (e) => {
            let { isSmm: t, data: n } = Oa(e.clipboardData.getData(`text`));
            (t && n[0] && n[0].data ? ka(e, Yi(n[0].data.text)) : ka(e),
              this.emitTextChangeEvent());
          }),
          this.textEditNode.addEventListener(`input`, () => {
            this.emitTextChangeEvent();
          }),
          (
            this.mindMap.opt.customInnerElsAppendTo || document.body
          ).appendChild(this.textEditNode)));
      let u = this.mindMap.view.scale,
        d = e.style.merge(`fontSize`),
        f = (this.cacheEditingText || e.getData(`text`))
          .split(/\n/gim)
          .map((e) => ba(e)),
        p = e._textData.node.attr(`data-ismultiLine`) === `true`;
      (e.style.domText(this.textEditNode, u),
        c || (this.textEditNode.style.background = this.getBackground(e)),
        (this.textEditNode.style.zIndex = a),
        r && l
          ? (this.textEditNode.innerHTML = ``)
          : (this.textEditNode.innerHTML = f.join(`<br>`)),
        (this.textEditNode.style.minWidth =
          t.width + this.textNodePaddingX * 2 + `px`),
        (this.textEditNode.style.minHeight = t.height + `px`),
        (this.textEditNode.style.left = Math.floor(t.left) + `px`),
        (this.textEditNode.style.top = Math.floor(t.top) + `px`),
        (this.textEditNode.style.display = `block`),
        (this.textEditNode.style.maxWidth = o * u + `px`),
        p
          ? ((this.textEditNode.style.lineHeight = T),
            (this.textEditNode.style.transform = `translateY(${(((T - 1) * d) / 2) * u}px)`))
          : (this.textEditNode.style.lineHeight = `normal`),
        this.setIsShowTextEdit(!0),
        n || (s && !r) ? ha(this.textEditNode) : ma(this.textEditNode),
        (this.cacheEditingText = ``));
    }
    emitTextChangeEvent() {
      this.mindMap.emit(`node_text_edit_change`, {
        node: this.currentNode,
        text: this.getEditText(),
        richText: !1,
      });
    }
    updateTextEditNode() {
      if (this.mindMap.richText) {
        this.mindMap.richText.updateTextEditNode();
        return;
      }
      if (!this.showTextEdit || !this.currentNode) return;
      let e = this.currentNode._textData.node.node.getBoundingClientRect();
      ((this.textEditNode.style.minWidth =
        e.width + this.textNodePaddingX * 2 + `px`),
        (this.textEditNode.style.minHeight =
          e.height + this.textNodePaddingY * 2 + `px`),
        (this.textEditNode.style.left = Math.floor(e.left) + `px`),
        (this.textEditNode.style.top = Math.floor(e.top) + `px`));
    }
    getBackground(e) {
      if (e.style.merge(`gradientStyle`))
        return `linear-gradient(to right, ${e.style.merge(`startColor`)}, ${e.style.merge(`endColor`)})`;
      {
        let t = e.style.merge(`fillColor`),
          n = e.style.merge(`color`);
        return t === `transparent`
          ? ra(n)
            ? aa(this.mindMap.themeConfig)
            : `#fff`
          : t;
      }
    }
    removeTextEditEl() {
      if (this.mindMap.richText) {
        this.mindMap.richText.removeTextEditEl();
        return;
      }
      this.textEditNode &&
        (this.mindMap.opt.customInnerElsAppendTo || document.body).removeChild(
          this.textEditNode,
        );
    }
    getEditText() {
      return Ri(this.textEditNode.innerHTML);
    }
    hideEditTextBox() {
      if (this.mindMap.richText) return this.mindMap.richText.hideEditText();
      if (!this.showTextEdit) return;
      let e = this.currentNode,
        t = this.getEditText();
      ((this.currentNode = null),
        (this.textEditNode.style.display = `none`),
        (this.textEditNode.innerHTML = ``),
        (this.textEditNode.style.fontFamily = `inherit`),
        (this.textEditNode.style.fontSize = `inherit`),
        (this.textEditNode.style.fontWeight = `normal`),
        (this.textEditNode.style.transform = `translateY(0)`),
        this.setIsShowTextEdit(!1),
        this.mindMap.execCommand(`SET_NODE_TEXT`, e, t),
        this.mindMap.render(),
        this.mindMap.emit(
          `hide_text_edit`,
          this.textEditNode,
          this.renderer.activeNodeList,
          e,
        ));
    }
    getCurrentEditNode() {
      return this.mindMap.richText
        ? this.mindMap.richText.node
        : this.currentNode;
    }
  },
  Bs = {
    [w.LAYOUT.LOGICAL_STRUCTURE]: As,
    [w.LAYOUT.LOGICAL_STRUCTURE_LEFT]: As,
    [w.LAYOUT.MIND_MAP]: js,
    [w.LAYOUT.CATALOG_ORGANIZATION]: Ms,
    [w.LAYOUT.ORGANIZATION_STRUCTURE]: Ns,
    [w.LAYOUT.TIMELINE]: Ps,
    [w.LAYOUT.TIMELINE2]: Ps,
    [w.LAYOUT.VERTICAL_TIMELINE]: Fs,
    [w.LAYOUT.VERTICAL_TIMELINE2]: Fs,
    [w.LAYOUT.VERTICAL_TIMELINE3]: Fs,
    [w.LAYOUT.FISHBONE]: Ls,
    [w.LAYOUT.FISHBONE2]: Ls,
  },
  Vs = class {
    constructor(e = {}) {
      ((this.opt = e),
        (this.mindMap = e.mindMap),
        (this.themeConfig = this.mindMap.themeConfig),
        (this.renderTree = this.mindMap.opt.data
          ? (0, Te.default)({}, this.mindMap.opt.data)
          : null),
        (this.reRender = !1),
        (this.isRendering = !1),
        (this.hasWaitRendering = !1),
        (this.nodeCache = {}),
        (this.lastNodeCache = {}),
        (this.renderSourceList = []),
        (this.renderCallbackList = []),
        (this.activeNodeList = []),
        (this.emitNodeActiveEventTimer = null),
        (this.renderTimer = null),
        (this.root = null),
        (this.textEdit = new zs(this)),
        (this.beingCopyData = null),
        (this.highlightBoxNode = null),
        (this.highlightBoxNodeStyle = null),
        (this.lastActiveNodeList = []),
        this.setLayout(),
        this.bindEvent(),
        this.registerCommands(),
        this.registerShortcutKeys());
    }
    setLayout() {
      this.layout && this.layout.beforeChange && this.layout.beforeChange();
      let { layout: e } = this.mindMap.opt,
        t = Bs[e] || this.mindMap[e];
      (t ||
        ((t = Bs[w.LAYOUT.LOGICAL_STRUCTURE]),
        (this.mindMap.opt.layout = w.LAYOUT.LOGICAL_STRUCTURE)),
        (this.layout = new t(this, e)));
    }
    setData(e) {
      this.renderTree = e || null;
    }
    bindEvent() {
      let {
        openPerformance: e,
        performanceConfig: t,
        openRealtimeRenderOnNodeTextEdit: n,
      } = this.mindMap.opt;
      (this.mindMap.on(`draw_click`, (e) => {
        this.clearActiveNodeListOnDrawClick(e, `click`);
      }),
        this.mindMap.on(`contextmenu`, (e) => {
          this.clearActiveNodeListOnDrawClick(e, `contextmenu`);
        }),
        this.mindMap.svg.on(`dblclick`, () => {
          this.mindMap.opt.enableDblclickBackToRootNode &&
            this.setRootNodeCenter();
        }));
      let r = Vi(() => {
        this.renderTree &&
          this.root &&
          (this.mindMap.emit(`node_tree_render_start`),
          this.root.render(
            () => {
              this.mindMap.emit(`node_tree_render_end`);
            },
            !1,
            !0,
          ));
      }, t.time);
      (e && this.mindMap.on(`view_data_change`, r),
        (this.onNodeTextEditChange = Hi(this.onNodeTextEditChange, 100, this)),
        n &&
          this.mindMap.on(`node_text_edit_change`, this.onNodeTextEditChange),
        this.mindMap.on(`after_update_config`, (e, t) => {
          (e.openPerformance !== t.openPerformance &&
            (this.mindMap[e.openPerformance ? `on` : `off`](
              `view_data_change`,
              r,
            ),
            this.forceLoadNode()),
            e.openRealtimeRenderOnNodeTextEdit !==
              t.openRealtimeRenderOnNodeTextEdit &&
              this.mindMap[e.openRealtimeRenderOnNodeTextEdit ? `on` : `off`](
                `node_text_edit_change`,
                this.onNodeTextEditChange,
              ));
        }));
    }
    onNodeTextEditChange({ node: e, text: t }) {
      e._textData = e.createTextNode(t);
      let { width: n, height: r } = e.getNodeRect();
      ((e.width = n),
        (e.height = r),
        e.layout(),
        this.mindMap.render(() => {
          this.textEdit.updateTextEditNode();
        }));
    }
    forceLoadNode(e) {
      ((e ||= this.root),
        e &&
          (this.mindMap.emit(`node_tree_render_start`),
          e.render(() => {
            this.mindMap.emit(`node_tree_render_end`);
          }, !0)));
    }
    registerCommands() {
      ((this.selectAll = this.selectAll.bind(this)),
        this.mindMap.command.add(`SELECT_ALL`, this.selectAll),
        (this.back = this.back.bind(this)),
        this.mindMap.command.add(`BACK`, this.back),
        (this.forward = this.forward.bind(this)),
        this.mindMap.command.add(`FORWARD`, this.forward),
        (this.insertNode = this.insertNode.bind(this)),
        this.mindMap.command.add(`INSERT_NODE`, this.insertNode),
        (this.insertMultiNode = this.insertMultiNode.bind(this)),
        this.mindMap.command.add(`INSERT_MULTI_NODE`, this.insertMultiNode),
        (this.insertChildNode = this.insertChildNode.bind(this)),
        this.mindMap.command.add(`INSERT_CHILD_NODE`, this.insertChildNode),
        (this.insertMultiChildNode = this.insertMultiChildNode.bind(this)),
        this.mindMap.command.add(
          `INSERT_MULTI_CHILD_NODE`,
          this.insertMultiChildNode,
        ),
        (this.insertParentNode = this.insertParentNode.bind(this)),
        this.mindMap.command.add(`INSERT_PARENT_NODE`, this.insertParentNode),
        (this.upNode = this.upNode.bind(this)),
        this.mindMap.command.add(`UP_NODE`, this.upNode),
        (this.downNode = this.downNode.bind(this)),
        this.mindMap.command.add(`DOWN_NODE`, this.downNode),
        (this.moveUpOneLevel = this.moveUpOneLevel.bind(this)),
        this.mindMap.command.add(`MOVE_UP_ONE_LEVEL`, this.moveUpOneLevel),
        (this.insertAfter = this.insertAfter.bind(this)),
        this.mindMap.command.add(`INSERT_AFTER`, this.insertAfter),
        (this.insertBefore = this.insertBefore.bind(this)),
        this.mindMap.command.add(`INSERT_BEFORE`, this.insertBefore),
        (this.moveNodeTo = this.moveNodeTo.bind(this)),
        this.mindMap.command.add(`MOVE_NODE_TO`, this.moveNodeTo),
        (this.removeNode = this.removeNode.bind(this)),
        this.mindMap.command.add(`REMOVE_NODE`, this.removeNode),
        (this.removeCurrentNode = this.removeCurrentNode.bind(this)),
        this.mindMap.command.add(`REMOVE_CURRENT_NODE`, this.removeCurrentNode),
        (this.pasteNode = this.pasteNode.bind(this)),
        this.mindMap.command.add(`PASTE_NODE`, this.pasteNode),
        (this.cutNode = this.cutNode.bind(this)),
        this.mindMap.command.add(`CUT_NODE`, this.cutNode),
        (this.setNodeStyle = this.setNodeStyle.bind(this)),
        this.mindMap.command.add(`SET_NODE_STYLE`, this.setNodeStyle),
        (this.setNodeStyles = this.setNodeStyles.bind(this)),
        this.mindMap.command.add(`SET_NODE_STYLES`, this.setNodeStyles),
        (this.setNodeActive = this.setNodeActive.bind(this)),
        this.mindMap.command.add(`SET_NODE_ACTIVE`, this.setNodeActive),
        (this.clearActiveNode = this.clearActiveNode.bind(this)),
        this.mindMap.command.add(`CLEAR_ACTIVE_NODE`, this.clearActiveNode),
        (this.setNodeExpand = this.setNodeExpand.bind(this)),
        this.mindMap.command.add(`SET_NODE_EXPAND`, this.setNodeExpand),
        (this.expandAllNode = this.expandAllNode.bind(this)),
        this.mindMap.command.add(`EXPAND_ALL`, this.expandAllNode),
        (this.unexpandAllNode = this.unexpandAllNode.bind(this)),
        this.mindMap.command.add(`UNEXPAND_ALL`, this.unexpandAllNode),
        (this.expandToLevel = this.expandToLevel.bind(this)),
        this.mindMap.command.add(`UNEXPAND_TO_LEVEL`, this.expandToLevel),
        (this.setNodeData = this.setNodeData.bind(this)),
        this.mindMap.command.add(`SET_NODE_DATA`, this.setNodeData),
        (this.setNodeText = this.setNodeText.bind(this)),
        this.mindMap.command.add(`SET_NODE_TEXT`, this.setNodeText),
        (this.setNodeImage = this.setNodeImage.bind(this)),
        this.mindMap.command.add(`SET_NODE_IMAGE`, this.setNodeImage),
        (this.setNodeIcon = this.setNodeIcon.bind(this)),
        this.mindMap.command.add(`SET_NODE_ICON`, this.setNodeIcon),
        (this.setNodeHyperlink = this.setNodeHyperlink.bind(this)),
        this.mindMap.command.add(`SET_NODE_HYPERLINK`, this.setNodeHyperlink),
        (this.setNodeNote = this.setNodeNote.bind(this)),
        this.mindMap.command.add(`SET_NODE_NOTE`, this.setNodeNote),
        (this.setNodeAttachment = this.setNodeAttachment.bind(this)),
        this.mindMap.command.add(`SET_NODE_ATTACHMENT`, this.setNodeAttachment),
        (this.setNodeTag = this.setNodeTag.bind(this)),
        this.mindMap.command.add(`SET_NODE_TAG`, this.setNodeTag),
        (this.insertFormula = this.insertFormula.bind(this)),
        this.mindMap.command.add(`INSERT_FORMULA`, this.insertFormula),
        (this.addGeneralization = this.addGeneralization.bind(this)),
        this.mindMap.command.add(`ADD_GENERALIZATION`, this.addGeneralization),
        (this.removeGeneralization = this.removeGeneralization.bind(this)),
        this.mindMap.command.add(
          `REMOVE_GENERALIZATION`,
          this.removeGeneralization,
        ),
        (this.setNodeCustomPosition = this.setNodeCustomPosition.bind(this)),
        this.mindMap.command.add(
          `SET_NODE_CUSTOM_POSITION`,
          this.setNodeCustomPosition,
        ),
        (this.resetLayout = this.resetLayout.bind(this)),
        this.mindMap.command.add(`RESET_LAYOUT`, this.resetLayout),
        (this.setNodeShape = this.setNodeShape.bind(this)),
        this.mindMap.command.add(`SET_NODE_SHAPE`, this.setNodeShape),
        (this.goTargetNode = this.goTargetNode.bind(this)),
        this.mindMap.command.add(`GO_TARGET_NODE`, this.goTargetNode),
        (this.removeCustomStyles = this.removeCustomStyles.bind(this)),
        this.mindMap.command.add(
          `REMOVE_CUSTOM_STYLES`,
          this.removeCustomStyles,
        ),
        (this.removeAllNodeCustomStyles =
          this.removeAllNodeCustomStyles.bind(this)),
        this.mindMap.command.add(
          `REMOVE_ALL_NODE_CUSTOM_STYLES`,
          this.removeAllNodeCustomStyles,
        ));
    }
    registerShortcutKeys() {
      (this.mindMap.keyCommand.addShortcut(`Tab`, () => {
        this.mindMap.execCommand(`INSERT_CHILD_NODE`);
      }),
        this.mindMap.keyCommand.addShortcut(`Insert`, () => {
          this.mindMap.execCommand(`INSERT_CHILD_NODE`);
        }),
        this.mindMap.keyCommand.addShortcut(`Enter`, () => {
          this.mindMap.execCommand(`INSERT_NODE`);
        }),
        this.mindMap.keyCommand.addShortcut(`Shift+Tab`, () => {
          this.mindMap.execCommand(`INSERT_PARENT_NODE`);
        }),
        this.mindMap.keyCommand.addShortcut(`Control+g`, () => {
          this.mindMap.execCommand(`ADD_GENERALIZATION`);
        }),
        (this.toggleActiveExpand = this.toggleActiveExpand.bind(this)),
        this.mindMap.keyCommand.addShortcut(`/`, this.toggleActiveExpand),
        this.mindMap.keyCommand.addShortcut(`Del|Backspace`, () => {
          this.mindMap.execCommand(`REMOVE_NODE`);
        }),
        this.mindMap.keyCommand.addShortcut(`Shift+Backspace`, () => {
          this.mindMap.execCommand(`REMOVE_CURRENT_NODE`);
        }),
        this.mindMap.on(`before_show_text_edit`, () => {
          this.startTextEdit();
        }),
        this.mindMap.on(`hide_text_edit`, () => {
          this.endTextEdit();
        }),
        this.mindMap.keyCommand.addShortcut(`Control+a`, () => {
          this.mindMap.execCommand(`SELECT_ALL`);
        }),
        this.mindMap.keyCommand.addShortcut(`Control+l`, () => {
          this.mindMap.execCommand(`RESET_LAYOUT`);
        }),
        this.mindMap.keyCommand.addShortcut(`Control+Up`, () => {
          this.mindMap.execCommand(`UP_NODE`);
        }),
        this.mindMap.keyCommand.addShortcut(`Control+Down`, () => {
          this.mindMap.execCommand(`DOWN_NODE`);
        }),
        this.mindMap.keyCommand.addShortcut(`Control+c`, () => {
          this.copy();
        }),
        this.mindMap.keyCommand.addShortcut(`Control+x`, () => {
          this.cut();
        }),
        this.mindMap.keyCommand.addShortcut(`Control+v`, () => {
          this.paste();
        }),
        this.mindMap.keyCommand.addShortcut(`Control+Enter`, () => {
          this.setRootNodeCenter();
        }));
    }
    emitNodeActiveEvent(e = null, t = [...this.activeNodeList]) {
      Ea(this.lastActiveNodeList, t) ||
        ((this.lastActiveNodeList = [...t]),
        clearTimeout(this.emitNodeActiveEventTimer),
        (this.emitNodeActiveEventTimer = setTimeout(() => {
          this.mindMap.emit(`node_active`, e, t);
        }, 0)));
    }
    clearActiveNodeListOnDrawClick(e, t) {
      if (this.activeNodeList.length <= 0) return;
      let n = !0,
        { useLeftKeySelectionRightKeyDrag: r } = this.mindMap.opt;
      if (t === `contextmenu` ? !r : r) {
        let t = this.mindMap.event.mousedownPos;
        n = Math.abs(e.clientX - t.x) <= 5 && Math.abs(e.clientY - t.y) <= 5;
      }
      n && this.mindMap.execCommand(`CLEAR_ACTIVE_NODE`);
    }
    startTextEdit() {
      this.mindMap.keyCommand.save();
    }
    endTextEdit() {
      this.mindMap.keyCommand.restore();
    }
    clearCache() {
      (this.layout.lru.clear(),
        (this.nodeCache = {}),
        (this.lastNodeCache = {}));
    }
    addRenderParams(e, t) {
      (e &&
        this.renderCallbackList.findIndex((t) => t === e) === -1 &&
        this.renderCallbackList.push(e),
        t &&
          this.renderSourceList.findIndex((e) => e === t) === -1 &&
          this.renderSourceList.push(t));
    }
    checkHasRenderSource(e) {
      e = Array.isArray(e) ? e : [e];
      for (let t = 0; t < this.renderSourceList.length; t++)
        if (e.includes(this.renderSourceList[t])) return !0;
      return !1;
    }
    onRenderEnd() {
      (this.renderCallbackList.forEach((e) => {
        e();
      }),
        (this.isRendering = !1),
        (this.reRender = !1),
        (this.renderCallbackList = []),
        (this.renderSourceList = []),
        this.mindMap.emit(`node_tree_render_end`));
    }
    render(e, t) {
      (this.addRenderParams(e, t),
        clearTimeout(this.renderTimer),
        (this.renderTimer = setTimeout(() => {
          this._render();
        }, 0)));
    }
    _render() {
      if (
        (this.checkHasRenderSource(w.CHANGE_THEME) &&
          this.resetUnExpandNodeStyle(),
        this.isRendering)
      ) {
        this.hasWaitRendering = !0;
        return;
      }
      if (
        ((this.isRendering = !0),
        (this.lastNodeCache = this.nodeCache),
        (this.nodeCache = {}),
        this.reRender && this.clearActiveNodeList(),
        !this.renderTree)
      ) {
        this.onRenderEnd();
        return;
      }
      (this.mindMap.emit(`node_tree_render_start`),
        (this.root = null),
        this.layout.doLayout((e) => {
          (Object.keys(this.lastNodeCache).forEach((e) => {
            this.nodeCache[e] ||
              (this.removeNodeFromActiveList(this.lastNodeCache[e]),
              this.emitNodeActiveEvent(),
              this.lastNodeCache[e].destroy());
          }),
            (this.root = e),
            this.root.render(() => {
              if (((this.isRendering = !1), this.hasWaitRendering)) {
                ((this.hasWaitRendering = !1), this.render());
                return;
              }
              this.onRenderEnd();
            }));
        }),
        this.emitNodeActiveEvent());
    }
    renderByCustomNodeContentNode(e) {
      (e.getSize(), e.customNodeContentRealtimeLayout(), this.mindMap.render());
    }
    resetUnExpandNodeStyle() {
      this.renderTree &&
        Y(this.renderTree, null, (e) => {
          if (!e.data.expand)
            return (
              Y(e, null, (e) => {
                e.data.needUpdate = !0;
              }),
              !0
            );
        });
    }
    clearActiveNode() {
      this.activeNodeList.length <= 0 ||
        (this.clearActiveNodeList(), this.emitNodeActiveEvent(null, []));
    }
    clearActiveNodeList() {
      (this.activeNodeList.forEach((e) => {
        this.mindMap.execCommand(`SET_NODE_ACTIVE`, e, !1);
      }),
        (this.activeNodeList = []));
    }
    addNodeToActiveList(e, t = !1) {
      (this.mindMap.opt.onlyOneEnableActiveNodeOnCooperate &&
        e.userList.length > 0) ||
        (this.findActiveNodeIndex(e) === -1 &&
          (t || this.mindMap.emit(`before_node_active`, e, this.activeNodeList),
          this.mindMap.execCommand(`SET_NODE_ACTIVE`, e, !0),
          this.activeNodeList.push(e)));
    }
    removeNodeFromActiveList(e) {
      let t = this.findActiveNodeIndex(e);
      t !== -1 &&
        (this.mindMap.execCommand(`SET_NODE_ACTIVE`, e, !1),
        this.activeNodeList.splice(t, 1));
    }
    activeMultiNode(e = []) {
      e.forEach((e) => {
        (this.mindMap.emit(`before_node_active`, e, this.activeNodeList),
          this.addNodeToActiveList(e, !0),
          this.emitNodeActiveEvent(e));
      });
    }
    cancelActiveMultiNode(e = []) {
      e.forEach((e) => {
        (this.removeNodeFromActiveList(e), this.emitNodeActiveEvent(null));
      });
    }
    findActiveNodeIndex(e) {
      return Q(e, this.activeNodeList);
    }
    selectAll() {
      this.mindMap.opt.readonly ||
        (Y(
          this.root,
          null,
          (e) => {
            (e.getData(`isActive`) || this.addNodeToActiveList(e),
              e._generalizationList &&
                e._generalizationList.length > 0 &&
                e._generalizationList.forEach((e) => {
                  let t = e.generalizationNode;
                  t.getData(`isActive`) || this.addNodeToActiveList(t);
                }));
          },
          null,
          !0,
          0,
          0,
        ),
        this.emitNodeActiveEvent());
    }
    back(e) {
      this.backForward(`back`, e);
    }
    forward(e) {
      this.backForward(`forward`, e);
    }
    backForward(e, t) {
      this.mindMap.execCommand(`CLEAR_ACTIVE_NODE`);
      let n = this.mindMap.command[e](t);
      (n && ((this.renderTree = n), this.mindMap.render()),
        this.mindMap.emit(`data_change`, n));
    }
    getNewNodeBehavior(e = !1, t = !1) {
      let { createNewNodeBehavior: n } = this.mindMap.opt,
        r = !1,
        i = !1;
      switch (n) {
        case w.CREATE_NEW_NODE_BEHAVIOR.DEFAULT:
          ((r = t || !e), (i = t ? !1 : e));
          break;
        case w.CREATE_NEW_NODE_BEHAVIOR.NOT_ACTIVE:
          ((r = !1), (i = !1));
          break;
        case w.CREATE_NEW_NODE_BEHAVIOR.ACTIVE_ONLY:
          ((r = !0), (i = !1));
          break;
        default:
          break;
      }
      return { focusNewNode: r, inserting: i };
    }
    insertNode(e = !0, t = [], n = null, r = []) {
      if (((t = Z(t)), this.activeNodeList.length <= 0 && t.length <= 0))
        return;
      this.textEdit.hideEditTextBox();
      let {
          defaultInsertSecondLevelNodeText: i,
          defaultInsertBelowSecondLevelNodeText: a,
        } = this.mindMap.opt,
        o = t.length > 0 ? t : this.activeNodeList,
        s = o.length > 1,
        c = this.hasRichTextPlugin(),
        { focusNewNode: l, inserting: u } = this.getNewNodeBehavior(e, s),
        d = { expand: !0, richText: c, isActive: l };
      (c && (d.resetRichText = !0), (r = ga(r, d)));
      let f = n && n.richText,
        p = !1;
      (o.forEach((e) => {
        if (e.isGeneralization || e.isRoot) return;
        r = X(r);
        let t = e.parent,
          o = e.layerIndex === 1 ? i : a,
          s = va(e);
        f && d.resetRichText && delete d.resetRichText;
        let c = {
          inserting: u,
          data: { text: o, ...d, uid: Zi(), ...(n || {}) },
          children: [..._a(r, p)],
        };
        ((p = !0), t.nodeData.children.splice(s + 1, 0, c));
      }),
        l && this.clearActiveNodeList(),
        this.mindMap.render());
    }
    insertMultiNode(e, t) {
      if (
        !t ||
        t.length <= 0 ||
        ((e = Z(e)), this.activeNodeList.length <= 0 && e.length <= 0)
      )
        return;
      this.textEdit.hideEditTextBox();
      let n = e.length > 0 ? e : this.activeNodeList,
        r = this.hasRichTextPlugin(),
        { focusNewNode: i } = this.getNewNodeBehavior(!1, !0),
        a = { expand: !0, richText: r, isActive: i };
      (r && (a.resetRichText = !0), (t = ga(t, a)));
      let o = !1;
      (n.forEach((e) => {
        if (e.isGeneralization || e.isRoot) return;
        t = X(t);
        let n = e.parent,
          r = va(e),
          i = _a(t, o);
        ((o = !0), n.nodeData.children.splice(r + 1, 0, ...i));
      }),
        i && this.clearActiveNodeList(),
        this.mindMap.render());
    }
    insertChildNode(e = !0, t = [], n = null, r = []) {
      if (((t = Z(t)), this.activeNodeList.length <= 0 && t.length <= 0))
        return;
      this.textEdit.hideEditTextBox();
      let {
          defaultInsertSecondLevelNodeText: i,
          defaultInsertBelowSecondLevelNodeText: a,
        } = this.mindMap.opt,
        o = t.length > 0 ? t : this.activeNodeList,
        s = o.length > 1,
        c = this.hasRichTextPlugin(),
        { focusNewNode: l, inserting: u } = this.getNewNodeBehavior(e, s),
        d = { expand: !0, richText: c, isActive: l };
      (c && (d.resetRichText = !0), (r = ga(r, d)));
      let f = n && n.richText,
        p = !1;
      (o.forEach((e) => {
        if (e.isGeneralization) return;
        ((r = X(r)), e.nodeData.children || (e.nodeData.children = []));
        let t = e.isRoot ? i : a;
        f && d.resetRichText && delete d.resetRichText;
        let o = {
          inserting: u,
          data: { text: t, uid: Zi(), ...d, ...(n || {}) },
          children: [..._a(r, p)],
        };
        ((p = !0), e.nodeData.children.push(o), e.setData({ expand: !0 }));
      }),
        l && this.clearActiveNodeList(),
        this.mindMap.render());
    }
    insertMultiChildNode(e, t) {
      if (
        !t ||
        t.length <= 0 ||
        ((e = Z(e)), this.activeNodeList.length <= 0 && e.length <= 0)
      )
        return;
      this.textEdit.hideEditTextBox();
      let n = e.length > 0 ? e : this.activeNodeList,
        r = this.hasRichTextPlugin(),
        { focusNewNode: i } = this.getNewNodeBehavior(!1, !0),
        a = { expand: !0, richText: r, isActive: i };
      (r && (a.resetRichText = !0), (t = ga(t, a)));
      let o = !1;
      (n.forEach((e) => {
        e.isGeneralization ||
          ((t = X(t)),
          e.nodeData.children || (e.nodeData.children = []),
          (t = _a(t, o)),
          (o = !0),
          e.nodeData.children.push(...t),
          e.setData({ expand: !0 }));
      }),
        i && this.clearActiveNodeList(),
        this.mindMap.render());
    }
    insertParentNode(e = !0, t, n) {
      if (((t = Z(t)), this.activeNodeList.length <= 0 && t.length <= 0))
        return;
      this.textEdit.hideEditTextBox();
      let {
          defaultInsertSecondLevelNodeText: r,
          defaultInsertBelowSecondLevelNodeText: i,
        } = this.mindMap.opt,
        a = t.length > 0 ? t : this.activeNodeList,
        o = a.length > 1,
        s = this.hasRichTextPlugin(),
        { focusNewNode: c, inserting: l } = this.getNewNodeBehavior(e, o),
        u = { expand: !0, richText: s, isActive: c };
      s && (u.resetRichText = !0);
      let d = n && n.richText;
      (a.forEach((e) => {
        if (e.isGeneralization || e.isRoot) return;
        let t = e.layerIndex === 1 ? r : i;
        d && u.resetRichText && delete u.resetRichText;
        let a = {
            inserting: l,
            data: { text: t, uid: Zi(), ...u, ...(n || {}) },
            children: [e.nodeData],
          },
          o = e.parent,
          s = va(e);
        o.nodeData.children.splice(s, 1, a);
      }),
        c && this.clearActiveNodeList(),
        this.mindMap.render());
    }
    upNode(e) {
      if (this.activeNodeList.length <= 0 && !e) return;
      let t = (e ? [e] : this.activeNodeList)[0];
      if (t.isRoot) return;
      let n = t.parent,
        r = n.children,
        i = Q(t, r);
      if (i === -1 || i === 0) return;
      let a = i - 1;
      (r.splice(i, 1),
        r.splice(a, 0, t),
        n.nodeData.children.splice(i, 1),
        n.nodeData.children.splice(a, 0, t.nodeData),
        this.mindMap.render());
    }
    downNode(e) {
      if (this.activeNodeList.length <= 0 && !e) return;
      let t = (e ? [e] : this.activeNodeList)[0];
      if (t.isRoot) return;
      let n = t.parent,
        r = n.children,
        i = Q(t, r);
      if (i === -1 || i === r.length - 1) return;
      let a = i + 1;
      (r.splice(i, 1),
        r.splice(a, 0, t),
        n.nodeData.children.splice(i, 1),
        n.nodeData.children.splice(a, 0, t.nodeData),
        this.mindMap.render());
    }
    moveUpOneLevel(e) {
      if (((e ||= this.activeNodeList[0]), !e || e.isRoot || e.layerIndex <= 1))
        return;
      let t = e.parent,
        n = t.parent,
        r = Q(e, t.children),
        i = Q(t, n.children);
      (t.nodeData.children.splice(r, 1),
        n.nodeData.children.splice(i + 1, 0, e.nodeData),
        this.mindMap.render());
    }
    _handleRemoveCustomStyles(e) {
      let t = !1;
      return (
        Object.keys(e).forEach((n) => {
          la(n) && ((t = !0), delete e[n]);
        }),
        this.hasRichTextPlugin() && ((t = !0), (e.resetRichText = !0)),
        t
      );
    }
    removeCustomStyles(e) {
      ((e ||= this.activeNodeList[0]),
        e &&
          this._handleRemoveCustomStyles(e.getData()) &&
          this.reRenderNodeCheckChange(e));
    }
    removeAllNodeCustomStyles(e) {
      e = Z(e);
      let t = !1;
      if (e.length > 0)
        e.forEach((e) => {
          this._handleRemoveCustomStyles(e.getData()) && (t = !0);
        });
      else {
        if (!this.renderTree) return;
        Y(this.renderTree, null, (e) => {
          this._handleRemoveCustomStyles(e.data) && (t = !0);
          let n = Fa(e.data);
          n.length > 0 &&
            n.forEach((e) => {
              this._handleRemoveCustomStyles(e) && (t = !0);
            });
        });
      }
      t && this.mindMap.reRender();
    }
    copy() {
      ((this.beingCopyData = this.copyNode()),
        this.beingCopyData &&
          (this.mindMap.opt.disabledClipboard || Ca(Da(this.beingCopyData))));
    }
    cut() {
      this.mindMap.execCommand(`CUT_NODE`, (e) => {
        ((this.beingCopyData = e),
          this.mindMap.opt.disabledClipboard || Ca(Da(e)));
      });
    }
    handlePaste(e) {
      let { disabledClipboard: t } = this.mindMap.opt;
      if (t) return;
      let n = e.clipboardData || e.originalEvent.clipboardData,
        r = n.items;
      (Array.from(r).forEach((e) => {
        (e.type.indexOf(`image`) > -1 && e.getAsFile(),
          e.type.indexOf(`text`) > -1 && n.getData(`text`));
      }),
        this.paste());
    }
    async paste() {
      let {
        errorHandler: e,
        handleIsSplitByWrapOnPasteCreateNewNode: t,
        handleNodePasteImg: n,
        disabledClipboard: r,
        onlyPasteTextWhenHasImgAndText: i,
      } = this.mindMap.opt;
      if (!r && Sa())
        try {
          let r = await wa(),
            a = r.text || ``,
            o = r.img || null;
          if (a) {
            let n = null,
              r = !0;
            if (this.mindMap.opt.customHandleClipboardText)
              try {
                let e = await this.mindMap.opt.customHandleClipboardText(a);
                if (!ea(e)) {
                  r = !1;
                  let t = Oa(e);
                  t.isSmm ? (n = t.data) : (a = t.data);
                }
              } catch (t) {
                e(fe.CUSTOM_HANDLE_CLIPBOARD_TEXT_ERROR, t);
              }
            if (r) {
              let e = Oa(a);
              e.isSmm ? (n = e.data) : (a = e.data);
            }
            if (n)
              this.mindMap.execCommand(
                `INSERT_MULTI_CHILD_NODE`,
                [],
                Array.isArray(n) ? n : [n],
              );
            else {
              this.hasRichTextPlugin() && (a = ba(a));
              let e = a
                .split(
                  RegExp(
                    `\r?
|(?<!
)\r`,
                    `g`,
                  ),
                )
                .filter((e) => !!e);
              e.length > 1 && t
                ? t()
                    .then(() => {
                      this.mindMap.execCommand(
                        `INSERT_MULTI_CHILD_NODE`,
                        [],
                        e.map((e) => ({ data: { text: e }, children: [] })),
                      );
                    })
                    .catch(() => {
                      this.mindMap.execCommand(`INSERT_CHILD_NODE`, !1, [], {
                        text: a,
                      });
                    })
                : this.mindMap.execCommand(`INSERT_CHILD_NODE`, !1, [], {
                    text: a,
                  });
            }
          }
          if (o && (!a || !i))
            try {
              let e = null;
              ((e = n && typeof n == `function` ? await n(o) : await Qi(o)),
                this.activeNodeList.length > 0 &&
                  this.activeNodeList.forEach((t) => {
                    this.mindMap.execCommand(`SET_NODE_IMAGE`, t, {
                      url: e.url,
                      title: ``,
                      width: e.size.width,
                      height: e.size.height,
                    });
                  }));
            } catch (t) {
              e(fe.LOAD_CLIPBOARD_IMAGE_ERROR, t);
            }
        } catch (t) {
          e(fe.READ_CLIPBOARD_ERROR, t);
        }
      else
        this.beingCopyData &&
          this.mindMap.execCommand(`PASTE_NODE`, this.beingCopyData);
    }
    insertBefore(e, t) {
      this.insertTo(e, t, `before`);
    }
    insertAfter(e, t) {
      this.insertTo(e, t, `after`);
    }
    insertTo(e, t, n = `before`) {
      let r = Z(e);
      ((r = r.filter((e) => !e.isRoot)),
        n === `after` && r.reverse(),
        r.forEach((e) => {
          let r = e.parent,
            i = r.children,
            a = Q(e, i);
          if (a === -1) return;
          (i.splice(a, 1), r.nodeData.children.splice(a, 1));
          let o = t.parent,
            s = o.children,
            c = Q(t, s);
          c !== -1 &&
            (n === `after` && c++,
            s.splice(c, 0, e),
            o.nodeData.children.splice(c, 0, e.nodeData));
        }),
        this.mindMap.render());
    }
    removeNode(e = []) {
      if (((e = Z(e)), this.activeNodeList.length <= 0 && e.length <= 0))
        return;
      let t = null,
        n = e.length > 0,
        r = n ? e : this.activeNodeList,
        i = r.find((e) => e.isRoot);
      if (i)
        (this.clearActiveNodeList(),
          (i.children = []),
          (i.nodeData.children = []));
      else {
        t = this.getNextActiveNode(r);
        for (let e = 0; e < r.length; e++) {
          let t = r[e],
            i = this.textEdit.getCurrentEditNode();
          (i &&
            i.getData(`uid`) === t.getData(`uid`) &&
            this.textEdit.hideEditTextBox(),
            n && r.splice(e, 1),
            t.isGeneralization
              ? (this.deleteNodeGeneralization(t),
                this.removeNodeFromActiveList(t),
                e--)
              : (this.removeNodeFromActiveList(t), Ta(t), e--));
        }
      }
      ((this.activeNodeList = []),
        t && this.addNodeToActiveList(t),
        this.emitNodeActiveEvent(),
        this.mindMap.render());
    }
    deleteNodeGeneralization(e) {
      let t = e.generalizationBelongNode,
        n = t.getGeneralizationNodeIndex(e),
        r = t.getData(`generalization`);
      (Array.isArray(r) ? r.splice(n, 1) : (r = null),
        this.mindMap.execCommand(`SET_NODE_DATA`, t, { generalization: r }),
        this.closeHighlightNode());
    }
    removeCurrentNode(e = []) {
      if (((e = Z(e)), this.activeNodeList.length <= 0 && e.length <= 0))
        return;
      let t = e.length > 0 ? e : this.activeNodeList;
      t = t.filter((e) => !e.isRoot);
      let n = this.getNextActiveNode(t);
      for (let e = 0; e < t.length; e++) {
        let n = t[e];
        if (n.isGeneralization) this.deleteNodeGeneralization(n);
        else {
          let e = n.parent,
            t = va(n);
          e.nodeData.children.splice(t, 1, ...(n.nodeData.children || []));
        }
      }
      ((this.activeNodeList = []),
        n && this.addNodeToActiveList(n),
        this.emitNodeActiveEvent(),
        this.mindMap.render());
    }
    getNextActiveNode(e) {
      if (e.length !== 1 || this.findActiveNodeIndex(e[0]) === -1) return null;
      let t = null;
      if (
        this.activeNodeList.length === 1 &&
        !this.activeNodeList[0].isGeneralization &&
        this.mindMap.opt.deleteNodeActive
      ) {
        let e = this.activeNodeList[0],
          n = e.parent.children,
          r = Q(e, n);
        t = r < n.length - 1 ? n[r + 1] : r > 0 ? n[r - 1] : e.parent;
      }
      return t;
    }
    copyNode() {
      if (this.activeNodeList.length <= 0) return null;
      let e = fa(this.activeNodeList);
      return ((e = La(e)), e.map((e) => Bi({}, e, !0)));
    }
    cutNode(e) {
      if (this.activeNodeList.length <= 0) return;
      let t = fa(this.activeNodeList).filter((e) => !e.isRoot);
      t = La(t);
      let n = t.map((e) => Bi({}, e, !0));
      (t.forEach((e) => {
        Ta(e);
      }),
        this.clearActiveNodeList(),
        this.mindMap.render(),
        e && typeof e == `function` && e(n));
    }
    moveNodeTo(e, t) {
      let n = Z(e);
      ((n = n.filter((e) => !e.isRoot)),
        n.forEach((e) => {
          (this.removeNodeFromActiveList(e),
            Ta(e),
            t.setData({ expand: !0 }),
            t.nodeData.children.push(e.nodeData));
        }),
        this.emitNodeActiveEvent(),
        this.mindMap.render());
    }
    pasteNode(e) {
      ((e = Z(e)), this.mindMap.execCommand(`INSERT_MULTI_CHILD_NODE`, [], e));
    }
    setNodeStyle(e, t, n) {
      let r = { [t]: n };
      (this.setNodeDataRender(e, r),
        Fi.includes(t) && (e.parent || e).renderLine(!0));
    }
    setNodeStyles(e, t) {
      let n = { ...t };
      this.setNodeDataRender(e, n);
      let r = Object.keys(t),
        i = !1;
      (r.forEach((e) => {
        Fi.includes(e) && (i = !0);
      }),
        i && (e.parent || e).renderLine(!0));
    }
    setNodeActive(e, t) {
      (this.mindMap.execCommand(`SET_NODE_DATA`, e, { isActive: t }),
        e.updateNodeByActive(t));
    }
    setNodeExpand(e, t) {
      (this.mindMap.execCommand(`SET_NODE_DATA`, e, { expand: t }),
        this.mindMap.render());
    }
    expandAllNode(e = ``) {
      if (!this.renderTree) return;
      let t = (n, r) => {
        (!r && n.data.uid === e && (r = !0),
          r && !n.data.expand && (n.data.expand = !0),
          n.children &&
            n.children.length > 0 &&
            n.children.forEach((e) => {
              t(e, r);
            }));
      };
      (t(this.renderTree, !e), this.mindMap.render());
    }
    unexpandAllNode(e = !0, t = ``) {
      if (!this.renderTree) return;
      let n = (e, r, i) => {
        (!i && e.data.uid === t && (i = !0),
          i &&
            !r &&
            e.children &&
            e.children.length > 0 &&
            (e.data.expand = !1),
          e.children &&
            e.children.length > 0 &&
            e.children.forEach((e) => {
              n(e, !1, i);
            }));
      };
      (n(this.renderTree, !0, !t),
        this.mindMap.render(() => {
          e && this.setRootNodeCenter();
        }));
    }
    expandToLevel(e) {
      this.renderTree &&
        (Y(
          this.renderTree,
          null,
          (t, n, r, i) => {
            i < e
              ? (t.data.expand = !0)
              : !r &&
                t.children &&
                t.children.length > 0 &&
                (t.data.expand = !1);
          },
          null,
          !0,
          0,
          0,
        ),
        this.mindMap.render());
    }
    toggleActiveExpand() {
      this.activeNodeList.forEach((e) => {
        e.nodeData.children.length <= 0 || e.isRoot || this.toggleNodeExpand(e);
      });
    }
    toggleNodeExpand(e) {
      this.mindMap.execCommand(`SET_NODE_EXPAND`, e, !e.getData(`expand`));
    }
    setNodeText(e, t, n, r) {
      ((n = n === void 0 ? e.getData(`richText`) : n),
        this.setNodeDataRender(e, { text: t, richText: n, resetRichText: r }));
    }
    setNodeImage(e, t) {
      let {
        url: n,
        title: r,
        width: i,
        height: a,
        custom: o = !1,
      } = t || { url: ``, title: ``, width: 0, height: 0, custom: !1 };
      this.setNodeDataRender(e, {
        image: n,
        imageTitle: r || ``,
        imageSize: { width: i, height: a, custom: o },
      });
    }
    setNodeIcon(e, t) {
      this.setNodeDataRender(e, { icon: t });
    }
    setNodeHyperlink(e, t, n = ``) {
      this.setNodeDataRender(e, { hyperlink: t, hyperlinkTitle: n });
    }
    setNodeNote(e, t) {
      this.setNodeDataRender(e, { note: t });
    }
    setNodeAttachment(e, t, n = ``) {
      this.setNodeDataRender(e, { attachmentUrl: t, attachmentName: n });
    }
    setNodeTag(e, t) {
      this.setNodeDataRender(e, { tag: t });
    }
    insertFormula(e, t = []) {
      !this.hasRichTextPlugin() ||
        !this.mindMap.formula ||
        ((t = Z(t)),
        (t.length > 0 ? t : this.activeNodeList).forEach((t) => {
          this.mindMap.formula.insertFormulaToNode(t, e);
        }));
    }
    addGeneralization(e, t = !0) {
      if (this.activeNodeList.length <= 0) return;
      let n = pa(
        this.activeNodeList.filter(
          (e) =>
            !e.isRoot && !e.isGeneralization && !e.checkHasSelfGeneralization(),
        ),
      );
      if (n.length <= 0) return;
      let r = this.hasRichTextPlugin(),
        { focusNewNode: i, inserting: a } = this.getNewNodeBehavior(
          t,
          n.length > 1,
        ),
        o = !1,
        s = e && e.richText;
      (n.forEach((t) => {
        let n = {
          inserting: a,
          ...(e || { text: this.mindMap.opt.defaultGeneralizationText }),
          range: t.range || null,
          uid: Zi(),
          richText: r,
          isActive: i,
        };
        r && !s && (n.resetRichText = r);
        let c = t.node.getData(`generalization`);
        if (((c = c ? (Array.isArray(c) ? c : [c]) : []), t.range)) {
          if (
            c.find(
              (e) =>
                e.range &&
                e.range[0] === t.range[0] &&
                e.range[1] === t.range[1],
            )
          )
            return;
          c.push(n);
        } else c.push(n);
        ((o = !0),
          this.mindMap.execCommand(`SET_NODE_DATA`, t.node, {
            generalization: c,
          }),
          t.node.setData({ expand: !0 }));
      }),
        o &&
          (i && this.clearActiveNodeList(),
          this.mindMap.render(() => {
            this.mindMap.render();
          })));
    }
    removeGeneralization() {
      this.activeNodeList.length <= 0 ||
        (this.activeNodeList.forEach((e) => {
          e.checkHasGeneralization() &&
            this.mindMap.execCommand(`SET_NODE_DATA`, e, {
              generalization: null,
            });
        }),
        this.mindMap.render(),
        this.closeHighlightNode());
    }
    setNodeCustomPosition(e, t = void 0, n = void 0) {
      [e].forEach((e) => {
        this.mindMap.execCommand(`SET_NODE_DATA`, e, {
          customLeft: t,
          customTop: n,
        });
      });
    }
    resetLayout() {
      Y(
        this.root,
        null,
        (e) => {
          ((e.customLeft = void 0),
            (e.customTop = void 0),
            this.mindMap.execCommand(`SET_NODE_DATA`, e, {
              customLeft: void 0,
              customTop: void 0,
            }),
            this.mindMap.render());
        },
        null,
        !0,
        0,
        0,
      );
    }
    setNodeShape(e, t) {
      !t ||
        !Wa.includes(t) ||
        [e].forEach((e) => {
          this.setNodeStyle(e, `shape`, t);
        });
    }
    goTargetNode(e, t = () => {}) {
      let n = typeof e == `string` ? e : e.getData(`uid`);
      n &&
        this.expandToNodeUid(n, () => {
          let e = this.findNodeByUid(n);
          e && (e.active(), this.moveNodeToCenter(e), t(e));
        });
    }
    setNodeData(e, t) {
      Object.keys(t).forEach((n) => {
        e.nodeData.data[n] = t[n];
      });
    }
    setNodeDataRender(e, t, n = !1) {
      if ((this.mindMap.execCommand(`SET_NODE_DATA`, e, t), ua(t))) {
        this.mindMap.emit(`node_tree_render_end`);
        return;
      }
      this.reRenderNodeCheckChange(e, n);
    }
    reRenderNodeCheckChange(e, t) {
      e.reRender()
        ? t || this.mindMap.render()
        : this.mindMap.emit(`node_tree_render_end`);
    }
    moveNodeToCenter(e, t) {
      let { resetScaleOnMoveNodeToCenter: n } = this.mindMap.opt;
      t !== void 0 && (n = t);
      let { transform: r, state: i } = this.mindMap.view.getTransformData(),
        { left: a, top: o, width: s, height: c } = e;
      n || ((a *= r.scaleX), (o *= r.scaleY), (s *= r.scaleX), (c *= r.scaleY));
      let l = this.mindMap.width / 2,
        u = this.mindMap.height / 2,
        d = a + s / 2,
        f = o + c / 2,
        p = l - i.x,
        m = u - i.y,
        h = p - d,
        g = m - f;
      (this.mindMap.view.translateX(h),
        this.mindMap.view.translateY(g),
        n && this.mindMap.view.setScale(1));
    }
    setRootNodeCenter() {
      this.moveNodeToCenter(this.root);
    }
    expandToNodeUid(e, t = () => {}) {
      if (!this.renderTree) {
        t();
        return;
      }
      let n = [],
        r = !1,
        i = {};
      Ii(this.renderTree, (t, a) => {
        if (t.data.uid === e)
          return ((n = a ? [...i[a.data.uid], a] : []), `stop`);
        if (
          (Fa(t.data).forEach((o) => {
            o.uid === e && ((n = a ? [...i[a.data.uid], a, t] : []), (r = !0));
          }),
          r)
        )
          return `stop`;
        i[t.data.uid] = a ? [...i[a.data.uid], a] : [];
      });
      let a = !1;
      if (
        (n.forEach((e) => {
          e.data.expand || ((a = !0), (e.data.expand = !0));
        }),
        r)
      ) {
        let e = n[n.length - 1];
        e &&
          Y(e, null, (e) => {
            e.data.expand || ((a = !0), (e.data.expand = !0));
          });
      }
      a ? this.mindMap.render(t) : t();
    }
    findNodeByUid(e) {
      if (!this.root) return;
      let t = null;
      return (
        Y(this.root, null, (n) => {
          if (n.getData(`uid`) === e) return ((t = n), !0);
          let r = !1;
          if (
            ((n._generalizationList || []).forEach((n) => {
              n.generalizationNode.getData(`uid`) === e &&
                ((t = n.generalizationNode), (r = !0));
            }),
            r)
          )
            return !0;
        }),
        t
      );
    }
    highlightNode(e, t, n) {
      if (this.isRendering) return;
      ((n = { stroke: `rgb(94, 200, 248)`, fill: `transparent`, ...(n || {}) }),
        this.highlightBoxNode
          ? this.highlightBoxNodeStyle &&
            (this.highlightBoxNodeStyle.stroke !== n.stroke ||
              this.highlightBoxNodeStyle.fill !== n.fill) &&
            this.highlightBoxNode
              .stroke({ color: n.stroke || `transparent` })
              .fill({ color: n.fill || `transparent` })
          : (this.highlightBoxNode = new Lr()
              .stroke({ color: n.stroke || `transparent` })
              .fill({ color: n.fill || `transparent` })),
        (this.highlightBoxNodeStyle = { ...n }));
      let r = 1 / 0,
        i = 1 / 0,
        a = -1 / 0,
        o = -1 / 0;
      (t
        ? e.children.slice(t[0], t[1] + 1).forEach((e) => {
            (e.left < r && (r = e.left), e.top < i && (i = e.top));
            let t = e.left + e.width,
              n = e.top + e.height;
            (t > a && (a = t), n > o && (o = n));
          })
        : ((r = e.left),
          (i = e.top),
          (a = e.left + e.width),
          (o = e.top + e.height)),
        this.highlightBoxNode.plot([
          [r, i],
          [a, i],
          [a, o],
          [r, o],
        ]),
        this.mindMap.otherDraw.add(this.highlightBoxNode));
    }
    closeHighlightNode() {
      this.highlightBoxNode && this.highlightBoxNode.remove();
    }
    hasRichTextPlugin() {
      return !!this.mindMap.richText;
    }
  },
  Hs = { default: Mi },
  Us = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    CapsLock: 20,
    Esc: 27,
    Spacebar: 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    Insert: 45,
    Left: 37,
    Up: 38,
    Right: 39,
    Down: 40,
    Del: 46,
    NumLock: 144,
    Cmd: 91,
    CmdFF: 224,
    F1: 112,
    F2: 113,
    F3: 114,
    F4: 115,
    F5: 116,
    F6: 117,
    F7: 118,
    F8: 119,
    F9: 120,
    F10: 121,
    F11: 122,
    F12: 123,
    "`": 192,
    "=": 187,
    "-": 189,
    "/": 191,
    ".": 190,
  };
for (let e = 0; e <= 9; e++) Us[e] = e + 48;
`abcdefghijklmnopqrstuvwxyz`.split(``).forEach((e, t) => {
  Us[e] = t + 65;
});
var Ws = Us,
  Gs = class {
    constructor(e) {
      ((this.opt = e),
        (this.mindMap = e.mindMap),
        (this.shortcutMap = {}),
        (this.shortcutMapCache = {}),
        (this.isPause = !1),
        (this.isInSvg = !1),
        (this.isStopCheckInSvg = !1),
        (this.defaultEnableCheck = this.defaultEnableCheck.bind(this)),
        this.bindEvent());
    }
    extendKeyMap(e, t) {
      Ws[e] = t;
    }
    removeKeyMap(e) {
      Ws[e] !== void 0 && delete Ws[e];
    }
    pause() {
      this.isPause = !0;
    }
    recovery() {
      this.isPause = !1;
    }
    save() {
      Object.keys(this.shortcutMapCache).length > 0 ||
        ((this.shortcutMapCache = this.shortcutMap), (this.shortcutMap = {}));
    }
    restore() {
      Object.keys(this.shortcutMapCache).length <= 0 ||
        ((this.shortcutMap = this.shortcutMapCache),
        (this.shortcutMapCache = {}));
    }
    stopCheckInSvg() {
      let { enableShortcutOnlyWhenMouseInSvg: e } = this.mindMap.opt;
      e && (this.isStopCheckInSvg = !0);
    }
    recoveryCheckInSvg() {
      let { enableShortcutOnlyWhenMouseInSvg: e } = this.mindMap.opt;
      e && (this.isStopCheckInSvg = !0);
    }
    bindEvent() {
      ((this.onKeydown = this.onKeydown.bind(this)),
        this.mindMap.on(`svg_mouseenter`, () => {
          this.isInSvg = !0;
        }),
        this.mindMap.on(`svg_mouseleave`, () => {
          this.isInSvg = !1;
        }),
        window.addEventListener(`keydown`, this.onKeydown),
        this.mindMap.on(`beforeDestroy`, () => {
          this.unBindEvent();
        }));
    }
    unBindEvent() {
      window.removeEventListener(`keydown`, this.onKeydown);
    }
    defaultEnableCheck(e) {
      let t = e.target;
      if (t === document.body) return !0;
      for (let e = 0; e < this.mindMap.editNodeClassList.length; e++) {
        let n = this.mindMap.editNodeClassList[e];
        if (t.classList.contains(n)) return !0;
      }
      return !1;
    }
    onKeydown(e) {
      let {
        enableShortcutOnlyWhenMouseInSvg: t,
        beforeShortcutRun: n,
        customCheckEnableShortcut: r,
      } = this.mindMap.opt;
      (typeof r == `function` ? r : this.defaultEnableCheck)(e) &&
        (this.isPause ||
          (t && !this.isStopCheckInSvg && !this.isInSvg) ||
          Object.keys(this.shortcutMap).forEach((t) => {
            if (this.checkKey(e, t)) {
              if (
                (this.checkKey(e, `Control+v`) ||
                  (e.stopPropagation(), e.preventDefault()),
                typeof n == `function` &&
                  n(t, [...this.mindMap.renderer.activeNodeList]))
              )
                return;
              this.shortcutMap[t].forEach((e) => {
                e();
              });
            }
          }));
    }
    checkKey(e, t) {
      let n = this.getOriginEventCodeArr(e),
        r = this.getKeyCodeArr(t);
      if (n.length !== r.length) return !1;
      for (let e = 0; e < n.length; e++) {
        let t = r.findIndex((t) => t === n[e]);
        if (t === -1) return !1;
        r.splice(t, 1);
      }
      return !0;
    }
    getOriginEventCodeArr(e) {
      let t = [];
      return (
        (e.ctrlKey || e.metaKey) && t.push(Ws.Control),
        e.altKey && t.push(Ws.Alt),
        e.shiftKey && t.push(Ws.Shift),
        t.includes(e.keyCode) || t.push(e.keyCode),
        t
      );
    }
    hasCombinationKey(e) {
      return e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
    }
    getKeyCodeArr(e) {
      let t = e.split(/\s*\+\s*/),
        n = [];
      return (
        t.forEach((e) => {
          n.push(Ws[e]);
        }),
        n
      );
    }
    addShortcut(e, t) {
      e.split(/\s*\|\s*/).forEach((e) => {
        this.shortcutMap[e]
          ? this.shortcutMap[e].push(t)
          : (this.shortcutMap[e] = [t]);
      });
    }
    removeShortcut(e, t) {
      e.split(/\s*\|\s*/).forEach((e) => {
        if (this.shortcutMap[e])
          if (t) {
            let n = this.shortcutMap[e].findIndex((e) => e === t);
            n !== -1 && this.shortcutMap[e].splice(n, 1);
          } else ((this.shortcutMap[e] = []), delete this.shortcutMap[e]);
      });
    }
    getShortcutFn(e) {
      let t = [];
      return (
        e.split(/\s*\|\s*/).forEach((e) => {
          t = this.shortcutMap[e] || [];
        }),
        t
      );
    }
  },
  Ks = {
    name: `simple-mind-map`,
    version: `0.14.0-fix.2`,
    description: `一个简单的web在线思维导图`,
    authors: [
      { name: `街角小林`, email: `1013335014@qq.com` },
      { name: `理想青年实验室`, url: `http://lxqnsys.com/` },
    ],
    types: `./types/index.d.ts`,
    typings: `./types/index.d.ts`,
    license: `MIT`,
    repository: { type: `git`, url: `https://github.com/wanglin2/mind-map` },
    scripts: {
      lint: `eslint src/`,
      format: `prettier --write .`,
      types: `npx -p typescript tsc index.js --declaration --allowJs --emitDeclarationOnly --outDir types --target es2017 --skipLibCheck & node ./bin/createPluginsTypeFiles.js`,
      wsServe: `node ./bin/wsServer.mjs`,
    },
    module: `index.js`,
    main: `./dist/simpleMindMap.umd.min.js`,
    dependencies: {
      "@svgdotjs/svg.js": `3.2.0`,
      deepmerge: `^1.5.2`,
      eventemitter3: `^4.0.7`,
      jszip: `^3.10.1`,
      katex: `^0.16.8`,
      "mdast-util-from-markdown": `^1.3.0`,
      "pdf-lib": `^1.17.1`,
      quill: `^2.0.3`,
      tern: `^0.24.3`,
      uuid: `^9.0.0`,
      ws: `^7.5.9`,
      "xml-js": `^1.6.11`,
      "y-webrtc": `^10.2.5`,
      yjs: `^13.6.8`,
    },
    keywords: [`javascript`, `svg`, `mind-map`, `mindMap`, `MindMap`],
    devDependencies: { eslint: `^8.25.0`, prettier: `^2.7.1` },
  },
  qs = class {
    constructor(e = {}) {
      ((this.opt = e),
        (this.mindMap = e.mindMap),
        (this.commands = {}),
        (this.history = []),
        (this.activeHistoryIndex = 0),
        this.registerShortcutKeys(),
        (this.originAddHistory = this.addHistory.bind(this)),
        (this.addHistory = Vi(
          this.addHistory,
          this.mindMap.opt.addHistoryTime,
          this,
        )),
        (this.isPause = !1));
    }
    pause() {
      this.isPause = !0;
    }
    recovery() {
      this.isPause = !1;
    }
    clearHistory() {
      ((this.history = []),
        (this.activeHistoryIndex = 0),
        this.mindMap.emit(`back_forward`, 0, 0));
    }
    registerShortcutKeys() {
      (this.mindMap.keyCommand.addShortcut(`Control+z`, () => {
        this.mindMap.execCommand(`BACK`);
      }),
        this.mindMap.keyCommand.addShortcut(`Control+y`, () => {
          this.mindMap.execCommand(`FORWARD`);
        }));
    }
    exec(e, ...t) {
      if (this.commands[e]) {
        if (
          (this.commands[e].forEach((e) => {
            e(...t);
          }),
          this.mindMap.emit(`afterExecCommand`, e, ...t),
          [`BACK`, `FORWARD`, `SET_NODE_ACTIVE`, `CLEAR_ACTIVE_NODE`].includes(
            e,
          ))
        )
          return;
        this.addHistory();
      }
    }
    add(e, t) {
      this.commands[e] ? this.commands[e].push(t) : (this.commands[e] = [t]);
    }
    remove(e, t) {
      if (this.commands[e])
        if (!t) ((this.commands[e] = []), delete this.commands[e]);
        else {
          let n = this.commands[e].find((e) => e === t);
          n !== -1 && this.commands[e].splice(n, 1);
        }
    }
    addHistory() {
      if (this.mindMap.opt.readonly || this.isPause) return;
      this.mindMap.emit(`beforeAddHistory`);
      let e =
          this.history.length > 0
            ? this.history[this.activeHistoryIndex]
            : null,
        t = this.getCopyData(),
        n = JSON.stringify(t);
      (e && e === n) ||
        (this.emitDataUpdatesEvent(e, n),
        (this.history = this.history.slice(0, this.activeHistoryIndex + 1)),
        this.history.push(n),
        this.history.length > this.mindMap.opt.maxHistoryCount &&
          this.history.shift(),
        (this.activeHistoryIndex = this.history.length - 1),
        this.mindMap.emit(`data_change`, t),
        this.mindMap.emit(
          `back_forward`,
          this.activeHistoryIndex,
          this.history.length,
        ));
    }
    back(e = 1) {
      if (!this.mindMap.opt.readonly && this.activeHistoryIndex - e >= 0) {
        let t = this.history[this.activeHistoryIndex];
        ((this.activeHistoryIndex -= e),
          this.mindMap.emit(
            `back_forward`,
            this.activeHistoryIndex,
            this.history.length,
          ));
        let n = this.history[this.activeHistoryIndex],
          r = JSON.parse(n);
        return (this.emitDataUpdatesEvent(t, n), r);
      }
    }
    forward(e = 1) {
      if (this.mindMap.opt.readonly) return;
      let t = this.history.length;
      if (this.activeHistoryIndex + e <= t - 1) {
        let t = this.history[this.activeHistoryIndex];
        ((this.activeHistoryIndex += e),
          this.mindMap.emit(
            `back_forward`,
            this.activeHistoryIndex,
            this.history.length,
          ));
        let n = this.history[this.activeHistoryIndex],
          r = JSON.parse(n);
        return (this.emitDataUpdatesEvent(t, n), r);
      }
    }
    getCopyData() {
      if (!this.mindMap.renderer.renderTree) return null;
      let e = zi({}, this.mindMap.renderer.renderTree, !0);
      return ((e.smmVersion = Ks.version), e);
    }
    removeDataUid(e) {
      e = X(e);
      let t = (e) => {
        (delete e.data.uid,
          e.children &&
            e.children.length > 0 &&
            e.children.forEach((e) => {
              t(e);
            }));
      };
      return (t(e), e);
    }
    emitDataUpdatesEvent(e, t) {
      try {
        let n = `data_change_detail`;
        if (this.mindMap.event.listenerCount(n) > 0 && e && t) {
          let r = JSON.parse(e),
            i = JSON.parse(t),
            a = X(Aa(r)),
            o = X(Aa(i)),
            s = [],
            c = (e, t) => (
              e.children &&
                e.children.length > 0 &&
                e.children.forEach((n, r) => {
                  ((e.children[r] =
                    typeof n == `string` ? t[n] : t[n.data.uid]),
                    c(e.children[r], t));
                }),
              e
            );
          (Object.keys(o).forEach((e) => {
            a[e]
              ? xa(a[e], o[e]) ||
                s.push({
                  action: `update`,
                  oldData: c(a[e], a),
                  data: c(o[e], o),
                })
              : s.push({ action: `create`, data: c(o[e], o) });
          }),
            Object.keys(a).forEach((e) => {
              o[e] || s.push({ action: `delete`, data: c(a[e], a) });
            }),
            this.mindMap.emit(n, s));
        }
      } catch (e) {
        this.mindMap.opt.errorHandler(fe.DATA_CHANGE_DETAIL_EVENT_ERROR, e);
      }
    }
  },
  Js = class {
    constructor() {
      ((this.has = {}),
        (this.queue = []),
        (this.nextTick = Ki(this.flush, this)));
    }
    push(e, t) {
      if (this.has[e]) {
        this.replaceTask(e, t);
        return;
      }
      ((this.has[e] = !0),
        this.queue.push({ name: e, fn: t }),
        this.nextTick());
    }
    replaceTask(e, t) {
      let n = this.queue.findIndex((t) => t.name === e);
      n !== -1 && (this.queue[n] = { name: e, fn: t });
    }
    flush() {
      let e = this.queue.slice(0);
      ((this.queue = []),
        e.forEach(({ name: e, fn: t }) => {
          ((this.has[e] = !1), t());
        }));
    }
  },
  Ys = {
    el: null,
    data: null,
    viewData: null,
    readonly: !1,
    layout: w.LAYOUT.LOGICAL_STRUCTURE,
    fishboneDeg: 45,
    theme: `default`,
    themeConfig: {},
    scaleRatio: 0.2,
    translateRatio: 1,
    minZoomRatio: 20,
    maxZoomRatio: 400,
    customCheckIsTouchPad: null,
    mouseScaleCenterUseMousePosition: !0,
    maxTag: 5,
    expandBtnSize: 20,
    imgTextMargin: 5,
    textContentMargin: 2,
    customNoteContentShow: null,
    textAutoWrapWidth: 500,
    customHandleMousewheel: null,
    mousewheelAction: w.MOUSE_WHEEL_ACTION.MOVE,
    mousewheelMoveStep: 100,
    mousewheelZoomActionReverse: !0,
    defaultInsertSecondLevelNodeText: `二级节点`,
    defaultInsertBelowSecondLevelNodeText: `分支主题`,
    expandBtnStyle: {
      color: `#808080`,
      fill: `#fff`,
      fontSize: 13,
      strokeColor: `#333333`,
    },
    expandBtnIcon: { open: ``, close: `` },
    expandBtnNumHandler: null,
    isShowExpandNum: !0,
    enableShortcutOnlyWhenMouseInSvg: !0,
    customCheckEnableShortcut: null,
    initRootNodePosition: null,
    nodeTextEditZIndex: 3e3,
    nodeNoteTooltipZIndex: 3e3,
    isEndNodeTextEditOnClickOuter: !0,
    maxHistoryCount: 500,
    alwaysShowExpandBtn: !1,
    notShowExpandBtn: !1,
    iconList: [],
    maxNodeCacheCount: 1e3,
    fitPadding: 50,
    enableCtrlKeyNodeSelection: !0,
    useLeftKeySelectionRightKeyDrag: !1,
    beforeTextEdit: null,
    isUseCustomNodeContent: !1,
    customCreateNodeContent: null,
    customInnerElsAppendTo: null,
    enableAutoEnterTextEditWhenKeydown: !1,
    autoEmptyTextWhenKeydownEnterEdit: !1,
    customHandleClipboardText: null,
    disableMouseWheelZoom: !1,
    errorHandler: (e, t) => {
      console.error(e, t);
    },
    enableDblclickBackToRootNode: !1,
    hoverRectColor: `rgb(94, 200, 248)`,
    hoverRectPadding: 2,
    selectTextOnEnterEditText: !1,
    deleteNodeActive: !0,
    fit: !1,
    tagsColorMap: {},
    cooperateStyle: { avatarSize: 22, fontSize: 12 },
    onlyOneEnableActiveNodeOnCooperate: !1,
    defaultGeneralizationText: `概要`,
    handleIsSplitByWrapOnPasteCreateNewNode: null,
    addHistoryTime: 100,
    isDisableDrag: !1,
    createNewNodeBehavior: w.CREATE_NEW_NODE_BEHAVIOR.DEFAULT,
    defaultNodeImage: ``,
    isLimitMindMapInCanvas: !1,
    handleNodePasteImg: null,
    customCreateNodePath: null,
    customCreateNodePolygon: null,
    customTransformNodeLinePath: null,
    beforeShortcutRun: null,
    resetScaleOnMoveNodeToCenter: !1,
    createNodePrefixContent: null,
    createNodePostfixContent: null,
    disabledClipboard: !1,
    customHyperlinkJump: null,
    openPerformance: !1,
    performanceConfig: { time: 250, padding: 100, removeNodeWhenOutCanvas: !0 },
    emptyTextMeasureHeightText: `abc123我和你`,
    openRealtimeRenderOnNodeTextEdit: !1,
    mousedownEventPreventDefault: !1,
    onlyPasteTextWhenHasImgAndText: !0,
    enableDragModifyNodeWidth: !0,
    minNodeTextModifyWidth: 20,
    maxNodeTextModifyWidth: -1,
    customHandleLine: null,
    addHistoryOnInit: !0,
    noteIcon: { icon: ``, style: {} },
    hyperlinkIcon: { icon: ``, style: {} },
    attachmentIcon: { icon: ``, style: {} },
    isShowCreateChildBtnIcon: !0,
    quickCreateChildBtnIcon: { icon: ``, style: {} },
    customQuickCreateChildBtnClick: null,
    addCustomContentToNode: null,
    enableInheritAncestorLineStyle: !0,
    selectTranslateStep: 3,
    selectTranslateLimit: 20,
    enableFreeDrag: !1,
    autoMoveWhenMouseInEdgeOnDrag: !0,
    dragMultiNodeRectConfig: {
      width: 40,
      height: 20,
      fill: `rgb(94, 200, 248)`,
    },
    dragPlaceholderRectFill: `rgb(94, 200, 248)`,
    dragPlaceholderLineConfig: { color: `rgb(94, 200, 248)`, width: 2 },
    dragOpacityConfig: { cloneNodeOpacity: 0.5, beingDragNodeOpacity: 0.3 },
    handleDragCloneNode: null,
    beforeDragEnd: null,
    beforeDragStart: null,
    watermarkConfig: {
      onlyExport: !1,
      text: ``,
      lineSpacing: 100,
      textSpacing: 100,
      angle: 30,
      textStyle: { color: `#999`, opacity: 0.5, fontSize: 14 },
      belowNode: !1,
    },
    exportPaddingX: 10,
    exportPaddingY: 10,
    resetCss: `
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
  `,
    minExportImgCanvasScale: 2,
    addContentToHeader: null,
    addContentToFooter: null,
    handleBeingExportSvg: null,
    maxCanvasSize: 16384,
    defaultAssociativeLineText: `关联`,
    associativeLineIsAlwaysAboveNode: !0,
    associativeLineInitPointsPosition: { from: ``, to: `` },
    enableAdjustAssociativeLinePoints: !0,
    beforeAssociativeLineConnection: null,
    disableTouchZoom: !1,
    minTouchZoomScale: 20,
    maxTouchZoomScale: -1,
    isLimitMindMapInCanvasWhenHasScrollbar: !0,
    isOnlySearchCurrentRenderNodes: !1,
    beforeCooperateUpdate: null,
    rainbowLinesConfig: { open: !1, colorsList: [] },
    demonstrateConfig: null,
    enableEditFormulaInRichTextEdit: !0,
    katexFontPath: `https://unpkg.com/katex@0.16.11/dist/`,
    getKatexOutputType: null,
    transformRichTextOnEnterEdit: null,
    beforeHideRichTextEdit: null,
    outerFramePaddingX: 10,
    outerFramePaddingY: 10,
    defaultOuterFrameText: `外框`,
    onlyPainterNodeCustomStyles: !1,
    beforeDeleteNodeImg: null,
    imgResizeBtnSize: 25,
    minImgResizeWidth: 50,
    minImgResizeHeight: 50,
    maxImgResizeWidthInheritTheme: !1,
    maxImgResizeWidth: 1 / 0,
    maxImgResizeHeight: 1 / 0,
    customDeleteBtnInnerHTML: ``,
    customResizeBtnInnerHTML: ``,
  },
  $ = class e {
    constructor(t = {}) {
      if (
        (e.instanceCount++,
        (this.opt = this.handleOpt((0, Te.default)(Ys, t))),
        (this.opt.data = this.handleData(this.opt.data)),
        (this.el = this.opt.el),
        !this.el)
      )
        throw Error(`缺少容器元素el`);
      (this.getElRectInfo(),
        (this.initWidth = this.width),
        (this.initHeight = this.height),
        (this.cssEl = null),
        (this.cssTextMap = {}),
        (this.nodeInnerPrefixList = []),
        (this.nodeInnerPostfixList = []),
        (this.editNodeClassList = []),
        (this.extendShapeList = []),
        this.initContainer(),
        this.initTheme(),
        this.initCache(),
        e.pluginList
          .filter((e) => e.preload)
          .forEach((e) => {
            this.initPlugin(e);
          }),
        (this.event = new _e({ mindMap: this })),
        (this.keyCommand = new Gs({ mindMap: this })),
        (this.command = new qs({ mindMap: this })),
        (this.renderer = new Vs({ mindMap: this })),
        (this.view = new he({ mindMap: this })),
        (this.batchExecution = new Js()),
        e.pluginList
          .filter((e) => !e.preload)
          .forEach((e) => {
            this.initPlugin(e);
          }),
        this.addCss(),
        this.render(this.opt.fit ? () => this.view.fit() : () => {}),
        this.opt.addHistoryOnInit &&
          this.opt.data &&
          this.command.addHistory());
    }
    handleOpt(e) {
      return (
        ue.includes(e.layout) || (e.layout = w.LAYOUT.LOGICAL_STRUCTURE),
        (e.theme = e.theme && Hs[e.theme] ? e.theme : `default`),
        e
      );
    }
    handleData(e) {
      return ea(e) || Object.keys(e).length <= 0
        ? null
        : ((e = X(e || {})),
          e.data && !e.data.expand && (e.data.expand = !0),
          _a([e], !1, null, !0),
          e);
    }
    initContainer() {
      let { associativeLineIsAlwaysAboveNode: e } = this.opt;
      this.el.classList.add(`smm-mind-map-container`);
      let t = () => {
        ((this.associativeLineDraw = this.draw.group()),
          this.associativeLineDraw.addClass(`smm-associative-line-container`));
      };
      ((this.svg = J().addTo(this.el).size(this.width, this.height)),
        (this.draw = this.svg.group()),
        this.draw.addClass(`smm-container`),
        (this.lineDraw = this.draw.group()),
        this.lineDraw.addClass(`smm-line-container`),
        e || t(),
        (this.nodeDraw = this.draw.group()),
        this.nodeDraw.addClass(`smm-node-container`),
        e && t(),
        (this.otherDraw = this.draw.group()),
        this.otherDraw.addClass(`smm-other-container`));
    }
    clearDraw() {
      (this.lineDraw.clear(),
        this.associativeLineDraw.clear(),
        this.nodeDraw.clear(),
        this.otherDraw.clear());
    }
    appendCss(e, t) {
      ((this.cssTextMap[e] = t), this.removeCss(), this.addCss());
    }
    removeAppendCss(e) {
      this.cssTextMap[e] &&
        (delete this.cssTextMap[e], this.removeCss(), this.addCss());
    }
    joinCss() {
      return (
        pe +
        Object.keys(this.cssTextMap).map((e) => this.cssTextMap[e]).join(`
`)
      );
    }
    addCss() {
      ((this.cssEl = document.createElement(`style`)),
        (this.cssEl.type = `text/css`),
        (this.cssEl.innerHTML = this.joinCss()),
        document.head.appendChild(this.cssEl));
    }
    removeCss() {
      this.cssEl && document.head.removeChild(this.cssEl);
    }
    checkEditNodeClassIndex(e) {
      return this.editNodeClassList.findIndex((t) => t === e);
    }
    addEditNodeClass(e) {
      this.checkEditNodeClassIndex(e) === -1 && this.editNodeClassList.push(e);
    }
    deleteEditNodeClass(e) {
      let t = this.checkEditNodeClassIndex(e);
      t !== -1 && this.editNodeClassList.splice(t, 1);
    }
    render(e, t = ``) {
      (this.initTheme(), this.renderer.render(e, t));
    }
    reRender(e, t = ``) {
      ((this.renderer.reRender = !0),
        this.renderer.clearCache(),
        this.clearDraw(),
        this.render(e, t));
    }
    getElRectInfo() {
      if (
        ((this.elRect = this.el.getBoundingClientRect()),
        (this.width = this.elRect.width),
        (this.height = this.elRect.height),
        this.width <= 0 || this.height <= 0)
      )
        throw Error(`容器元素el的宽高不能为0`);
    }
    resize() {
      let e = this.width,
        t = this.height;
      (this.getElRectInfo(),
        this.svg.size(this.width, this.height),
        (e !== this.width || t !== this.height) &&
          ((this.demonstrate && this.demonstrate.isInDemonstrate) ||
            this.render()),
        this.emit(`resize`));
    }
    on(e, t) {
      this.event.on(e, t);
    }
    emit(e, ...t) {
      this.event.emit(e, ...t);
    }
    off(e, t) {
      this.event.off(e, t);
    }
    initCache() {
      this.commonCaches = {
        measureCustomNodeContentSizeEl: null,
        measureRichtextNodeTextSizeEl: null,
      };
    }
    initTheme() {
      ((this.themeConfig = Ra(
        Hs[this.opt.theme] || Hs.default,
        this.opt.themeConfig,
      )),
        Ha.setBackgroundStyle(this.el, this.themeConfig));
    }
    setTheme(e, t = !1) {
      (this.execCommand(`CLEAR_ACTIVE_NODE`),
        (this.opt.theme = e),
        t || this.render(null, w.CHANGE_THEME),
        this.emit(`view_theme_change`, e));
    }
    getTheme() {
      return this.opt.theme;
    }
    setThemeConfig(e, t = !1) {
      let n = ca(this.themeConfig, e);
      if (((this.opt.themeConfig = e), !t)) {
        let e = Pi(n);
        this.render(null, e ? `` : w.CHANGE_THEME);
      }
    }
    getCustomThemeConfig() {
      return this.opt.themeConfig;
    }
    getThemeConfig(e) {
      return e === void 0 ? this.themeConfig : this.themeConfig[e];
    }
    getConfig(e) {
      return e === void 0 ? this.opt : this.opt[e];
    }
    updateConfig(e = {}) {
      this.emit(`before_update_config`, this.opt);
      let t = { ...this.opt };
      ((this.opt = this.handleOpt(Te.default.all([Ys, this.opt, e]))),
        this.emit(`after_update_config`, this.opt, t));
    }
    getLayout() {
      return this.opt.layout;
    }
    setLayout(e, t = !1) {
      (ue.includes(e) || (e = w.LAYOUT.LOGICAL_STRUCTURE),
        (this.opt.layout = e),
        this.view.reset(),
        this.renderer.setLayout(),
        t || this.render(null, w.CHANGE_LAYOUT),
        this.emit(`layout_change`, e));
    }
    execCommand(...e) {
      this.command.exec(...e);
    }
    updateData(e) {
      ((e = this.handleData(e)),
        this.emit(`before_update_data`, e),
        this.renderer.setData(e),
        this.render(),
        this.command.addHistory(),
        this.emit(`update_data`, e));
    }
    setData(e) {
      ((e = this.handleData(e)),
        this.emit(`before_set_data`, e),
        (this.opt.data = e),
        this.execCommand(`CLEAR_ACTIVE_NODE`),
        this.command.clearHistory(),
        this.command.addHistory(),
        this.renderer.setData(e),
        this.reRender(),
        this.emit(`set_data`, e));
    }
    setFullData(e) {
      (e.root && this.setData(e.root),
        e.layout && this.setLayout(e.layout),
        e.theme &&
          (e.theme.template && this.setTheme(e.theme.template),
          e.theme.config && this.setThemeConfig(e.theme.config)),
        e.view && this.view.setTransformData(e.view));
    }
    getData(e) {
      let t = this.command.getCopyData(),
        n = {};
      return (
        (n = e
          ? {
              layout: this.getLayout(),
              root: t,
              theme: {
                template: this.getTheme(),
                config: this.getCustomThemeConfig(),
              },
              view: this.view.getTransformData(),
            }
          : t),
        X(n)
      );
    }
    async export(...e) {
      try {
        if (!this.doExport) throw Error(`请注册Export插件！`);
        return await this.doExport.export(...e);
      } catch (e) {
        this.opt.errorHandler(fe.EXPORT_ERROR, e);
      }
    }
    toPos(e, t) {
      return { x: e - this.elRect.left, y: t - this.elRect.top };
    }
    setMode(e) {
      if (![w.MODE.READONLY, w.MODE.EDIT].includes(e)) return;
      let t = e === w.MODE.READONLY;
      t !== this.opt.readonly &&
        (t &&
          (this.renderer.textEdit.isShowTextEdit() &&
            (this.renderer.textEdit.hideEditTextBox(),
            this.command.originAddHistory()),
          this.execCommand(`CLEAR_ACTIVE_NODE`)),
        (this.opt.readonly = t),
        !t &&
          this.command.history.length <= 0 &&
          this.command.originAddHistory(),
        this.emit(`mode_change`, e));
    }
    getSvgData({
      paddingX: e = 0,
      paddingY: t = 0,
      ignoreWatermark: n = !1,
      addContentToHeader: r,
      addContentToFooter: i,
      node: a,
    } = {}) {
      let { watermarkConfig: o, openPerformance: s } = this.opt;
      s && this.renderer.forceLoadNode(a);
      let {
          cssTextList: c,
          header: l,
          headerHeight: u,
          footer: d,
          footerHeight: f,
        } = Ma({ addContentToHeader: r, addContentToFooter: i }),
        p = this.svg,
        m = this.draw,
        h = p.width(),
        g = p.height(),
        _ = m.transform(),
        v = this.elRect;
      m.scale(1 / _.scaleX, 1 / _.scaleY);
      let y = m.rbox(),
        ee = null;
      (a && (ee = Na(a, y.x, y.y, e, t)),
        (y.width += e * 2),
        (y.height += t * 2 + 0 + u + f),
        m.translate(e, t),
        p.size(y.width, y.height),
        m.translate(-y.x + v.left, -y.y + v.top));
      let b = p.clone(),
        x = this.watermark && this.watermark.hasWatermark();
      if (!n && x) {
        this.watermark.isInExport = !0;
        let { onlyExport: e } = o;
        (y.width > h || y.height > g
          ? ((this.width = y.width),
            (this.height = y.height),
            this.watermark.onResize(),
            (b = p.clone()),
            (this.width = h),
            (this.height = g),
            this.watermark.onResize())
          : e && (this.watermark.onResize(), (b = p.clone())),
          e && this.watermark.clear(),
          (this.watermark.isInExport = !1));
      }
      ([this.joinCss(), ...c].forEach((e) => {
        b.add(J(`<style>${e}</style>`));
      }),
        l &&
          u > 0 &&
          (b.findOne(`.smm-container`).translate(0, u),
          l.width(y.width),
          l.y(t),
          b.add(l, 0)),
        d && f > 0 && (d.width(y.width), d.y(y.height - t - f), b.add(d)));
      let te = p.find(`defs`),
        ne = b.find(`defs`);
      return (
        te.forEach((e, t) => {
          let n = ne[t];
          if (!n) return;
          let r = e.children(),
            i = n.children();
          for (let e = 0; e < r.length; e++) {
            let t = r[e],
              n = i[e];
            t && n && n.attr(`id`, t.attr(`id`));
          }
        }),
        p.size(h, g),
        m.transform(_),
        {
          svg: b,
          svgHTML: b.svg(),
          clipData: ee,
          rect: { ...y, ratio: y.width / y.height },
          origWidth: h,
          origHeight: g,
          scaleX: _.scaleX,
          scaleY: _.scaleY,
        }
      );
    }
    addShape(e) {
      e &&
        (this.extendShapeList.find((t) => t.name === e.name) ||
          this.extendShapeList.push(e));
    }
    removeShape(e) {
      let t = this.extendShapeList.findIndex((t) => t.name === e);
      t !== -1 && this.extendShapeList.splice(t, 1);
    }
    getSvgObjects() {
      return { SVG: J, G: q, Rect: W };
    }
    addPlugin(t, n) {
      (e.hasPlugin(t) === -1 && e.usePlugin(t, n), this.initPlugin(t));
    }
    removePlugin(t) {
      let n = e.hasPlugin(t);
      n !== -1 &&
        (e.pluginList.splice(n, 1),
        this[t.instanceName] &&
          (this[t.instanceName].beforePluginRemove &&
            this[t.instanceName].beforePluginRemove(),
          delete this[t.instanceName]));
    }
    initPlugin(e) {
      this[e.instanceName] ||
        (this[e.instanceName] = new e({
          mindMap: this,
          pluginOpt: e.pluginOpt,
        }));
    }
    destroy() {
      (this.emit(`beforeDestroy`),
        this.renderer.textEdit.hideEditTextBox(),
        this.renderer.textEdit.removeTextEditEl(),
        [...e.pluginList].forEach((e) => {
          (this[e.instanceName] &&
            this[e.instanceName].beforePluginDestroy &&
            this[e.instanceName].beforePluginDestroy(),
            (this[e.instanceName] = null));
        }),
        this.event.unbind(),
        this.svg.remove(),
        Ha.removeBackgroundStyle(this.el),
        this.el.classList.remove(`smm-mind-map-container`),
        (this.el.innerHTML = ``),
        (this.el = null),
        this.removeCss(),
        e.instanceCount--);
    }
  },
  Xs = [];
(($.extendNodeDataNoStylePropList = (e = []) => {
  (Xs.push(...e), de.push(...e));
}),
  ($.resetNodeDataNoStylePropList = () => {
    (Xs.forEach((e) => {
      let t = de.findIndex((t) => t === e);
      t !== -1 && de.splice(t, 1);
    }),
      (Xs = []));
  }),
  ($.pluginList = []),
  ($.usePlugin = (e, t = {}) =>
    $.hasPlugin(e) === -1 ? ((e.pluginOpt = t), $.pluginList.push(e), $) : $),
  ($.hasPlugin = (e) => $.pluginList.findIndex((t) => t === e)),
  ($.instanceCount = 0),
  ($.defineTheme = (e, t = {}) => {
    if (Hs[e]) return Error(`该主题名称已存在`);
    Hs[e] = Ra(Mi, t);
  }),
  ($.removeTheme = (e) => {
    Hs[e] && (Hs[e] = null);
  }));
var Zs = class {
  constructor(e) {
    ((this.opt = e), (this.mindMap = e.mindMap), this.addShortcut());
  }
  addShortcut() {
    ((this.onLeftKeyUp = this.onLeftKeyUp.bind(this)),
      (this.onUpKeyUp = this.onUpKeyUp.bind(this)),
      (this.onRightKeyUp = this.onRightKeyUp.bind(this)),
      (this.onDownKeyUp = this.onDownKeyUp.bind(this)),
      this.mindMap.keyCommand.addShortcut(w.KEY_DIR.LEFT, this.onLeftKeyUp),
      this.mindMap.keyCommand.addShortcut(w.KEY_DIR.UP, this.onUpKeyUp),
      this.mindMap.keyCommand.addShortcut(w.KEY_DIR.RIGHT, this.onRightKeyUp),
      this.mindMap.keyCommand.addShortcut(w.KEY_DIR.DOWN, this.onDownKeyUp));
  }
  removeShortcut() {
    (this.mindMap.keyCommand.removeShortcut(w.KEY_DIR.LEFT, this.onLeftKeyUp),
      this.mindMap.keyCommand.removeShortcut(w.KEY_DIR.UP, this.onUpKeyUp),
      this.mindMap.keyCommand.removeShortcut(
        w.KEY_DIR.RIGHT,
        this.onRightKeyUp,
      ),
      this.mindMap.keyCommand.removeShortcut(w.KEY_DIR.DOWN, this.onDownKeyUp));
  }
  onLeftKeyUp() {
    this.onKeyup(w.KEY_DIR.LEFT);
  }
  onUpKeyUp() {
    this.onKeyup(w.KEY_DIR.UP);
  }
  onRightKeyUp() {
    this.onKeyup(w.KEY_DIR.RIGHT);
  }
  onDownKeyUp() {
    this.onKeyup(w.KEY_DIR.DOWN);
  }
  onKeyup(e) {
    if (this.mindMap.renderer.activeNodeList.length > 0) this.focus(e);
    else {
      let e = this.mindMap.renderer.root;
      this.mindMap.execCommand(`GO_TARGET_NODE`, e);
    }
  }
  focus(e) {
    let t = this.mindMap.renderer.activeNodeList[0],
      n = this.getNodeRect(t),
      r = null,
      i = 1 / 0,
      a = (e, t) => {
        let a = this.getDistance(n, e);
        a < i && ((r = t), (i = a));
      };
    (this.getFocusNodeByShadowAlgorithm({
      currentActiveNode: t,
      currentActiveNodeRect: n,
      dir: e,
      checkNodeDis: a,
    }),
      r ||
        this.getFocusNodeByAreaAlgorithm({
          currentActiveNode: t,
          currentActiveNodeRect: n,
          dir: e,
          checkNodeDis: a,
        }),
      r ||
        this.getFocusNodeBySimpleAlgorithm({
          currentActiveNode: t,
          currentActiveNodeRect: n,
          dir: e,
          checkNodeDis: a,
        }),
      r && this.mindMap.execCommand(`GO_TARGET_NODE`, r));
  }
  getFocusNodeBySimpleAlgorithm({
    currentActiveNode: e,
    currentActiveNodeRect: t,
    dir: n,
    checkNodeDis: r,
  }) {
    Ii(this.mindMap.renderer.root, (i) => {
      if (i.uid === e.uid) return;
      let a = this.getNodeRect(i),
        { left: o, top: s, right: c, bottom: l } = a,
        u = !1;
      (n === w.KEY_DIR.LEFT
        ? (u = c <= t.left)
        : n === w.KEY_DIR.RIGHT
          ? (u = o >= t.right)
          : n === w.KEY_DIR.UP
            ? (u = l <= t.top)
            : n === w.KEY_DIR.DOWN && (u = s >= t.bottom),
        u && r(a, i));
    });
  }
  getFocusNodeByShadowAlgorithm({
    currentActiveNode: e,
    currentActiveNodeRect: t,
    dir: n,
    checkNodeDis: r,
  }) {
    Ii(this.mindMap.renderer.root, (i) => {
      if (i.uid === e.uid) return;
      let a = this.getNodeRect(i),
        { left: o, top: s, right: c, bottom: l } = a,
        u = !1;
      (n === w.KEY_DIR.LEFT
        ? (u = o < t.left && s < t.bottom && l > t.top)
        : n === w.KEY_DIR.RIGHT
          ? (u = c > t.right && s < t.bottom && l > t.top)
          : n === w.KEY_DIR.UP
            ? (u = s < t.top && o < t.right && c > t.left)
            : n === w.KEY_DIR.DOWN &&
              (u = l > t.bottom && o < t.right && c > t.left),
        u && r(a, i));
    });
  }
  getFocusNodeByAreaAlgorithm({
    currentActiveNode: e,
    currentActiveNodeRect: t,
    dir: n,
    checkNodeDis: r,
  }) {
    let i = (t.right + t.left) / 2,
      a = (t.bottom + t.top) / 2;
    Ii(this.mindMap.renderer.root, (t) => {
      if (t.uid === e.uid) return;
      let o = this.getNodeRect(t),
        { left: s, top: c, right: l, bottom: u } = o,
        d = (l + s) / 2,
        f = (u + c) / 2,
        p = d - i,
        m = f - a;
      if (p === 0 && m === 0) return;
      let h = !1;
      (n === w.KEY_DIR.LEFT
        ? (h = p <= 0 && p <= m && p <= -m)
        : n === w.KEY_DIR.RIGHT
          ? (h = p > 0 && p >= -m && p >= m)
          : n === w.KEY_DIR.UP
            ? (h = m <= 0 && m < p && m < -p)
            : n === w.KEY_DIR.DOWN && (h = m > 0 && -m < p && m > p),
        h && r(o, t));
    });
  }
  getNodeRect(e) {
    let {
        scaleX: t,
        scaleY: n,
        translateX: r,
        translateY: i,
      } = this.mindMap.draw.transform(),
      { left: a, top: o, width: s, height: c } = e;
    return {
      right: (a + s) * t + r,
      bottom: (o + c) * n + i,
      left: a * t + r,
      top: o * n + i,
    };
  }
  getDistance(e, t) {
    let n = this.getCenter(e),
      r = this.getCenter(t);
    return Math.sqrt((n.x - r.x) ** 2 + (n.y - r.y) ** 2);
  }
  getCenter({ left: e, right: t, top: n, bottom: r }) {
    return { x: (e + t) / 2, y: (n + r) / 2 };
  }
  beforePluginRemove() {
    this.removeShortcut();
  }
  beforePluginDestroy() {
    this.removeShortcut();
  }
};
Zs.instanceName = `keyboardNavigation`;
var Qs = class {
  constructor({ mindMap: e }) {
    ((this.mindMap = e),
      (this.touchesNum = 0),
      (this.singleTouchstartEvent = null),
      (this.clickNum = 0),
      (this.touchStartScaleView = null),
      (this.lastTouchStartPosition = null),
      (this.lastTouchStartDistance = 0),
      this.bindEvent());
  }
  bindEvent() {
    ((this.onTouchstart = this.onTouchstart.bind(this)),
      (this.onTouchmove = this.onTouchmove.bind(this)),
      (this.onTouchcancel = this.onTouchcancel.bind(this)),
      (this.onTouchend = this.onTouchend.bind(this)),
      window.addEventListener(`touchstart`, this.onTouchstart, { passive: !1 }),
      window.addEventListener(`touchmove`, this.onTouchmove, { passive: !1 }),
      window.addEventListener(`touchcancel`, this.onTouchcancel, {
        passive: !1,
      }),
      window.addEventListener(`touchend`, this.onTouchend, { passive: !1 }));
  }
  unBindEvent() {
    (window.removeEventListener(`touchstart`, this.onTouchstart),
      window.removeEventListener(`touchmove`, this.onTouchmove),
      window.removeEventListener(`touchcancel`, this.onTouchcancel),
      window.removeEventListener(`touchend`, this.onTouchend));
  }
  onTouchstart(e) {
    if (
      ((this.touchesNum = e.touches.length),
      (this.touchStartScaleView = null),
      this.touchesNum === 1)
    ) {
      let t = e.touches[0];
      (this.lastTouchStartPosition &&
        (this.lastTouchStartDistance = ja(
          this.lastTouchStartPosition.x,
          this.lastTouchStartPosition.y,
          t.clientX,
          t.clientY,
        )),
        (this.lastTouchStartPosition = { x: t.clientX, y: t.clientY }),
        (this.singleTouchstartEvent = t),
        this.dispatchMouseEvent(`mousedown`, t.target, t));
    }
  }
  onTouchmove(e) {
    let t = e.touches.length;
    if (t === 1) {
      let t = e.touches[0];
      this.dispatchMouseEvent(`mousemove`, t.target, t);
    } else if (t === 2) {
      let {
        disableTouchZoom: t,
        minTouchZoomScale: n,
        maxTouchZoomScale: r,
      } = this.mindMap.opt;
      if (t) return;
      ((n = n === -1 ? -1 / 0 : n / 100), (r = r === -1 ? 1 / 0 : r / 100));
      let i = e.touches[0],
        a = e.touches[1],
        o = i.clientX - a.clientX,
        s = i.clientY - a.clientY,
        c = Math.sqrt(o ** 2 + s ** 2),
        { x: l, y: u } = this.mindMap.toPos(i.clientX, i.clientY),
        { x: d, y: f } = this.mindMap.toPos(a.clientX, a.clientY),
        p = (l + d) / 2,
        m = (u + f) / 2,
        h = this.mindMap.view;
      if (!this.touchStartScaleView) {
        this.touchStartScaleView = {
          distance: c,
          scale: h.scale,
          x: h.x,
          y: h.y,
          cx: p,
          cy: m,
        };
        return;
      }
      let g = this.touchStartScaleView,
        _ = g.scale * (c / g.distance);
      (Math.abs(c - g.distance) <= 10 && (_ = g.scale),
        (_ = _ < n ? n : _ > r ? r : _));
      let v = 1 - _ / g.scale;
      ((h.scale = _),
        (h.x = g.x + (p - g.x) * v + (p - g.cx) * _),
        (h.y = g.y + (m - g.y) * v + (m - g.cy) * _),
        h.transform(),
        this.mindMap.emit(`scale`, _));
    }
  }
  onTouchcancel(e) {}
  onTouchend(e) {
    if ((this.dispatchMouseEvent(`mouseup`, e.target), this.touchesNum === 1)) {
      (this.clickNum++,
        setTimeout(() => {
          ((this.clickNum = 0),
            (this.lastTouchStartPosition = null),
            (this.lastTouchStartDistance = 0));
        }, 300));
      let e = this.singleTouchstartEvent;
      this.clickNum > 1 &&
        this.lastTouchStartDistance <= 5 &&
        ((this.clickNum = 0), this.dispatchMouseEvent(`dblclick`, e.target, e));
    }
    ((this.touchesNum = 0),
      (this.singleTouchstartEvent = null),
      (this.touchStartScaleView = null));
  }
  dispatchMouseEvent(e, t, n) {
    let r = {};
    n &&
      (r = {
        screenX: n.screenX,
        screenY: n.screenY,
        clientX: n.clientX,
        clientY: n.clientY,
        which: 1,
      });
    let i = new MouseEvent(e, {
      view: document.defaultView,
      bubbles: !0,
      cancelable: !0,
      ...r,
    });
    t.dispatchEvent(i);
  }
  beforePluginRemove() {
    this.unBindEvent();
  }
  beforePluginDestroy() {
    this.unBindEvent();
  }
};
((Qs.instanceName = `touchEvent`),
  $.defineTheme(`customTheme`, {
    lineColor: `#AAAAAA`,
    lineWidth: 2,
    generalizationLineWidth: 3,
    generalizationLineColor: `rgb(51, 51, 51)`,
    backgroundColor: `#ffffff`,
    root: {
      fillColor: `#716ae5`,
      color: `#fff`,
      fontSize: 18,
      borderRadius: 10,
    },
    second: {
      fillColor: `#F0F3F5`,
      borderColor: `#C6DAF7`,
      color: `#1a1a1a`,
      fontSize: 16,
      borderRadius: 4,
      marginY: 10,
      active: { borderColor: `#2870EC` },
    },
    node: {
      fillColor: `#F0F3F5`,
      color: `#1a1a1a`,
      fontSize: 16,
      borderRadius: 4,
      marginY: 10,
      active: { borderColor: `#2870EC` },
    },
    generalization: {},
  }),
  $.usePlugin(Qs));
var $s = ({ data: e, ...t }) => {
    let n = new $({
        isUseCustomNodeContent: !0,
        enableCtrlKeyNodeSelection: !1,
        ...t,
        data: e,
        theme: `customTheme`,
        maxTag: 99,
        beforeTextEdit: () => !1,
      }),
      r = null,
      i = () => {
        (window.clearTimeout(r),
          (r = setTimeout(() => {
            n && n.resize();
          }, 100)));
      };
    return (
      [
        `Control+g`,
        `Control+c`,
        `Control+x`,
        `Control+v`,
        `F2`,
        `Shift+enter`,
        `Control+a`,
        `Control+s`,
        `Control+z`,
        `Control+y`,
        `Tab`,
        `Enter`,
        `Shift+Tab`,
        `Backspace`,
        `Del`,
      ].forEach((e) => n.keyCommand.removeShortcut(e)),
      window.addEventListener(`resize`, i),
      n.on(`beforeDestroy`, () => {
        (window.clearTimeout(r), window.removeEventListener(`resize`, i));
      }),
      n
    );
  },
  ec = {
    flattenTree(e, t) {
      let n = {},
        r = [];
      function i(e, t = null) {
        if (
          (r.push({
            parentId: t,
            labelName: e.data.text,
            level: e.data.level,
            uid: e.data.uid,
          }),
          (n[e.data.uid] = {
            parentId: t,
            labelName: e.data.text,
            level: e.data.level,
            uid: e.data.uid,
          }),
          e.children)
        )
          for (let t of e.children) i(t, e.data.uid);
      }
      for (let t of e) i(t);
      return t ? r : n;
    },
    buildTree(e) {
      let t = new Map(),
        n = [];
      for (let n of e) {
        let { labelName: e, parentId: r, ...i } = n;
        t.set(n.uid, {
          data: { text: i.docNum > 0 ? `${e}（${i.docNum}）` : e, ...i },
          children: [],
        });
      }
      for (let r of e) {
        let e = t.get(r.parentId);
        e ? e.children.push(t.get(r.uid)) : n.push(t.get(r.uid));
      }
      return n;
    },
    MenuItems: [
      { label: `10%`, key: `0.1` },
      { label: `20%`, key: `0.2` },
      { label: `50%`, key: `0.5` },
      { label: `80%`, key: `0.8` },
      { label: `100%`, key: `1` },
      { label: `110%`, key: `1.10` },
      { label: `120%`, key: `1.2` },
      { label: `150%`, key: `1.5` },
      { label: `200%`, key: `2` },
      { label: `300%`, key: `3` },
      { label: `400%`, key: `4` },
      { label: `500%`, key: `5` },
      { label: `适应画布`, key: `fit` },
    ],
  };
(p(),
  (0, S.memo)(({ children: e, ...t }) => (0, C.jsx)(d, { ...t, children: e })));
var tc = { show: !1, top: 0, left: 0, node: null };
function nc() {
  let { state: e } = b(),
    { open: t, form: n } = te(),
    r = (0, S.useRef)(),
    a = (0, S.useRef)(),
    c = (0, S.useRef)(),
    p = (0, S.useRef)(!1),
    h = (0, S.useRef)(!1);
  (0, S.useRef)({ back: !0, forward: !0, isChange: !1 });
  let [y, x] = (0, S.useState)(!1),
    [re, ae] = (0, S.useState)(!1),
    [w, le] = (0, S.useState)(1),
    [ue, de] = (0, S.useState)(null),
    [fe, pe] = (0, S.useState)({ ...tc }),
    T = (0, S.useRef)(null),
    me = async (t) => {
      if (!(!t && h.current)) {
        t || (h.current = !0);
        try {
          let n = t ? t.nodeData.data.uid : ``;
          t || ae(!0);
          let { code: i, data: a } = await ie.getLabels({
            baseId: e?.baseId,
            uid: n,
          });
          if (i !== 0 || !a) return;
          de(a);
          let o = ec.buildTree(a.labels || []);
          (t ||
            (T.current = {
              structureId: a.structureId,
              structureName: a.structureName,
            }),
            t
              ? ((t.nodeData.data._loading = !0),
                r.current.execCommand(`INSERT_MULTI_CHILD_NODE`, [t], o))
              : T.current &&
                (console.log(o, T.current),
                r.current.updateData({
                  children: o,
                  data: {
                    level: 0,
                    text: T.current?.structureName,
                    uid: T.current?.structureId,
                  },
                }),
                r.current.execCommand(`UNEXPAND_TO_LEVEL`, 1),
                setTimeout(() => {
                  ve({ key: `fit` });
                }, 50)));
        } finally {
          t || (ae(!1), (h.current = !1));
        }
      }
    },
    he = (e) => {
      (e?.preventDefault?.(), e?.stopPropagation?.(), ge());
    },
    ge = async () => {
      x(!0);
      let { code: t, data: n } = await ie.checkImportStructure({
        baseId: e?.baseId,
      });
      if ((x(!1), t === 0)) {
        if (n === !0) {
          v.info({
            key: `info`,
            content: `该标签体系中的标签，已经关联了知识库中已发布或发布中的文档，不允许更换。`,
            duration: 5,
          });
          return;
        }
        _e();
      }
    },
    _e = () => {
      t(
        {
          title: `导入知识标签体系`,
          children: (0, C.jsx)(oe, {
            currentStructureId: T.current?.structureId,
          }),
          onOk: (t) => ie.importStructure({ ...t, baseId: e?.baseId }),
          callback: () => {
            me();
          },
        },
        () => {
          n.resetFields();
        },
      );
    },
    ve = ({ key: e }) => {
      e === `fit`
        ? (r.current.view.fit(), le(`fit`))
        : r.current.view.setScale(Number(e));
    };
  return (
    (0, S.useEffect)(() => {
      if (p.current) return;
      if (((p.current = !0), !e?.baseId)) {
        v.error(`参数异常，请重新进入页面`);
        return;
      }
      let t = a.current;
      if (!t || typeof t.getBoundingClientRect != `function`) {
        console.error(`MindMap container is not ready`, t);
        return;
      }
      ((r.current = $s({ readonly: !0, data: null, el: t })),
        r.current.on(`scale`, (e) => le(e)));
      let n = setTimeout(() => {
        (r.current.resize(), r.current.view.fit());
      }, 500);
      return (
        me(),
        () => {
          (window.clearTimeout(n), r.current?.destroy());
        }
      );
    }, []),
    (0, C.jsxs)(ne, {
      title: `查看与编辑`,
      showBack: !0,
      className: se.wrapper,
      contentClassName: se[`body-wrapper`],
      children: [
        (0, C.jsx)(_, {
          className: se.header,
          justify: `space-between`,
          children: (0, C.jsxs)(u, {
            children: [
              (0, C.jsx)(ee, {
                permissions: `1131`,
                children: (0, C.jsx)(d, {
                  title: `导入知识标签体系`,
                  children: (0, C.jsx)(m, {
                    loading: y,
                    icon: (0, C.jsx)(f, {}),
                    shape: `circle`,
                    type: `text`,
                    size: `small`,
                    onClick: he,
                  }),
                }),
              }),
              (0, C.jsx)(o, {
                menu: {
                  items: ec.MenuItems,
                  selectedKeys: [`${w}`],
                  onClick: ve,
                },
                children: (0, C.jsx)(l.Text, {
                  style: { cursor: `pointer` },
                  children:
                    w === `fit` ? `适应画布` : `${(w * 100).toFixed(0)}%`,
                }),
              }),
              (0, C.jsx)(m, {
                shape: `circle`,
                onClick: () => c.current?.open(r.current.getData()),
                type: `text`,
                size: `small`,
                children: (0, C.jsx)(i, {}),
              }),
            ],
          }),
        }),
        (0, C.jsx)(g, {
          spinning: re,
          wrapperClassName: se.body,
          children: (0, C.jsxs)(`div`, {
            className: se.body,
            children: [
              (0, C.jsx)(`div`, { className: se[`mind-map`], ref: a }),
              ue
                ? null
                : (0, C.jsx)(`div`, {
                    className: se[`body-nodata`],
                    children: (0, C.jsx)(s, {
                      description: (0, C.jsxs)(`div`, {
                        children: [
                          `暂无数据，`,
                          (0, C.jsx)(`span`, {
                            onClick: he,
                            style: { color: `#716ae5`, cursor: `pointer` },
                            children: `去导入知识标签体系`,
                          }),
                        ],
                      }),
                      image: s.PRESENTED_IMAGE_SIMPLE,
                    }),
                  }),
            ],
          }),
        }),
        (0, C.jsx)(ce, { ref: c }),
      ],
    })
  );
}
export { nc as default };
