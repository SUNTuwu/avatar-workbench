'use strict';
// 骨骼和关键帧轨道。
// 每根骨骼有 5 个参数：x、y（平移，PSD 像素）、rot（角度，顺时针为正）、sx、sy（缩放）。
// 一帧的骨骼姿势 = 程序动作（呼吸、跳、点头……）+ 关键帧轨道 + 试看时的临时调整：平移和角度相加，缩放相乘。

// 插值方式：每个关键帧记的是「从上一个关键帧到这一个」用哪种曲线
const EASES = {
  ease:    { label: '缓动',     f: u => 0.5 - 0.5 * Math.cos(Math.PI * u) },
  cubic:   { label: '三次',     f: u => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2) },
  linear:  { label: '线性',     f: u => u },
  bounce:  { label: '弹跳',     f: u => {
    const n = 7.5625, d = 2.75;
    if (u < 1 / d) return n * u * u;
    if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
    if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
    return n * (u -= 2.625 / d) * u + 0.984375;
  } },
  // 冲过头约 40%，再来回晃两下停住
  elastic: { label: '弹性阻尼', f: u => 1 - Math.exp(-4 * u) * Math.cos(5 * Math.PI * u) * Math.sqrt(1 - u) },
  step:    { label: '阶跃',     f: u => (u < 1 ? 0 : 1) },
};

const BONE_DEF = { x: 0, y: 0, rot: 0, sx: 1, sy: 1 };
const BONE_PARAMS = [
  { k: 'rot', label: '角度°', step: 0.5, min: -180, max: 180 },
  { k: 'x', label: 'X', step: 1, min: -200, max: 200 },
  { k: 'y', label: 'Y', step: 1, min: -200, max: 200 },
  { k: 'sx', label: '横缩放', step: 0.01, min: 0.2, max: 3 },
  { k: 'sy', label: '竖缩放', step: 0.01, min: 0.2, max: 3 },
];
const BOX_DEF = { sx: 1, sy: 1, box: 0, anchor: 'wrist' };
const boneById = Object.fromEntries(BONES.map(b => [b.id, b]));

// 轨道：名字 → 按时间排好的关键帧 [{ t, v: {…}, ease }]
//   bone.<骨骼>  { x, y, rot, sx, sy }
//   hand.<手势>  { sx, sy, box(0/1，显示缩放框), anchor('wrist'|'center') }
// 数字分量按插值曲线过渡，其他（开关、字符串）在下一个关键帧处直接切换。
// 第一个关键帧之前是默认值（骨骼归零、缩放框 1×1 不显示），最后一个之后保持最后一个的值。
// 想从某个姿势慢慢过渡过去，就在前面先记一个起点关键帧。
const Tracks = {
  data: {},
  keys(name) { return this.data[name] || []; },
  eval(name, t, def) {
    const K = this.data[name];
    if (!K || !K.length) return { ...def };
    if (t < K[0].t - 1e-6) return { ...def };
    if (t <= K[0].t) return { ...def, ...K[0].v };
    let i = K.length - 1;
    while (i > 0 && K[i].t > t) i--;
    const a = K[i], b = K[i + 1];
    if (!b) return { ...def, ...a.v };
    const e = (EASES[b.ease] || EASES.ease).f((t - a.t) / (b.t - a.t));
    const out = { ...def, ...a.v };
    for (const c in b.v) {
      const x = out[c], y = b.v[c];
      if (typeof x === 'number' && typeof y === 'number' && c !== 'box') out[c] = x + (y - x) * e;
    }
    return out;
  },
  setKey(name, t, v, ease = 'ease') {
    t = +t.toFixed(3);
    const K = this.data[name] || (this.data[name] = []);
    const i = K.findIndex(k => Math.abs(k.t - t) < 1e-3);
    const key = { t, v: { ...v }, ease };
    if (i >= 0) K[i] = key; else { K.push(key); K.sort((a, b) => a.t - b.t); }
  },
  removeKeyAt(name, t) {
    const K = this.data[name]; if (!K) return false;
    const i = K.findIndex(k => Math.abs(k.t - t) < 1e-3);
    if (i < 0) return false;
    K.splice(i, 1); if (!K.length) delete this.data[name];
    return true;
  },
  // 时间在 [t0, t1) 里的关键帧
  inRange(t0, t1) {
    const out = {};
    for (const [n, K] of Object.entries(this.data)) { const ks = K.filter(k => k.t >= t0 && k.t < t1); if (ks.length) out[n] = ks; }
    return out;
  },
  clearRange(t0, t1) {
    for (const n of Object.keys(this.data)) { this.data[n] = this.data[n].filter(k => k.t < t0 || k.t >= t1); if (!this.data[n].length) delete this.data[n]; }
  },
  toJSON() { return JSON.parse(JSON.stringify(this.data)); },
  load(o) { this.data = {}; for (const [n, K] of Object.entries(o || {})) if (Array.isArray(K)) this.data[n] = K.map(k => ({ t: +k.t, v: { ...k.v }, ease: k.ease || 'ease' })).sort((a, b) => a.t - b.t); },
};

function newPose() {
  const p = { hands: {}, force: null, show: true };
  for (const b of BONES) p[b.id] = { ...BONE_DEF };
  return p;
}
function clonePose(p) {
  const q = { hands: {}, force: p.force, show: p.show };
  for (const b of BONES) q[b.id] = { ...p[b.id] };
  for (const [k, v] of Object.entries(p.hands)) q.hands[k] = { ...v };
  return q;
}
const handVals = (p, id) => p.hands[id] || (p.hands[id] = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1 });

// 把轨道值叠到姿势上：平移、角度相加，缩放相乘
function addBoneVals(dst, v) { dst.x += v.x; dst.y += v.y; dst.rot += v.rot; dst.sx *= v.sx; dst.sy *= v.sy; }

// 每根骨骼的世界矩阵：父骨骼矩阵 × 绕自己的 pivot 平移、旋转、缩放
function boneLocal(b, v) {
  const [px, py] = b.pivot;
  return new DOMMatrix().translate(px + v.x, py + v.y).rotate(v.rot).scale(v.sx, v.sy).translate(-px, -py);
}
function computeSkeleton(root, pose) {
  const W = {};
  for (const b of BONES) W[b.id] = (b.parent ? W[b.parent] : root).multiply(boneLocal(b, pose[b.id]));
  return W;
}
const bonePivotW = (W, id) => { const b = boneById[id]; return W[id].transformPoint(new DOMPoint(b.pivot[0], b.pivot[1])); };
const boneTipW = (W, id) => { const b = boneById[id]; return W[id].transformPoint(new DOMPoint(b.tip[0], b.tip[1])); };

// CCD IK：转动 chain 里的骨骼（从末端往根），让 end 骨骼的末端尽量靠近 target（画布坐标）。返回每根骨骼要加的角度
// 末端骨骼先对准目标；父骨骼只帮忙补一部分（越靠根分得越少），所以拖耳朵尖主要是耳朵在转，头只跟着偏一点
function solveIK(root, pose, end, chain, target, iters = 8) {
  const p = clonePose(pose), delta = {};
  for (let it = 0; it < iters; it++) {
    chain.forEach((id, depth) => {
      const W = computeSkeleton(root, p), tip = boneTipW(W, end), piv = bonePivotW(W, id);
      const a1 = Math.atan2(tip.y - piv.y, tip.x - piv.x), a2 = Math.atan2(target.y - piv.y, target.x - piv.x);
      let d = (a2 - a1) * 180 / Math.PI;
      d = ((d + 540) % 360) - 180;
      d *= depth ? 0.25 / depth : 1;
      p[id].rot += d; delta[id] = (delta[id] || 0) + d;
    });
  }
  return delta;
}
