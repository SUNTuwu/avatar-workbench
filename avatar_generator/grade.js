'use strict';
// 滤镜和曲线调色。生成一个 SVG 滤镜（颜色矩阵 + 每个通道一张 256 级查找表），
// 画布用 ctx.filter 套上，GPU 处理，拖曲线时实时更新。只改颜色，不改透明度。

// 滤镜预设。参数都是“满强度”时的值，强度滑块在原图和它之间插值：
//   exposure 曝光(EV)  contrast 对比  curve S 形曲线（中间调对比）  sat 饱和度  temp 色温(+暖/-冷)  tint 色调(+洋红/-绿)
//   fade 提亮黑位（褪色感）  mono 黑白  tone 黑白时的染色 [R,G,B] 倍数  shadow / high 阴影、高光的染色 [R,G,B]
const FILTERS = {
  none:         { label: '原图' },
  vivid:        { label: '鲜明', sat: 1.35, contrast: 1.08, curve: 0.15 },
  vividWarm:    { label: '鲜明暖色', sat: 1.3, contrast: 1.08, curve: 0.15, temp: 0.05 },
  vividCool:    { label: '鲜明冷色', sat: 1.3, contrast: 1.08, curve: 0.15, temp: -0.05 },
  dramatic:     { label: '戏剧', sat: 0.78, contrast: 1.2, curve: 0.5, exposure: -0.15 },
  dramaticWarm: { label: '戏剧暖色', sat: 0.88, contrast: 1.2, curve: 0.5, exposure: -0.15, temp: 0.07, shadow: [0.02, 0, -0.02] },
  dramaticCool: { label: '戏剧冷色', sat: 0.82, contrast: 1.2, curve: 0.5, exposure: -0.15, temp: -0.07, shadow: [-0.02, 0, 0.03] },
  mono:         { label: '单色', mono: true, contrast: 1.05 },
  silvertone:   { label: '银色调', mono: true, contrast: 1.12, curve: 0.25, fade: 0.03, tone: [1.02, 1.0, 0.97] },
  noir:         { label: '黑白', mono: true, contrast: 1.45, curve: 0.55, exposure: -0.1 },
  faded:        { label: '复古褪色', sat: 0.78, contrast: 0.92, fade: 0.1, temp: 0.08, high: [0.02, 0.01, -0.03] },
  cyber:        { label: '赛博', sat: 1.2, contrast: 1.12, curve: 0.2, shadow: [-0.03, 0.04, 0.09], high: [0.06, -0.02, 0.05] },
};
const CURVE_CH = [{ v: 'rgb', label: 'RGB', color: '#ddd' }, { v: 'r', label: '红', color: '#ff5a4e' }, { v: 'g', label: '绿', color: '#5fd36a' }, { v: 'b', label: '蓝', color: '#4a8fd9' }];

// 取自 FINAL 截图中角色的不透明色块。坐标按 8 位 sRGB 记录。
const screenshotGrade = {
  filter: 'none', amount: 1,
  curves: {
    rgb: [[0, 0], [1, 1]],
    r: [[0,0],[79,76],[107,120],[217,244],[222,243],[247,252],[252,254],[255,255]],
    g: [[0,0],[75,74],[154,162],[199,222],[202,219],[222,237],[251,254],[255,255]],
    b: [[0,0],[67,87],[158,176],[185,197],[191,208],[222,239],[245,254],[255,255]],
  },
};
for (const channel of ['r', 'g', 'b'])
  screenshotGrade.curves[channel] = screenshotGrade.curves[channel].map(pair => pair.map(v => v / 255));

const Grade = {
  filter: 'none', amount: 1,
  curves: null, version: 0, id: 'grade0', active: false,
  onChange: null,

  resetCurves(ch) {
    if (!this.curves) this.curves = {};
    for (const c of ch ? [ch] : CURVE_CH.map(c => c.v)) this.curves[c] = [[0, 0], [1, 1]];
  },
  curvesIdentity() { return CURVE_CH.every(c => { const p = this.curves[c.v]; return p.length === 2 && p[0][1] === 0 && p[1][1] === 1; }); },

  // 当前强度下的实际参数
  params() {
    const P = FILTERS[this.filter] || {}, t = this.filter === 'none' ? 0 : this.amount;
    const L = (v, d) => d + ((v ?? d) - d) * t;
    const V = (v, d) => [0, 1, 2].map(i => L(v && v[i], d));
    return {
      exposure: L(P.exposure, 0), contrast: L(P.contrast, 1), curve: L(P.curve, 0), sat: L(P.mono ? 0 : P.sat, 1),
      temp: L(P.temp, 0), tint: L(P.tint, 0), fade: L(P.fade, 0), tone: V(P.tone, 1), shadow: V(P.shadow, 0), high: V(P.high, 0),
    };
  },

  // 3×3 颜色矩阵：先曝光和白平衡，再饱和度，最后黑白染色
  matrix(p) {
    const e = Math.pow(2, p.exposure), wb = [e * (1 + p.temp), e * (1 - p.tint), e * (1 - p.temp)];
    const w = [0.2126, 0.7152, 0.0722], s = p.sat;
    const M = [];
    for (let r = 0; r < 3; r++) {
      M.push([0, 1, 2].map(c => p.tone[r] * ((1 - s) * w[c] + (r === c ? s : 0)) * wb[c]));
    }
    return M;
  },

  // 每个通道的查找表：对比 → S 曲线 → 褪色 → 阴影/高光染色 → 用户 RGB 曲线 → 用户单通道曲线
  tables(p) {
    const master = curveLUT(this.curves.rgb), ch = { r: curveLUT(this.curves.r), g: curveLUT(this.curves.g), b: curveLUT(this.curves.b) };
    const sample = (lut, y) => { const f = Math.min(1, Math.max(0, y)) * 255, i = Math.floor(f), k = f - i; return i >= 255 ? lut[255] : lut[i] + (lut[i + 1] - lut[i]) * k; };
    return ['r', 'g', 'b'].map((c, ci) => {
      const out = new Array(256);
      for (let i = 0; i < 256; i++) {
        const x = i / 255;
        let y = (x - 0.5) * p.contrast + 0.5;
        y = Math.min(1, Math.max(0, y));
        y += p.curve * (y * y * (3 - 2 * y) - y);
        y = p.fade + y * (1 - p.fade);
        y += p.shadow[ci] * (1 - x) * (1 - x) + p.high[ci] * x * x * (1 - x) * 2;
        y = sample(ch[c], sample(master, y));
        out[i] = Math.min(1, Math.max(0, y)).toFixed(4);
      }
      return out.join(' ');
    });
  },

  update() {
    const p = this.params();
    this.active = !(this.filter === 'none' || this.amount === 0) || !this.curvesIdentity();
    // 每次换一个 id：浏览器会缓存同名滤镜，换 id 才能保证马上生效
    this.version++;
    const id = 'grade' + this.version;
    const M = this.matrix(p), tb = this.tables(p);
    const NS = 'http://www.w3.org/2000/svg';
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', id); f.setAttribute('color-interpolation-filters', 'sRGB');
    f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', '100%'); f.setAttribute('height', '100%');
    const cm = document.createElementNS(NS, 'feColorMatrix');
    cm.setAttribute('type', 'matrix');
    cm.setAttribute('values', M.map(r => [...r.map(v => v.toFixed(5)), 0, 0].join(' ')).join(' ') + ' 0 0 0 1 0');
    const ct = document.createElementNS(NS, 'feComponentTransfer');
    ['R', 'G', 'B'].forEach((c, i) => { const fn = document.createElementNS(NS, 'feFunc' + c); fn.setAttribute('type', 'table'); fn.setAttribute('tableValues', tb[i]); ct.appendChild(fn); });
    f.append(cm, ct);
    const defs = gradeDefs();
    const old = defs.querySelector('#' + this.id);
    defs.appendChild(f);
    this.id = id;
    if (old) requestAnimationFrame(() => old.remove());
    if (this.onChange) this.onChange();
  },
  css() { return this.active ? `url(#${this.id})` : 'none'; },

  toJSON() { return { filter: this.filter, amount: this.amount, curves: this.curves }; },
  load(o) {
    if (!o) return;
    if (o.filter in FILTERS) this.filter = o.filter;
    if (typeof o.amount === 'number') this.amount = o.amount;
    if (o.curves) for (const c of CURVE_CH) if (Array.isArray(o.curves[c.v]) && o.curves[c.v].length >= 2) this.curves[c.v] = o.curves[c.v];
    this.update();
  },
};
Grade.resetCurves();

function gradeDefs() {
  let svg = document.getElementById('gradeSvg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'gradeSvg'; svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;width:0;height:0';
    document.body.appendChild(svg);
  }
  return svg;
}

// 单调三次插值（Fritsch–Carlson）：曲线经过每个点，而且两点之间不会过冲。返回 256 级查找表
function curveLUT(pts) {
  const n = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), lut = new Float64Array(256);
  const d = [], s = [];
  for (let i = 0; i < n - 1; i++) { d[i] = Math.max(1e-6, xs[i + 1] - xs[i]); s[i] = (ys[i + 1] - ys[i]) / d[i]; }
  const t = new Array(n);
  t[0] = s[0]; t[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / s[i], b = t[i + 1] / s[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * s[i]; t[i + 1] = k * b * s[i]; }
  }
  let seg = 0;
  for (let j = 0; j < 256; j++) {
    const x = j / 255;
    if (x <= xs[0]) { lut[j] = ys[0]; continue; }
    if (x >= xs[n - 1]) { lut[j] = ys[n - 1]; continue; }
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    const h = d[seg], u = (x - xs[seg]) / h, u2 = u * u, u3 = u2 * u;
    lut[j] = (2 * u3 - 3 * u2 + 1) * ys[seg] + (u3 - 2 * u2 + u) * h * t[seg] + (-2 * u3 + 3 * u2) * ys[seg + 1] + (u3 - u2) * h * t[seg + 1];
  }
  return lut;
}

// 曲线编辑器：点空白处加点，拖动调整；双击、右键或者拖出框外删点；两端的点只能上下动
const CurveEditor = {
  cv: null, ch: 'rgb', drag: -1, hover: -1, hist: null, PAD: 8,
  init(cv) {
    this.cv = cv;
    const pos = e => { const r = cv.getBoundingClientRect(), S = cv.width - 2 * this.PAD; return [((e.clientX - r.left) * cv.width / r.width - this.PAD) / S, 1 - ((e.clientY - r.top) * cv.height / r.height - this.PAD) / S]; };
    const near = (x, y) => { const pts = Grade.curves[this.ch]; let bi = -1, bd = 0.045; pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; bi = i; } }); return bi; };
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const [x, y] = pos(e), pts = Grade.curves[this.ch];
      let i = near(x, y);
      if (i < 0) {
        if (x <= 0.01 || x >= 0.99) return;
        const lut = curveLUT(pts);
        pts.push([x, lut[Math.round(x * 255)]]); pts.sort((a, b) => a[0] - b[0]);
        i = pts.findIndex(p => p[0] === x);
        Grade.update();
      }
      this.drag = i; cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
      const [x, y] = pos(e), pts = Grade.curves[this.ch];
      if (this.drag < 0) { const h = near(x, y); if (h !== this.hover) { this.hover = h; this.draw(); } this.info(x, y); return; }
      const i = this.drag, last = pts.length - 1;
      if (i > 0 && i < last && (y < -0.15 || y > 1.15)) { pts.splice(i, 1); this.drag = -1; Grade.update(); return; }
      const cy = Math.min(1, Math.max(0, y));
      if (i === 0 || i === last) pts[i][1] = cy;
      else pts[i] = [Math.min(pts[i + 1][0] - 0.01, Math.max(pts[i - 1][0] + 0.01, x)), cy];
      Grade.update(); this.info(pts[i][0], pts[i][1]);
    });
    cv.addEventListener('pointerup', () => { this.drag = -1; });
    const del = e => { e.preventDefault(); const [x, y] = pos(e), pts = Grade.curves[this.ch], i = near(x, y); if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); this.hover = -1; Grade.update(); } };
    cv.addEventListener('dblclick', del);
    cv.addEventListener('contextmenu', del);
    cv.addEventListener('pointerleave', () => { if (this.drag < 0) { this.hover = -1; this.draw(); } });
  },
  info(x, y) { const el = document.getElementById('curveInfo'); if (el) el.textContent = x >= 0 && x <= 1 ? `输入 ${Math.round(x * 255)} → 输出 ${Math.round(Math.min(1, Math.max(0, y)) * 255)}` : ''; },
  // 直方图：取当前画面（调色前）的像素统计，透明像素不算
  updateHist(src) {
    if (!this.cv) return;
    const c = this.histCv || (this.histCv = document.createElement('canvas'));
    c.width = 160; c.height = 160;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, 160, 160); g.drawImage(src, 0, 0, 160, 160);
    const d = g.getImageData(0, 0, 160, 160).data, h = new Float64Array(256);
    const ci = { r: 0, g: 1, b: 2 }[this.ch];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const v = ci === undefined ? Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) : d[i + ci];
      h[v]++;
    }
    const m = Math.max(...h.slice(1, 255)) || 1;
    this.hist = Array.from(h, v => Math.min(1, Math.sqrt(v / m)));
    this.draw();
  },
  draw() {
    const cv = this.cv; if (!cv) return;
    const g = cv.getContext('2d'), P = this.PAD, S = cv.width - 2 * P, X = x => P + x * S, Y = y => P + (1 - y) * S;
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#1d2026'; g.fillRect(P, P, S, S);
    const col = CURVE_CH.find(c => c.v === this.ch).color;
    if (this.hist) { g.fillStyle = col + '30'; for (let i = 0; i < 256; i++) { const h = this.hist[i] * S * 0.9; g.fillRect(X(i / 255), P + S - h, S / 256 + 0.5, h); } }
    g.strokeStyle = '#333a44'; g.lineWidth = 1;
    for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(X(k / 4), P); g.lineTo(X(k / 4), P + S); g.moveTo(P, Y(k / 4)); g.lineTo(P + S, Y(k / 4)); g.stroke(); }
    g.strokeStyle = '#444'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(1), Y(1)); g.stroke(); g.setLineDash([]);
    // 其他通道的曲线淡淡地画出来
    for (const c of CURVE_CH) {
      if (c.v === this.ch) continue;
      const p = Grade.curves[c.v]; if (p.length === 2 && p[0][1] === 0 && p[1][1] === 1) continue;
      const lut = curveLUT(p); g.strokeStyle = c.color + '55'; g.beginPath();
      for (let i = 0; i < 256; i++) g[i ? 'lineTo' : 'moveTo'](X(i / 255), Y(lut[i])); g.stroke();
    }
    const pts = Grade.curves[this.ch], lut = curveLUT(pts);
    g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < 256; i++) g[i ? 'lineTo' : 'moveTo'](X(i / 255), Y(lut[i])); g.stroke();
    pts.forEach((p, i) => { g.fillStyle = i === this.drag || i === this.hover ? '#fff' : col; g.strokeStyle = '#111'; g.lineWidth = 1.5; g.beginPath(); g.arc(X(p[0]), Y(p[1]), 5, 0, Math.PI * 2); g.fill(); g.stroke(); });
  },
};
