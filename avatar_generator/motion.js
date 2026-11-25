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

const ACTIONS = {
  pop:     { label: '弹入', key: 'q', dur: 0.6, fn: (p, u) => {
    const s = 1 - Math.pow(2, -9 * u) * Math.cos(u * Math.PI * 3.2);
    p.body.sx *= s; p.body.sy *= s; p.body.y += (1 - easeOutCubic(u)) * 140; p.body.rot += Math.sin(u * Math.PI * 3) * (1 - u) * 6;
    earsOut(p, 10 * Math.sin(u * Math.PI * 4) * (1 - u));
  } },
  out:     { label: '弹出', key: 'w', dur: 0.4, fn: (p, u) => {
    const s = u < 0.25 ? 1 + 0.08 * Math.sin(u / 0.25 * Math.PI / 2) : 1.08 * Math.pow(1 - (u - 0.25) / 0.75, 2);
    p.body.sx *= s; p.body.sy *= s; if (u > 0.25) p.body.y += easeInCubic((u - 0.25) / 0.75) * 100;
  } },
  hop:     { label: '跳', key: 'r', dur: 0.5, fn: (p, u) => hop(p, u, 70) },
  hop2:    { label: '连跳', key: 't', dur: 0.9, fn: (p, u) => hop(p, (u * 2) % 1, 45) },
  bounce:  { label: 'Q弹', key: 'j', dur: 0.55, fn: (p, u) => { const k = Math.sin(u * Math.PI * 3) * (1 - u); p.body.sy *= 1 + 0.12 * k; p.body.sx *= 1 - 0.08 * k; earsOut(p, 6 * k); } },
  // 点头：头绕脖子往前（画面左下）点，同时往下沉一点；耳朵慢半拍
  nod:     { label: '点头', key: 'y', dur: 0.6, fn: (p, u) => {
    const k = Math.abs(Math.sin(u * Math.PI * 2)) * (1 - u * 0.3);
    p.head.rot -= 5 * k; p.head.y += 6 * k;
    const kl = Math.abs(Math.sin(lag(u, 0.08) * Math.PI * 2)) * (1 - u * 0.3);
    earsOut(p, 5 * kl);
  } },
  shake:   { label: '摇头', key: 'h', dur: 0.7, fn: (p, u) => {
    p.head.rot += 8 * Math.sin(u * Math.PI * 5) * (1 - u);
    const l = -5 * Math.sin(u * Math.PI * 5 - 0.9) * (1 - u);
    p.earL.rot += l; p.earR.rot += l;
  } },
  tilt:    { label: '歪头', key: 'g', dur: 1.4, fn: (p, u) => { const e = fadeEnv(u, 0.2); p.head.rot += 10 * e; p.body.rot += 2 * e; p.earL.rot += 3 * fadeEnv(lag(u, 0.06), 0.2); p.earR.rot += 3 * fadeEnv(lag(u, 0.06), 0.2); } },
  sway:    { label: '摇身', key: 's', dur: 1.35, fn: (p, u) => {
    p.body.rot += 7 * swing(u);
    p.head.rot += 1.8 * swing(lag(u, 0.045));
    const e = -4 * swing(lag(u, 0.1)); p.earL.rot += e; p.earR.rot += e;
  } },
  tremble: { label: '发抖', key: 'f', dur: 0.8, fn: (p, u, t) => { const a = 4 * (1 - u * u), i = Math.floor(t * 30); p.body.x += noise(i, 1) * a; p.body.y += noise(i, 2) * a * 0.6; } },
  earflick:{ label: '抖耳朵', key: 'k', dur: 0.5, fn: (p, u) => earsOut(p, 14 * Math.sin(u * Math.PI * 4) * (1 - u)) },
  earL:    { label: '抖左耳', dur: 0.45, fn: (p, u) => { p.earL.rot -= 16 * Math.sin(u * Math.PI * 4) * (1 - u); } },
  earR:    { label: '抖右耳', dur: 0.45, fn: (p, u) => { p.earR.rot += 16 * Math.sin(u * Math.PI * 4) * (1 - u); } },
  // 挥手：临时把画面左手换成「举手」，手臂绕肩膀摆
  wave:    { label: '挥手', key: 'v', dur: 1.6, fn: (p, u) => { p.force = { L: 'raise' }; HAND_ANIMS.waveArm.fn(handVals(p, 'raise'), p, u); } },
};

// 手势专属动画：h 是这个手势的 { dx, dy, rot, sx, sy }（绕手腕），p 是整体姿势
const HAND_ANIMS = {
  lift:     { label: '托举',   dur: 1.0, fn: (h, p, u) => { const k = fadeEnv(u, 0.3); h.dy -= 35 * k; h.rot -= 4 * k; p.head.rot -= 2 * k; } },
  offer:    { label: '递出',   dur: 0.9, fn: (h, p, u) => { const k = fadeEnv(u, 0.25); h.dx -= 30 * k; h.dy -= 10 * k; p.body.rot -= 1.5 * k; } },
  wag:      { label: '摇手指', dur: 1.0, fn: (h, p, u) => { h.rot += 14 * Math.sin(u * Math.PI * 6) * fadeEnv(u, 0.1); } },
  poke:     { label: '戳戳',   dur: 0.8, fn: (h, p, u) => { const k = Math.abs(Math.sin(u * Math.PI * 3)); h.dy -= 16 * k; h.dx -= 6 * k; } },
  jab:      { label: '指指天', dur: 0.9, fn: (h, p, u) => { const k = Math.abs(Math.sin(u * Math.PI * 3)); h.dy -= 22 * k; p.head.rot += 2 * fadeEnv(u, 0.2); } },
  present:  { label: '请看',   dur: 0.9, fn: (h, p, u) => { const k = fadeEnv(u, 0.2); h.dx -= 18 * k; h.rot += 4 * k; p.head.rot -= 2 * k; } },
  jabL:     { label: '指指点点', dur: 0.9, fn: (h, p, u) => { h.dx -= 18 * Math.abs(Math.sin(u * Math.PI * 3)); } },
  jabR:     { label: '指指点点', dur: 0.9, fn: (h, p, u) => { h.dx += 18 * Math.abs(Math.sin(u * Math.PI * 3)); } },
  beckon:   { label: '招财猫', dur: 1.4, fn: (h, p, u) => { h.rot -= 16 * Math.max(0, Math.sin(u * Math.PI * 5)) * fadeEnv(u, 0.1); } },
  waveArm:  { label: '挥手',   dur: 1.6, fn: (h, p, u) => { h.rot += 9 * Math.sin(u * Math.PI * 6) * fadeEnv(u, 0.15); earsOut(p, 2 * Math.sin(u * Math.PI * 6 - 1) * fadeEnv(u, 0.15)); } },
  hope:     { label: '期待抖', dur: 1.0, fn: (h, p, u) => { const e = fadeEnv(u, 0.2); h.rot += 5 * Math.sin(u * Math.PI * 10) * e; h.dy -= 6 * e; p.head.rot += 4 * e; earsOut(p, -4 * e); } },
  stroke:   { label: '摸下巴', dur: 1.4, fn: (h, p, u) => { const e = fadeEnv(u, 0.15); h.dy += 6 * Math.sin(u * Math.PI * 4) * e; h.dx += 2 * Math.sin(u * Math.PI * 4) * e; p.head.rot -= 2 * e; } },
  beat:     { label: '心跳',   dur: 1.2, fn: (h, p, u) => {
    const v = (u * 2) % 1, s = 1 + 0.14 * Math.exp(-(((v - 0.12) / 0.06) ** 2)) + 0.09 * Math.exp(-(((v - 0.32) / 0.06) ** 2));
    h.sx *= s; h.sy *= s;
  } },
  swayHeart:{ label: '晃晃',   dur: 1.4, fn: (h, p, u) => { const e = fadeEnv(u, 0.15), s = Math.sin(u * Math.PI * 4); h.rot += 9 * s * e; p.body.rot += 2 * s * e; p.head.rot += 2 * Math.sin(u * Math.PI * 4 - 0.5) * e; } },
  // 拜一拜：三下，手往下压、头和身体往前点，耳朵跟着耷拉
  bow:      { label: '拜一拜', dur: 1.8, fn: (h, p, u) => {
    const v = (u * 3) % 1, k = Math.sin(Math.PI * v) ** 2;
    h.dy += 16 * k; h.rot -= 4 * k; p.head.rot -= 7 * k; p.head.y += 8 * k; p.body.rot -= 2.5 * k; earsOut(p, 5 * k);
  } },
  rub:      { label: '搓手',   dur: 1.0, fn: (h, p, u) => { const e = fadeEnv(u, 0.1); h.dx += 4 * Math.sin(u * Math.PI * 16) * e; h.rot += 2 * Math.sin(u * Math.PI * 16 + 1) * e; } },
  huff:     { label: '哼',     dur: 1.0, fn: (h, p, u) => { const k = fadeEnv(u, 0.2); p.body.rot += 3 * k; p.head.rot += 7 * k; p.head.y -= 4 * k; h.dy -= 4 * k; earsOut(p, -5 * k); } },
  scratch:  { label: '挠挠',   dur: 1.0, fn: (h, p, u) => { const e = fadeEnv(u, 0.1); h.rot += 5 * Math.sin(u * Math.PI * 14) * e; h.dy += 4 * Math.sin(u * Math.PI * 14 + 1.5) * e; } },
  pounce:   { label: '扑',     dur: 0.7, fn: (h, p, u) => { hop(p, u, 35); h.dy -= 20 * bump(u); h.sy *= 1 + 0.12 * bump(u); } },
  thumbUp:  { label: '点赞',   dur: 0.8, fn: (h, p, u) => { const k = bump(u / 0.6) * (u < 0.6 ? 1 : 0) + (u >= 0.6 ? 0 : 0); const s = 1 + 0.15 * fadeEnv(u, 0.3); h.dy -= 20 * k; h.sx *= s; h.sy *= s; } },
};
