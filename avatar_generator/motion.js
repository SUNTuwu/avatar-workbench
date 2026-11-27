'use strict';
// 程序动作，全部写成对骨骼参数的增量（p.body / p.head / p.earL / p.earR），手势动作写在 handVals(p, 手势) 上。
// 角度顺时针为正。角色面朝画面左边，所以「低头 / 往前倾」是负角度；左耳往外是负、右耳往外是正。
const ease = u => u * u * (3 - 2 * u);
const easeOutCubic = u => 1 - Math.pow(1 - u, 3);
const easeInCubic = u => u * u * u;
const noise = (i, seed) => { const s = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
const fadeEnv = (u, a) => u < a ? ease(u / a) : u > 1 - a ? ease((1 - u) / a) : 1;
const bump = u => Math.sin(Math.PI * Math.min(1, Math.max(0, u)));

// 两只耳朵往外甩（k>0）或往里收（k<0）
function earsOut(p, k) { p.earL.rot -= k; p.earR.rot += k; }

function hop(p, u, H) {
  if (u < 0.18) { const q = Math.sin(u / 0.18 * Math.PI) * 0.09; p.body.sy *= 1 - q; p.body.sx *= 1 + q * 0.6; }
  else if (u < 0.82) {
    const v = (u - 0.18) / 0.64, st = 0.05 * Math.sin(v * Math.PI);
    p.body.y -= H * 4 * v * (1 - v); p.body.sy *= 1 + st; p.body.sx *= 1 - st * 0.6; p.head.y += 4 * Math.sin(v * Math.PI);
    earsOut(p, -6 * Math.sin(v * Math.PI));          // 腾空时耳朵往后收
  } else { const q = Math.sin((u - 0.82) / 0.18 * Math.PI) * 0.1; p.body.sy *= 1 - q; p.body.sx *= 1 + q * 0.6; earsOut(p, 10 * q * 10); }
}
const swing = v => Math.sin(v * Math.PI * 3) * Math.exp(-2.1 * v) * fadeEnv(v, 0.14);
const lag = (u, d) => Math.max(0, (u - d) / (1 - d));

function wavePaw(h, u, beat, rate) {
  const phase = Math.PI * beat * rate;
  const startPhase = phase - 4 * Math.PI * u;
  h.rot += 8 * (Math.cos(phase) - Math.cos(startPhase));
  h.beckonSpeed = (h.beckonSpeed || 0) - 8 * Math.PI * rate * Math.sin(phase) / beatSeconds();
}
function waveAction(label, rate) {
  return { label, wave: true, beats: 4 / rate, fn(p, u, t, beat) {
    p.force = { L: 'paw' };
    wavePaw(handVals(p, 'paw'), u, beat, rate);
  } };
}
const ACTIONS = {
  pop:     { label: '弹入', key: 'q', beats: 1, fn: (p, u) => {
    const s = 1 - Math.pow(2, -9 * u) * Math.cos(u * Math.PI * 3.2);
    p.body.sx *= s; p.body.sy *= s; p.body.y += (1 - easeOutCubic(u)) * 140; p.body.rot += Math.sin(u * Math.PI * 3) * (1 - u) * 6;
    earsOut(p, 10 * Math.sin(u * Math.PI * 4) * (1 - u));
  } },
  out:     { label: '弹出', key: 'w', beats: 1, fn: (p, u) => {
    const s = u < 0.25 ? 1 + 0.08 * Math.sin(u / 0.25 * Math.PI / 2) : 1.08 * Math.pow(1 - (u - 0.25) / 0.75, 2);
    p.body.sx *= s; p.body.sy *= s; if (u > 0.25) p.body.y += easeInCubic((u - 0.25) / 0.75) * 100;
  } },
  hop:     { label: '跳', key: 'r', beats: 1, fn: (p, u) => hop(p, u, 70) },
  hop2:    { label: '连跳', key: 't', beats: 2, fn: (p, u) => hop(p, (u * 2) % 1, 45) },
  bounce:  { label: 'Q弹', key: 'j', beats: 1.5, fn: (p, u) => { const k = Math.sin(u * Math.PI * 3) * (1 - u); p.body.sy *= 1 + 0.12 * k; p.body.sx *= 1 - 0.08 * k; earsOut(p, 6 * k); } },
  // 点头：头绕脖子往前（画面左下）点，同时往下沉一点；耳朵慢半拍
  nod:     { label: '点头', key: 'y', beats: 1, fn: (p, u) => {
    const k = Math.abs(Math.sin(u * Math.PI * 2)) * (1 - u * 0.3);
    p.head.rot -= 5 * k; p.head.y += 6 * k;
    const kl = Math.abs(Math.sin(lag(u, 0.08) * Math.PI * 2)) * (1 - u * 0.3);
    earsOut(p, 5 * kl);
  } },
  shake:   { label: '摇头', key: 'h', beats: 1.25, fn: (p, u) => {
    p.head.rot += 8 * Math.sin(u * Math.PI * 5) * (1 - u);
    const l = -5 * Math.sin(u * Math.PI * 5 - 0.9) * (1 - u);
    p.earL.rot += l; p.earR.rot += l;
  } },
  tilt:    { label: '歪头', key: 'g', beats: 3, fn: (p, u) => { const e = fadeEnv(u, 0.2); p.head.rot += 10 * e; p.body.rot += 2 * e; p.earL.rot += 3 * fadeEnv(lag(u, 0.06), 0.2); p.earR.rot += 3 * fadeEnv(lag(u, 0.06), 0.2); } },
  sway:    { label: '摇身', key: 's', beats: 3, fn: (p, u) => {
    p.body.rot += 7 * swing(u);
    // 按当前摆动方向选爪形；直接采样曲线，跳转时间轴也能得到同一帧。
    const before = Math.max(0, u - 0.0001), after = Math.min(1, u + 0.0001);
    const speed = 7 * (swing(after) - swing(before)) / ((after - before) * actionSeconds(ACTIONS.sway));
    p.swaySpeed = (p.swaySpeed || 0) + speed;
    p.head.rot += 1.8 * swing(lag(u, 0.045));
    const e = -4 * swing(lag(u, 0.1)); p.earL.rot += e; p.earR.rot += e;
  } },
  tremble: { label: '发抖', key: 'f', beats: 1.5, fn: (p, u, t) => { const a = 4 * (1 - u * u), i = Math.floor(t / beatSeconds() * 16); p.body.x += noise(i, 1) * a; p.body.y += noise(i, 2) * a * 0.6; } },
  earflick:{ label: '抖耳朵', key: 'k', beats: 1, fn: (p, u) => earsOut(p, 14 * Math.sin(u * Math.PI * 4) * (1 - u)) },
  earL:    { label: '抖左耳', beats: 1, fn: (p, u) => { p.earL.rot -= 16 * Math.sin(u * Math.PI * 4) * (1 - u); } },
  earR:    { label: '抖右耳', beats: 1, fn: (p, u) => { p.earR.rot += 16 * Math.sin(u * Math.PI * 4) * (1 - u); } },
  // 全局挥手使用两帧爪形，和爪爪专属挥手保持一致。
  wave:     { ...waveAction('挥手', 1), key: 'v' },
  waveFast: waveAction('快速挥手', 2),
};

// 手势专属动画：h 是这个手势的 { dx, dy, rot, sx, sy }（绕手腕），p 是整体姿势
const HAND_ANIMS = {
  lift:     { label: '托举',   beats: 2, fn: (h, p, u) => { const k = fadeEnv(u, 0.3); h.dy -= 35 * k; h.rot -= 4 * k; p.head.rot -= 2 * k; } },
  offer:    { label: '递出',   beats: 2, fn: (h, p, u) => { const k = fadeEnv(u, 0.25); h.dx -= 30 * k; h.dy -= 10 * k; p.body.rot -= 1.5 * k; } },
  wag:      { label: '摇手指', beats: 3, fn: (h, p, u) => {
    // 半拍走向另一侧，在转向点和首尾都自然减速。
    const poses = [0, -10, 12, -12, 12, -10, 0];
    const step = u * 6, i = Math.min(5, Math.floor(step)), blend = (1 - Math.cos(Math.PI * (step - i))) / 2;
    h.rot += poses[i] + (poses[i + 1] - poses[i]) * blend;
  } },
  poke:     { label: '戳戳',   beats: 1.5, fn: (h, p, u) => { const k = Math.abs(Math.sin(u * Math.PI * 3)); h.dy -= 16 * k; h.dx -= 6 * k; } },
  jab:      { label: '指指天', beats: 1.5, fn: (h, p, u) => { const k = Math.abs(Math.sin(u * Math.PI * 3)); h.dy -= 22 * k; p.head.rot += 2 * fadeEnv(u, 0.2); } },
  present:  { label: '请看',   beats: 2, fn: (h, p, u) => { const k = fadeEnv(u, 0.2); h.dx -= 18 * k; h.rot += 4 * k; p.head.rot -= 2 * k; } },
  jabL:     { label: '指指点点', beats: 1.5, fn: (h, p, u) => { h.dx -= 18 * Math.abs(Math.sin(u * Math.PI * 3)); } },
  jabR:     { label: '指指点点', beats: 1.5, fn: (h, p, u) => { h.dx += 18 * Math.abs(Math.sin(u * Math.PI * 3)); } },
  beckon:   { label: '挥手', beats: 4, fn: (h, p, u, t, beat) => wavePaw(h, u, beat, 1) },
  beckonFast: { label: '快速挥手', beats: 2, fn: (h, p, u, t, beat) => wavePaw(h, u, beat, 2) },
  // 保留旧关键帧 ID。以肩为锚沿上臂伸展两次，第二次轻一些。
  waveArm:  { label: '指指', beats: 2, fn: (h, p, u) => {
    const pulse = Math.sin(2 * Math.PI * u) ** 2 * (u < 0.5 ? 1 : 0.75);
    h.sy *= 1 + 0.075 * pulse;
    h.sx *= 1 + 0.035 * pulse;
  } },
  hope:     { label: '期待抖', beats: 2, fn: (h, p, u) => { const e = fadeEnv(u, 0.2); h.rot += 5 * Math.sin(u * Math.PI * 8) * e; h.dy -= 6 * e; p.head.rot += 4 * e; earsOut(p, -4 * e); } },
  stroke:   { label: '摸下巴', beats: 2, fn: (h, p, u) => { const e = fadeEnv(u, 0.15); h.dy += 6 * Math.sin(u * Math.PI * 4) * e; h.dx += 2 * Math.sin(u * Math.PI * 4) * e; p.head.rot -= 2 * e; } },
  swayHeart:{ label: '晃晃', beats: 3, fn: (h, p, u) => {
    const envelope = fadeEnv(u, 0.12), phase = 2 * Math.PI * u;
    const swing = Math.sin(phase) * envelope;
    const scale = 1 + 0.055 * swing ** 4;
    h.rot += 9 * swing; h.sx *= scale; h.sy *= scale;
    p.body.rot += 2 * swing; p.head.rot += 2 * Math.sin(phase - 0.4) * envelope;
  } },
  // 拜一拜：三下，手往下压、头和身体往前点，耳朵跟着耷拉
  bow:      { label: '拜一拜', beats: 3, fn: (h, p, u) => {
    const v = (u * 3) % 1, k = Math.sin(Math.PI * v) ** 2;
    h.dy += 16 * k; h.rot -= 4 * k; p.head.rot -= 7 * k; p.head.y += 8 * k; p.body.rot -= 2.5 * k; earsOut(p, 5 * k);
  } },
  rub:      { label: '搓手',   beats: 2, fn: (h, p, u) => { const e = fadeEnv(u, 0.1); h.dx += 4 * Math.sin(u * Math.PI * 16) * e; h.rot += 2 * Math.sin(u * Math.PI * 16 + 1) * e; } },
  huff:     { label: '哼',     beats: 2, fn: (h, p, u) => { const k = fadeEnv(u, 0.2); p.body.rot += 3 * k; p.head.rot += 7 * k; p.head.y -= 4 * k; h.dy -= 4 * k; earsOut(p, -5 * k); } },
  scratch:  { label: '挠挠',   beats: 2, fn: (h, p, u) => { const e = fadeEnv(u, 0.1); h.rot += 5 * Math.sin(u * Math.PI * 16) * e; h.dy += 4 * Math.sin(u * Math.PI * 16 + 1.5) * e; } },
  pounce:   { label: '扑',     beats: 1.5, fn: (h, p, u) => { hop(p, u, 35); h.dy -= 20 * bump(u); h.sy *= 1 + 0.12 * bump(u); } },
  // 打call：两只手各自平移画圈，在上面时往外走（画面左手逆时针、右手顺时针），拇指跟着歪；头和身体跟着节奏点
  cheer:    { label: '打call', beats: 2, fn: (h, p, u) => {
    const e = fadeEnv(u, 0.12), th = 2 * Math.PI * 2 * u, r = 20 * e, L = partVals(h, 0), R = partVals(h, 1);
    L.dx -= r * Math.sin(th); L.dy += r * (1 - Math.cos(th)); L.rot -= 10 * Math.sin(th) * e;
    R.dx += r * Math.sin(th); R.dy += r * (1 - Math.cos(th)); R.rot += 10 * Math.sin(th) * e;
    p.head.rot -= 2.5 * Math.abs(Math.sin(th)) * e; p.body.y -= 4 * Math.abs(Math.sin(th)) * e; earsOut(p, 3 * Math.sin(2 * th) * e);
  } },
  // 对手指：两根指尖分开又碰上，四下；低头、耳朵往后收，害羞
  tapTips:  { label: '戳手指', beats: 2, fn: (h, p, u) => {
    const e = fadeEnv(u, 0.15), gap = 12 * Math.abs(Math.sin(4 * Math.PI * u)) * e, L = partVals(h, 0), R = partVals(h, 1);
    L.dx -= gap; L.rot -= 0.35 * gap; R.dx += gap; R.rot += 0.35 * gap;
    p.head.rot -= 3 * e; p.head.y += 3 * e; earsOut(p, -5 * e);
  } },
  fidget:   { label: '扭扭捏捏', beats: 3, fn: (h, p, u) => {
    const e = fadeEnv(u, 0.15), s = Math.sin(6 * Math.PI * u) * e, L = partVals(h, 0), R = partVals(h, 1);
    L.dy += 5 * s; L.rot -= 4 * s; R.dy -= 5 * s; R.rot -= 4 * s;
    p.body.rot += 1.2 * Math.sin(2 * Math.PI * u) * e; p.head.rot -= 2 * e; earsOut(p, -3 * e);
  } },
  thumbUp:  { label: '点赞',   beats: 1.5, fn: (h, p, u) => { const k = bump(u / 0.6) * (u < 0.6 ? 1 : 0) + (u >= 0.6 ? 0 : 0); const s = 1 + 0.15 * fadeEnv(u, 0.3); h.dy -= 20 * k; h.sx *= s; h.sy *= s; } },
};
