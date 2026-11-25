'use strict';
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = u => u * u * (3 - 2 * u);
const easeOutCubic = u => 1 - Math.pow(1 - u, 3);
const easeInCubic = u => u * u * u;
const noise = (i, seed) => { const s = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };

function mulberry32(a) { return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function schedule(seed, min, max, horizon = 4000) { const r = mulberry32(seed), out = []; let t = min * r(); while (t < horizon) { out.push(t); t += min + (max - min) * r(); } return out; }
function inWindow(starts, t, dur) { let lo = 0, hi = starts.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 && t - starts[k] < dur; }
const BLINK_T = schedule(7, 2.2, 5.0);
const EAR_T = schedule(13, 4, 9);

// ---------- 动作 ----------
function hop(m, u, H) {
  if (u < 0.18) { const q = Math.sin(u / 0.18 * Math.PI) * 0.09; m.sy *= 1 - q; m.sx *= 1 + q * 0.6; }
  else if (u < 0.82) { const v = (u - 0.18) / 0.64, st = 0.05 * Math.sin(v * Math.PI); m.y -= H * 4 * v * (1 - v); m.sy *= 1 + st; m.sx *= 1 - st * 0.6; m.headY += 4 * Math.sin(v * Math.PI); }
  else { const q = Math.sin((u - 0.82) / 0.18 * Math.PI) * 0.1; m.sy *= 1 - q; m.sx *= 1 + q * 0.6; }
}
const fadeEnv = (u, a) => u < a ? ease(u / a) : u > 1 - a ? ease((1 - u) / a) : 1;
const ACTIONS = {
  pop:     { label: '弹入', key: 'q', dur: 0.6,  fn: (m, u) => { const s = 1 - Math.pow(2, -9 * u) * Math.cos(u * Math.PI * 3.2); m.sx *= s; m.sy *= s; m.y += (1 - easeOutCubic(u)) * 140; m.rot += Math.sin(u * Math.PI * 3) * (1 - u) * 6; } },
  out:     { label: '弹出', key: 'w', dur: 0.4,  fn: (m, u) => { const s = u < 0.25 ? 1 + 0.08 * Math.sin(u / 0.25 * Math.PI / 2) : 1.08 * Math.pow(1 - (u - 0.25) / 0.75, 2); m.sx *= s; m.sy *= s; if (u > 0.25) m.y += easeInCubic((u - 0.25) / 0.75) * 100; } },
  hop:     { label: '跳', key: 'r', dur: 0.5, fn: (m, u) => hop(m, u, 70) },
  hop2:    { label: '连跳', key: 't', dur: 0.9, fn: (m, u) => hop(m, (u * 2) % 1, 45) },
  bounce:  { label: 'Q弹', key: 'j', dur: 0.55, fn: (m, u) => { const k = Math.sin(u * Math.PI * 3) * (1 - u); m.sy *= 1 + 0.12 * k; m.sx *= 1 - 0.08 * k; } },
  nod:     { label: '点头', key: 'y', dur: 0.6, fn: (m, u) => { const k = Math.abs(Math.sin(u * Math.PI * 2)); m.headY += 9 * k * (1 - u * 0.3); m.headRot -= 2 * k; } },
  shake:   { label: '摇头', key: 'h', dur: 0.7, fn: (m, u) => { m.headRot += 8 * Math.sin(u * Math.PI * 5) * (1 - u); } },
  tilt:    { label: '歪头', key: 'g', dur: 1.4, fn: (m, u) => { const e = fadeEnv(u, 0.2); m.headRot += 10 * e; m.rot += 2 * e; } },
  sway:    { label: '摇身', key: 's', dur: 1.35, fn: (m, u) => {
    const swing = v => Math.sin(v * Math.PI * 3) * Math.exp(-2.1 * v) * fadeEnv(v, 0.14);
    m.rot += 7 * swing(u);
    // 身体绕脚底带动手和道具，头绕颈部稍晚回弹。
    m.headRot += 1.8 * swing(Math.max(0, (u - 0.045) / 0.955));
  } },
  tremble: { label: '发抖', key: 'f', dur: 0.8, fn: (m, u, t) => { const a = 4 * (1 - u * u), i = Math.floor(t * 30); m.x += noise(i, 1) * a; m.y += noise(i, 2) * a * 0.6; } },
  wave:    { label: '挥手', key: 'v', dur: 1.6, fn: (m, u) => { const e = fadeEnv(u, 0.15); m.wave = true; m.handY += (1 - e) * 160; m.handRot += 14 * Math.sin(u * Math.PI * 6) * e; } },
};

// ---------- 全局状态 ----------
const App = {
  layers: [], ready: false,
  events: [], history: [],
  live: { over: [], acts: [] },
  visemes: null, audioBuf: null, audioName: '',
  duration: 20, t: 0, playing: false, recording: false,
  wallStart: 0, tStart: 0, pauseWall: performance.now(),
  view0: 0, exporting: false, cancel: false,
};
const S = {};
const SETTING_IDS = ['boilFps', 'jitter', 'idle', 'blink', 'earTwitch', 'talkBob', 'startHidden', 'outW', 'outH', 'scale', 'ax', 'ay', 'fps', 'lapScale', 'lapX', 'lapY'];
function readSettings() {
  for (const k of SETTING_IDS) { const el = $('#s_' + k); S[k] = el.type === 'checkbox' ? el.checked : +el.value; }
  const view = $('#view');
  if (view.width !== S.outW || view.height !== S.outH) { view.width = S.outW; view.height = S.outH; }
}
function writeSettings(o) {
  for (const k of SETTING_IDS) { if (!(k in o)) continue; const el = $('#s_' + k); if (el.type === 'checkbox') el.checked = !!o[k]; else el.value = o[k]; }
  readSettings();
}

const audio = $('#audio'), refVideo = $('#refVideo');
const status = (msg, err) => { const el = $('#status'); el.textContent = msg; el.className = err ? 'err' : ''; };

// ---------- 状态计算 ----------
function initialState() {
  return { expr: 'normal', eyes: 'normal', ears: 'up', idleMouth: 'n', whiskers: 'normal', loop: null, hand: 'none', laptop: 'none', mouth: null, visible: !S.startHidden };
}
function applyEvent(s, k, v) {
  if (k === 'expr') {
    const x = EXPRESSIONS[v]; if (!x) return;
    Object.assign(s, { expr: v, eyes: x.eyes, ears: x.ears, idleMouth: x.mouth, whiskers: x.whiskers || 'normal', loop: x.loop || null });
  } else if (k === 'act') {
    if (v === 'pop') s.visible = true;
    if (v === 'out') s.visible = false;
  }
  // 兼容旧工程：以前的「敲电脑」= 展示手 + 白屏电脑；「FINAL 字」开关；身体方向现在跟手势走，旧的 body 关键帧忽略
  else if (k === 'hand' && v === 'laptop') { s.hand = 'show'; s.laptop = 'white'; }
  else if (k === 'final') s.laptop = v ? 'final' : 'none';
  else if (k === 'body') {}
  else s[k] = v;
}
function stateAt(t, live) {
  const st = initialState(), acts = [];
  for (const e of App.events) {
    if (e.t > t + 1e-9) break;
    applyEvent(st, e.k, e.v);
    if (e.k === 'act') acts.push(e);
  }
  if (live) for (const [k, v] of App.live.over) applyEvent(st, k, v);
  return { st, acts };
}
function visemeAt(t) {
  const V = App.visemes; if (!V) return { label: null, energy: 0 };
  const i = Math.floor(t * V.fps);
  return i >= 0 && i < V.labels.length ? { label: V.labels[i], energy: V.energy[i] || 0 } : { label: null, energy: 0 };
}

// ---------- 绘制 ----------
// t：关键帧时间；tIdle：呼吸/眨眼/抖动用的时间（暂停时也继续走，导出时等于 t）
function drawAvatar(ctx, t, tIdle, live, now) {
  const { st, acts } = stateAt(t, live);
  const active = [];
  for (const a of acts) { const D = ACTIONS[a.v]; if (D && t >= a.t && t < a.t + D.dur) active.push({ v: a.v, u: (t - a.t) / D.dur }); }
  if (live) for (const la of App.live.acts) { const u = (now - la.start) / 1000 / ACTIONS[la.v].dur; if (u >= 0 && u < 1) active.push({ v: la.v, u }); }

  const m = { x: 0, y: 0, rot: 0, sx: 1, sy: 1, headRot: 0, headX: 0, headY: 0, handRot: 0, handY: 0, wave: false, show: st.visible };
  if (S.idle) {
    const b = Math.sin(2 * Math.PI * tIdle / 3.4);
    m.sy *= 1 + 0.008 * b; m.headY += 1.5 * Math.sin(2 * Math.PI * tIdle / 3.4 + 0.6); m.headRot += 0.8 * Math.sin(2 * Math.PI * tIdle / 6.1);
  }
  if (st.loop === 'tremble') { const i = Math.floor(tIdle * 24); m.x += noise(i, 11) * 2.5; m.y += noise(i, 12) * 1.5; }
  for (const a of active) { ACTIONS[a.v].fn(m, a.u, tIdle); if (a.v === 'pop' || a.v === 'out') m.show = true; }
  if (!m.show) return st;

  // 开着麦克风时：录音中或暂停时跟麦克风走；播放已有配音时仍按配音的口型
  const vis = live && Mic.on && (Mic.taking || !App.playing) ? Mic.cur : visemeAt(t);
  m.mouth = st.mouth || vis.label || st.idleMouth;
  if (S.talkBob && !st.mouth && vis.label) { m.headY -= vis.energy * 3; m.headRot += vis.energy * 1.2 * Math.sin(tIdle * 7); }

  const tick = Math.floor(tIdle * Math.max(S.boilFps, 1));
  const pick = arr => (arr.length > 1 && S.boilFps > 0 ? arr[tick % arr.length] : arr[0]);
  const list = [];
  // z：画的先后（默认就是图层序号）；img：换一张图画（电脑的绿幕版）
  const add = (idx, g, z = idx, img = null) => { if (idx != null) list.push({ idx, g, z, img }); };

  const hand = m.wave ? 'finger' : st.hand;
  add(RIG.mirrorHands.includes(hand) ? RIG.body.mirror : pick(RIG.body.normal), 'body');
  add(pick(RIG.neck), 'head');
  const ears = S.earTwitch && st.ears === 'up' && inWindow(EAR_T, tIdle, 0.22) ? 'tilt' : st.ears;
  add(pick(RIG.ears[ears]), 'head');
  add(RIG.head, 'head');
  let eyes = st.eyes;
  if (S.blink && RIG.eyes[eyes].blinks && inWindow(BLINK_T, tIdle, 0.12)) eyes = 'closed';
  add(RIG.eyes[eyes].white, 'head'); add(RIG.lens, 'head'); add(RIG.eyes[eyes].eye, 'head');
  add(pick(RIG.face), 'head'); add(pick(RIG.glasses), 'head');
  add(RIG.mouths[m.mouth], 'head');
  if (RIG.whiskers[st.whiskers]) add(pick(RIG.whiskers[st.whiskers]), 'head');
  if (m.wave) add(RIG.hands.finger[0], 'hand');
  else if (st.hand !== 'none') for (const l of RIG.hands[st.hand]) add(l, 'body');
  if (st.laptop !== 'none') {
    const lp = RIG.laptop;
    add(lp.layer, 'laptop', lp.z, st.laptop === 'green' ? App.laptopGreen : null);
    if (st.laptop === 'final') add(lp.final, 'laptop', lp.z + 0.1);
  }
  list.sort((a, b) => a.z - b.z);

  const [px, py] = RIG.pivots.root, [nx, ny] = RIG.pivots.neck, [wx, wy] = RIG.pivots.wrist;
  const root = new DOMMatrix().translate(S.ax, S.ay).scale(S.scale).translate(m.x, m.y).rotate(m.rot).scale(m.sx, m.sy).translate(-px, -py);
  const G = {
    root, body: root,
    head: root.translate(nx, ny).rotate(m.headRot).translate(m.headX, m.headY).translate(-nx, -ny),
    hand: root.translate(0, m.handY).translate(wx, wy).rotate(m.handRot).translate(-wx, -wy),
    laptop: root.translate(S.lapX, S.lapY).scale(S.lapScale),
  };
  const jit = {};
  for (const [gi, g] of ['root', 'body', 'head', 'hand', 'laptop'].entries()) {
    jit[g] = S.jitter > 0 && S.boilFps > 0 ? G[g].translate(noise(tick * 7 + gi, 3) * S.jitter, noise(tick * 7 + gi, 4) * S.jitter) : G[g];
  }
  ctx.imageSmoothingQuality = 'high';
  for (const it of list) {
    const L = App.layers[it.idx];
    if (!L || !L.canvas) continue;
    ctx.setTransform(jit[it.g]);
    ctx.globalAlpha = L.opacity;
    ctx.drawImage(it.img || L.canvas, L.x, L.y);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  return st;
}

// ---------- 播放 ----------
function clockTime() {
  if (Mic.taking && Mic.ctx) return Mic.ctx.currentTime - Mic.t0;   // 录音时跟麦克风的音频时钟走，关键帧和录音不会漂
  if (App.audioBuf && !audio.paused) return audio.currentTime;
  return App.tStart + (performance.now() - App.wallStart) / 1000;
}
function play() {
  if (App.t >= App.duration - 0.01) App.t = 0;
  App.playing = true; App.wallStart = performance.now(); App.tStart = App.t;
  if (App.audioBuf) { audio.currentTime = App.t; audio.play(); }
  if (refVideo.src) { refVideo.currentTime = App.t; refVideo.play().catch(() => {}); }
  $('#btnPlay').textContent = '⏸';
}
function pause() {
  App.playing = false; audio.pause(); refVideo.pause(); App.pauseWall = performance.now();
  $('#btnPlay').textContent = '▶';
}
function seek(t) {
  App.t = clamp(t, 0, App.duration);
  if (App.playing) { App.wallStart = performance.now(); App.tStart = App.t; if (App.audioBuf) audio.currentTime = App.t; }
  if (refVideo.src) refVideo.currentTime = App.t;
}

function layerBuf(w, h) {
  const c = App.buf || (App.buf = document.createElement('canvas'));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}

let lastUI = 0;
function frame(now) {
  if (App.playing) {
    App.t = clockTime();
    if (App.t >= App.duration) { App.t = App.duration; pause(); }
    if (refVideo.src && Math.abs(refVideo.currentTime - App.t) > 0.15) refVideo.currentTime = App.t;
  }
  if (Mic.on) micTick(now);
  if (App.ready && !App.exporting) {
    readSettings();
    // 先画到缓冲层，再套着滤镜贴到预览上
    const buf = layerBuf(S.outW, S.outH), bctx = buf.getContext('2d');
    bctx.clearRect(0, 0, S.outW, S.outH);
    const tIdle = App.playing ? App.t : App.t + (now - App.pauseWall) / 1000;
    drawAvatar(bctx, App.t, tIdle, true, now);
    const ctx = $('#view').getContext('2d');
    ctx.clearRect(0, 0, S.outW, S.outH);
    ctx.filter = App.compare ? 'none' : Grade.css();
    ctx.drawImage(buf, 0, 0);
    ctx.filter = 'none';
    if (now - (App.histT || 0) > 400) { App.histT = now; CurveEditor.updateHist(buf); }
  }
  drawTimeline();
  $('#timeText').textContent = `${App.t.toFixed(2)} / ${App.duration.toFixed(2)} s`;
  if (now - lastUI > 120) { lastUI = now; updateButtons(); }
  App.live.acts = App.live.acts.filter(a => now - a.start < ACTIONS[a.v].dur * 1000);
  requestAnimationFrame(frame);
}

// ---------- 按键 / 按钮 ----------
const GROUPS = [
  { id: 'g_expr', k: 'expr', items: Object.entries(EXPRESSIONS).map(([v, x]) => ({ v, label: x.label, key: x.key })) },
  { id: 'g_mouth', k: 'mouth', items: [{ v: null, label: '自动', key: '`' }, ...MOUTHS], hold: true },
  { id: 'g_eyes', k: 'eyes', items: EYES },
  { id: 'g_ears', k: 'ears', items: EARS },
  { id: 'g_whiskers', k: 'whiskers', items: WHISKERS },
  { id: 'g_hand', k: 'hand', items: HANDS },
  { id: 'g_laptop', k: 'laptop', items: LAPTOP },
  { id: 'g_act', k: 'act', items: Object.entries(ACTIONS).map(([v, a]) => ({ v, label: a.label, key: a.key })) },
];
const KEYMAP = {};

function trigger(k, v) {
  if (!App.ready) return;
  const cur = stateAt(App.t, true).st;
  if (App.recording) {
    const e = { t: +App.t.toFixed(3), k, v };
    let i = App.events.length; while (i > 0 && App.events[i - 1].t > e.t) i--;
    App.events.splice(i, 0, e); App.history.push(e);
    renderEventList();
  } else {
    if (k === 'act') App.live.acts.push({ v, start: performance.now() });
    if (k !== 'act' || v === 'pop' || v === 'out') App.live.over.push([k, v]);
    if (App.live.over.length > 200) App.live.over.splice(0, 100);
    $('#liveBadge').hidden = !App.live.over.length;
  }
  if (k === 'act') flash(v);
}
function flash(v) {
  const b = document.querySelector(`#g_act button[data-v="${v}"]`);
  if (b) { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 250); }
}

function buildButtons() {
  for (const g of GROUPS) {
    const box = $('#' + g.id);
    for (const it of g.items) {
      const b = document.createElement('button');
      b.dataset.v = it.v === null ? '' : it.v;
      b.innerHTML = it.label + (it.key ? `<kbd>${it.key}</kbd>` : '');
      b.onclick = () => {
        if (g.k === 'mouth' && it.v !== null) {
          const cur = stateAt(App.t, true).st.mouth;
          trigger('mouth', cur === it.v ? null : it.v);
        } else trigger(g.k, it.v);
      };
      box.appendChild(b);
      if (it.key) KEYMAP[it.key] = { k: g.k, v: it.v, hold: g.hold && it.v !== null };
    }
  }
}
function updateButtons() {
  if (!App.ready) return;
  const st = stateAt(App.t, true).st;
  const cur = { expr: st.expr, mouth: st.mouth === null ? '' : st.mouth, eyes: st.eyes, ears: st.ears, whiskers: st.whiskers, hand: st.hand, laptop: st.laptop };
  for (const g of GROUPS) {
    for (const b of document.querySelectorAll(`#${g.id} button`)) {
      let on;
      if (g.k === 'act') continue;
      else on = cur[g.k] === b.dataset.v;
      b.classList.toggle('on', !!on);
    }
  }
}

const held = new Set();
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); App.playing ? pause() : play(); return; }
  if (e.key === 'Enter') { e.preventDefault(); $('#chkRec').checked = !$('#chkRec').checked; App.recording = $('#chkRec').checked; return; }
  if (e.key.toLowerCase() === 'm' && !e.repeat) { e.preventDefault(); Mic.on ? micStop() : micStart(); return; }
  if (e.key === '\\') { e.preventDefault(); setCompare(true); return; }
  const m = KEYMAP[e.key.toLowerCase()];
  if (!m || e.repeat) return;
  e.preventDefault();
  if (m.hold) { held.add(e.key.toLowerCase()); trigger('mouth', m.v); }
  else trigger(m.k, m.v);
});
document.addEventListener('keyup', e => {
  if (e.key === '\\') setCompare(false);
  const key = e.key.toLowerCase();
  if (held.has(key)) { held.delete(key); trigger('mouth', null); }
});

// ---------- 时间轴 ----------
const EV_ROW = { expr: 0, mouth: 1, eyes: 2, ears: 2, whiskers: 2, hand: 3, laptop: 3, final: 3, body: 3, act: 4 };
function evLabel(e) {
  const find = (arr, v) => (arr.find(x => x.v === v) || {}).label || v;
  switch (e.k) {
    case 'expr': return EXPRESSIONS[e.v]?.label || e.v;
    case 'mouth': return e.v === null ? '嘴:自动' : '嘴:' + find(MOUTHS, e.v);
    case 'eyes': return '眼:' + find(EYES, e.v);
    case 'ears': return '耳:' + find(EARS, e.v);
    case 'whiskers': return '胡子:' + find(WHISKERS, e.v);
    case 'hand': return '手:' + find(HANDS, e.v);
    case 'final': return 'FINAL ' + (e.v ? '开' : '关');
    case 'body': return '身体(旧，已忽略)';
    case 'laptop': return '电脑:' + find(LAPTOP, e.v);
    case 'act': return ACTIONS[e.v]?.label || e.v;
  }
  return e.k;
}
function drawTimeline() {
  const cv = $('#timeline'), dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const span = Math.min(+$('#inSpan').value, App.duration);
  if (App.t < App.view0 || App.t > App.view0 + span * 0.85) App.view0 = clamp(App.t - span * 0.2, 0, Math.max(0, App.duration - span));
  if (App.view0 + span > App.duration) App.view0 = Math.max(0, App.duration - span);
  const t0 = App.view0, X = t => (t - t0) / span * W;
  App.tlView = { t0, span, W };

  ctx.font = '10px sans-serif'; ctx.fillStyle = '#666'; ctx.strokeStyle = '#2b2f36';
  const step = span > 40 ? 5 : span > 12 ? 1 : 0.5;
  for (let s = Math.ceil(t0 / step) * step; s <= t0 + span; s += step) { const x = X(s); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.fillText(s.toFixed(step < 1 ? 1 : 0), x + 2, 10); }

  const V = App.visemes;
  if (V) {
    const i0 = Math.max(0, Math.floor(t0 * V.fps)), i1 = Math.min(V.labels.length, Math.ceil((t0 + span) * V.fps));
    ctx.fillStyle = '#3a4250';
    for (let i = i0; i < i1; i++) { const h = V.energy[i] * 16; ctx.fillRect(X(i / V.fps), 30 - h, Math.max(1, W / span / V.fps), h * 2); }
    let i = i0;
    while (i < i1) {
      let j = i; while (j < i1 && V.labels[j] === V.labels[i]) j++;
      const l = V.labels[i];
      if (l) { const x = X(i / V.fps), w = X(j / V.fps) - x; ctx.fillStyle = VISEME_COLORS[l]; ctx.fillRect(x, 48, w, 14); if (w > 12) { ctx.fillStyle = '#111'; ctx.fillText(l, x + 2, 59); } }
      i = j;
    }
  } else { ctx.fillStyle = '#555'; ctx.fillText('（没有配音：载入音频后这里显示自动口型）', 6, 40); }

  for (const e of App.events) {
    if (e.t < t0 - 2 || e.t > t0 + span) continue;
    const x = X(e.t), y = 66 + (EV_ROW[e.k] || 0) * 9;
    ctx.fillStyle = e.k === 'act' ? '#e8463a' : e.k === 'mouth' ? '#e9c13b' : '#5fb39a';
    ctx.fillRect(x, y, 2, 8); ctx.fillText(evLabel(e), x + 3, y + 8);
  }
  ctx.fillStyle = '#ff5a4e'; ctx.fillRect(X(App.t) - 1, 0, 2, H);
}
let tlDrag = false;
const tlSeek = e => { const r = $('#timeline').getBoundingClientRect(), v = App.tlView; if (v) seek(v.t0 + (e.clientX - r.left) / v.W * v.span); };
$('#timeline').addEventListener('pointerdown', e => { tlDrag = true; tlSeek(e); });
window.addEventListener('pointermove', e => { if (tlDrag) tlSeek(e); });
window.addEventListener('pointerup', () => { tlDrag = false; });

// ---------- 关键帧列表 ----------
function renderEventList() {
  const box = $('#evList');
  if (!App.events.length) { box.textContent = '还没有关键帧。勾上「录制按键」后播放并按按钮，或者暂停在某个时间点再按。'; return; }
  const tb = document.createElement('table');
  App.events.forEach((e, i) => {
    const tr = tb.insertRow();
    const ti = document.createElement('input'); ti.type = 'number'; ti.step = '0.01'; ti.value = e.t;
    ti.onchange = () => { e.t = Math.max(0, +ti.value); App.events.sort((a, b) => a.t - b.t); renderEventList(); };
    tr.insertCell().appendChild(ti);
    tr.insertCell().textContent = evLabel(e);
    const go = document.createElement('button'); go.textContent = '跳到'; go.onclick = () => seek(e.t);
    const del = document.createElement('button'); del.textContent = '✕'; del.onclick = () => { App.events.splice(i, 1); renderEventList(); };
    const c = tr.insertCell(); c.append(go, del);
  });
  box.replaceChildren(tb);
}

// ---------- 素材加载 ----------
// 电脑屏幕的绿幕版：从 screenAt 往外找连在一起的白色像素，换成纯绿 #00ff00；
// 屏幕边上 2 像素按亮度把白的那部分换成绿，保留抗锯齿，抠像时边缘不发白
function makeGreenScreen(L) {
  if (!L || !L.canvas) return null;
  const w = L.w, h = L.h, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(L.canvas, 0, 0);
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const lum = q => 0.299 * d[q * 4] + 0.587 * d[q * 4 + 1] + 0.114 * d[q * 4 + 2];
  const sx = RIG.laptop.screenAt[0] - L.x, sy = RIG.laptop.screenAt[1] - L.y, s0 = sy * w + sx;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || lum(s0) < 200) { console.warn('rig.laptop.screenAt 不在白色屏幕上'); return null; }
  const mask = new Uint8Array(w * h), st = [s0]; mask[s0] = 1;
  while (st.length) {
    const q = st.pop(), x = q % w, y = (q / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const r = yy * w + xx;
      if (!mask[r] && d[r * 4 + 3] > 200 && lum(r) > 200) { mask[r] = 1; st.push(r); }
    }
  }
  const G = [0, 255, 0], W = 250, B = 40;
  for (let pass = 2; pass <= 3; pass++) {   // 往外扩两圈，标成 2、3
    for (let q = 0; q < w * h; q++) {
      if (mask[q]) continue;
      const x = q % w, y = (q / w) | 0;
      if ((x > 0 && mask[q - 1] === pass - 1) || (x < w - 1 && mask[q + 1] === pass - 1) || (y > 0 && mask[q - w] === pass - 1) || (y < h - 1 && mask[q + w] === pass - 1)) mask[q] = pass;
    }
  }
  for (let q = 0; q < w * h; q++) {
    if (!mask[q]) continue;
    const t = mask[q] === 1 ? 1 : Math.min(1, Math.max(0, (lum(q) - B) / (W - B)));
    for (let k = 0; k < 3; k++) d[q * 4 + k] = Math.round(Math.min(255, Math.max(0, mask[q] === 1 ? G[k] : d[q * 4 + k] + t * (G[k] - W))));
  }
  g.putImageData(img, 0, 0);
  return c;
}

async function loadPSD(buf, name) {
  status('正在读取 PSD…');
  try {
    const psd = await readPSD(buf);
    for (const [i, rects] of Object.entries(RIG.erase || {})) {
      const L = psd.layers[i]; if (!L || !L.canvas) continue;
      const c = L.canvas.getContext('2d');
      for (const [x, y, w, h] of rects) c.clearRect(x - L.x, y - L.y, w, h);
    }
    App.laptopGreen = makeGreenScreen(psd.layers[RIG.laptop.layer]);
    App.layers = psd.layers; App.ready = true;
    $('#psdInfo').textContent = `${name}：${psd.width}×${psd.height}，${psd.layers.length} 条图层记录`;
    buildLayerList();
    if (psd.layers.length !== RIG.expectedRecords) status(`PSD 有 ${psd.layers.length} 条图层记录，rig.js 按 ${RIG.expectedRecords} 条写的：图层顺序可能变了，请到「图层检查」核对`, true);
    else status('PSD 已载入。按按钮或键盘试试；勾「录制按键」后按键会记进时间轴。');
  } catch (err) { status('PSD 读取失败：' + err.message, true); console.error(err); }
}
// isTake：麦克风录的一段（可以保存、导出时一起写出 wav）
async function loadAudio(file, isTake = false) {
  status('正在解码音频…');
  try {
    const ac = new AudioContext();
    const ab = await ac.decodeAudioData(await file.arrayBuffer());
    ac.close();
    App.raw = { ab, blob: file, name: file.name, isTake };
    App.denoised = false;
    if (isTake && $('#chkNrTake').checked) await applyDenoise();
    else await setVoice(ab, file, file.name, isTake);
  } catch (err) { status('音频读取失败：' + err.message, true); console.error(err); }
}
async function setVoice(ab, blob, name, saveable) {
  App.audioBuf = ab; App.audioName = name; App.duration = ab.duration;
  App.voiceWav = saveable ? { blob, name } : null;
  if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
  audio.src = URL.createObjectURL(blob);
  $('#audioInfo').textContent = `${name}（${ab.duration.toFixed(2)}s）`;
  $('#btnSaveTake').hidden = !saveable;
  $('#btnDenoise').textContent = App.denoised ? '还原原声' : '降噪当前配音';
  await analyze();
}
async function applyDenoise() {
  const r = App.raw; if (!r) return;
  const ab = await denoiseBuffer(r.ab, { reduceDb: +$('#inNrVoice').value, onProgress: p => status(`正在给配音降噪… ${Math.round(p * 100)}%`) });
  App.denoised = true;
  await setVoice(ab, encodeWAV(ab), r.name.replace(/\.[^.]+$/, '') + '_降噪.wav', true);
}
const lipOpts = () => ({ mode: $('#selLip').value, sens: +$('#inSens').value, nr: $('#chkNrLip').checked ? +$('#inNr').value : 0, stable: +$('#inStable').value });
async function analyze() {
  if (!App.audioBuf) { status('先载入配音音频', true); return; }
  status('正在分析口型…');
  const t = performance.now();
  App.visemes = await LipSync.analyze(App.audioBuf, lipOpts());
  const counts = {}; for (const l of App.visemes.labels) counts[l || '静音'] = (counts[l || '静音'] || 0) + 1;
  const pct = Object.entries(counts).map(([k, n]) => `${k} ${Math.round(n / App.visemes.labels.length * 100)}%`).join('　');
  status(`口型分析完成（${((performance.now() - t) / 1000).toFixed(1)}s）：${pct}`);
}
function buildLayerList() {
  const role = {};
  const put = (idx, r) => { if (idx != null) (role[idx] = role[idx] || []).push(r); };
  put(RIG.head, '头底色'); put(RIG.lens, '镜片白底'); put(RIG.laptop.layer, '电脑'); put(RIG.laptop.final, '电脑屏幕:FINAL 字'); put(RIG.body.mirror, '身体镜像版(期待手)');
  RIG.body.normal.forEach(i => put(i, '身体(抖动)')); RIG.neck.forEach(i => put(i, '下巴毛(抖动)'));
  RIG.face.forEach(i => put(i, '脸线稿(抖动)')); RIG.glasses.forEach(i => put(i, '眼镜线稿(抖动)'));
  for (const [k, a] of Object.entries(RIG.ears)) a.forEach(i => put(i, '耳朵:' + (EARS.find(e => e.v === k) || {}).label));
  for (const [k, e] of Object.entries(RIG.eyes)) { put(e.eye, '眼睛:' + e.label); put(e.white, '眼底:' + e.label); }
  for (const [k, i] of Object.entries(RIG.mouths)) put(i, '嘴:' + (MOUTHS.find(m => m.v === k) || {}).label);
  for (const [k, a] of Object.entries(RIG.whiskers)) a.forEach(i => put(i, '胡子:' + (WHISKERS.find(f => f.v === k) || {}).label + (a.length > 1 ? '(抖动)' : '')));
  for (const [k, a] of Object.entries(RIG.hands)) a.forEach(i => put(i, '手势:' + (HANDS.find(h => h.v === k) || {}).label));
  const box = $('#layerList'); box.replaceChildren();
  for (let i = App.layers.length - 1; i >= 0; i--) {
    const L = App.layers[i];
    if (L.section === 3) continue;
    const row = document.createElement('div'); row.className = 'ly';
    const th = document.createElement('canvas'); th.width = 80; th.height = 80;
    if (L.canvas) { const s = Math.min(80 / L.w, 80 / L.h); th.getContext('2d').drawImage(L.canvas, (80 - L.w * s) / 2, (80 - L.h * s) / 2, L.w * s, L.h * s); }
    const txt = document.createElement('span');
    const r = role[i] ? role[i].join('、') : (L.isGroup ? '（组）' : (L.canvas ? '<未使用>' : '（空）'));
    txt.innerHTML = `<b>${i}</b> ${L.name}${L.group ? ' / ' + L.group : ''}　<span class="${role[i] || L.isGroup ? '' : 'warn'}">${r}</span>`;
    row.append(th, txt); box.appendChild(row);
  }
}

// ---------- 工程 ----------
function projectJSON() {
  return JSON.stringify({
    app: 'avatar_generator', version: 1, audio: App.audioName, duration: App.duration,
    settings: { ...S }, grade: Grade.toJSON(), events: App.events, visemes: App.visemes ? LipSync.encode(App.visemes) : null,
  }, null, 1);
}
function loadProject(o) {
  if (o.settings) writeSettings(o.settings);
  if (o.grade) Grade.load(o.grade);
  App.events = (o.events || []).slice().sort((a, b) => a.t - b.t);
  if (o.visemes) App.visemes = LipSync.decode(o.visemes);
  if (!App.audioBuf && o.duration) App.duration = o.duration;
  renderEventList();
  status(`工程已载入：${App.events.length} 个关键帧` + (o.audio && o.audio !== App.audioName ? `。记得载入配音 ${o.audio} 听效果` : ''));
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

// ---------- 导出 ----------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d) { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
class ZipWriter {   // 只存储不压缩（PNG 本身已压缩）
  constructor() { this.parts = []; this.central = []; this.off = 0; this.n = 0; }
  add(name, data) {
    const nm = new TextEncoder().encode(name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, this.off, true);
    this.parts.push(h, nm, data); this.central.push(c, nm);
    this.off += 30 + nm.length + data.length; this.n++;
  }
  blob() {
    const size = this.central.reduce((s, x) => s + x.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.n, true); e.setUint16(10, this.n, true); e.setUint32(12, size, true); e.setUint32(16, this.off, true);
    return new Blob([...this.parts, ...this.central, e], { type: 'application/zip' });
  }
}
function movScript(fps) {
  return `@echo off\r\ncd /d "%~dp0"\r\nrem 把 PNG 序列转成带透明通道的 ProRes 4444，达芬奇直接拖进去就能叠在视频上\r\nffmpeg -y -framerate ${fps} -i avatar_%%05d.png -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -vendor apl0 avatar_prores4444.mov\r\npause\r\n`;
}
async function exportFrames() {
  if (!App.ready) return;
  readSettings();
  const fps = S.fps, t0 = Math.max(0, +$('#exStart').value || 0);
  const t1 = $('#exEnd').value === '' ? App.duration : Math.min(App.duration, +$('#exEnd').value);
  const n = Math.max(1, Math.round((t1 - t0) * fps));
  let dir = null, zip = null;
  if (window.showDirectoryPicker) {
    try { dir = await window.showDirectoryPicker({ id: 'avatar-export', mode: 'readwrite' }); } catch { return; }
  } else zip = new ZipWriter();
  pause();
  App.exporting = true; App.cancel = false; $('#btnCancel').hidden = false; $('#btnExport').disabled = true;
  const cv = document.createElement('canvas'); cv.width = S.outW; cv.height = S.outH;
  const ctx = cv.getContext('2d'), bg = $('#exBg').value;
  const lay = document.createElement('canvas'); lay.width = S.outW; lay.height = S.outH;
  const lctx = lay.getContext('2d'), gradeCss = $('#chkGradeExport').checked ? Grade.css() : 'none';
  const write = async (name, data) => {
    if (dir) { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(data); await w.close(); }
    else zip.add(name, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new TextEncoder().encode(data));
  };
  const started = performance.now();
  try {
    let i = 0;
    for (; i < n && !App.cancel; i++) {
      const t = t0 + i / fps;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
      if (bg !== 'transparent') { ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height); }
      lctx.clearRect(0, 0, lay.width, lay.height);
      drawAvatar(lctx, t, t, false, 0);
      ctx.filter = gradeCss; ctx.drawImage(lay, 0, 0); ctx.filter = 'none';
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      await write(`avatar_${String(i).padStart(5, '0')}.png`, blob);
      if (i % 10 === 0) { $('#exProg').textContent = `${i + 1} / ${n} 帧`; await new Promise(r => setTimeout(r)); }
    }
    await write('project.json', projectJSON());
    if (App.voiceWav && App.audioName === App.voiceWav.name) await write(App.voiceWav.name, App.voiceWav.blob);
    await write('转MOV_ProRes4444.cmd', movScript(fps));
    if (zip) download(zip.blob(), 'avatar_png_sequence.zip');
    const sec = ((performance.now() - started) / 1000).toFixed(1);
    $('#exProg').textContent = App.cancel ? `已取消（写了 ${i} 帧）` : `完成：${n} 帧，${sec}s`;
    status(App.cancel ? '导出已取消' : `导出完成：${n} 帧 ${S.outW}×${S.outH} @${fps}fps，从 ${t0.toFixed(2)}s 开始。文件夹里的「转MOV_ProRes4444.cmd」可以转成带透明的 MOV。`);
  } catch (err) { status('导出失败：' + err.message, true); console.error(err); }
  App.exporting = false; $('#btnCancel').hidden = true; $('#btnExport').disabled = false;
}

// ---------- 实时麦克风 ----------
const Mic = { on: false, taking: false, ctx: null, stream: null, an: null, buf: null, x: null, dec: 1, sr: 11025, live: null, last: 0, rec: null, chunks: [], keepRec: false, cur: { label: null, energy: 0, db: -100 } };

async function micStart() {
  if (!navigator.mediaDevices?.getUserMedia) { status('这个页面拿不到麦克风：请用 serve.ps1 开的 http://localhost:8765/ 打开', true); return false; }
  const dev = $('#selMicDev').value;
  try {
    Mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev ? { exact: dev } : undefined, echoCancellation: false, autoGainControl: false, noiseSuppression: true } });
  } catch (err) { status('打不开麦克风：' + err.message + '。请在地址栏左边的权限里允许麦克风', true); return false; }
  // 尽量直接用 11025Hz 的音频上下文，和离线分析同一个采样率；不支持就自己降采样
  let src;
  try { Mic.ctx = new AudioContext({ sampleRate: 11025 }); src = Mic.ctx.createMediaStreamSource(Mic.stream); }
  catch { if (Mic.ctx) Mic.ctx.close(); Mic.ctx = new AudioContext(); src = Mic.ctx.createMediaStreamSource(Mic.stream); }
  Mic.dec = Math.max(1, Math.round(Mic.ctx.sampleRate / 11025));
  Mic.sr = Mic.ctx.sampleRate / Mic.dec;
  Mic.an = Mic.ctx.createAnalyser();
  Mic.an.fftSize = 2 ** Math.ceil(Math.log2(400 * Mic.dec));
  Mic.buf = new Float32Array(Mic.an.fftSize);
  Mic.x = new Float32Array(Math.floor(Mic.an.fftSize / Mic.dec));
  src.connect(Mic.an);
  await Mic.ctx.resume();
  Mic.live = new LiveLipSync(); Mic.on = true; Mic.last = performance.now();
  await fillMicDevices();
  $('#btnMic').textContent = '🎙 关麦克风'; $('#btnMic').classList.add('on');
  status('麦克风已打开，说话时嘴型会实时跟着动。开头几秒在适应你的音量和声音，说几句就准了。');
  return true;
}
function micStop() {
  if (Mic.taking) takeStop();
  if (Mic.stream) Mic.stream.getTracks().forEach(t => t.stop());
  if (Mic.ctx) Mic.ctx.close();
  Object.assign(Mic, { on: false, stream: null, ctx: null, an: null, cur: { label: null, energy: 0, db: -100 } });
  $('#btnMic').textContent = '🎙 开麦克风'; $('#btnMic').classList.remove('on');
  $('#micBar i').style.width = '0'; $('#micInfo').textContent = '';
}
async function fillMicDevices() {
  const sel = $('#selMicDev');
  const cur = (Mic.stream && Mic.stream.getAudioTracks()[0].getSettings().deviceId) || sel.value;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  if (!devs.length) return;
  sel.replaceChildren(...devs.map(d => new Option(d.label || '麦克风 ' + d.deviceId.slice(0, 6), d.deviceId)));
  if (devs.some(d => d.deviceId === cur)) sel.value = cur;
}
function micTick(now) {
  const dt = Math.min(0.1, (now - Mic.last) / 1000); Mic.last = now;
  if (!Mic.an || dt <= 0) return;
  Mic.an.getFloatTimeDomainData(Mic.buf);
  let x = Mic.buf;
  if (Mic.dec > 1) {
    for (let i = 0; i < Mic.x.length; i++) { let s = 0; for (let k = 0; k < Mic.dec; k++) s += Mic.buf[i * Mic.dec + k]; Mic.x[i] = s / Mic.dec; }
    x = Mic.x;
  }
  Mic.cur = Mic.live.step(x, Mic.sr, dt, lipOpts());
  const bar = $('#micBar i');
  bar.style.width = Math.round(Mic.cur.energy * 100) + '%';
  bar.style.background = Mic.cur.label ? VISEME_COLORS[Mic.cur.label] : '#555';
  if (now - (Mic.infoT || 0) > 150) {   // 文字刷新慢一点，不然看不清
    Mic.infoT = now;
    $('#micInfo').textContent = Mic.cur.warming ? '估噪中，先别说话' : `${Mic.cur.label || '—'}　信噪比 ${Mic.cur.snr.toFixed(0)} dB`;
  }
}

// 录一段：时间轴从 0 开始走，按键自动记成关键帧；停下后录音自动当成配音，重新做一遍完整的口型分析
async function takeStart() {
  if (!Mic.on && !(await micStart())) return;
  if (typeof MediaRecorder === 'undefined') { status('这个浏览器不支持录音，请用 Edge 或 Chrome', true); return; }
  if (App.events.length && confirm('新录一段：要清空现有的关键帧吗？\n（取消 = 保留）')) { App.events = []; App.history = []; renderEventList(); }
  pause();
  audio.removeAttribute('src'); audio.load();
  Object.assign(App, { audioBuf: null, visemes: null, audioName: '', voiceWav: null, raw: null, denoised: false });
  $('#audioInfo').textContent = '录音中…'; $('#btnSaveTake').hidden = true;
  Mic.keepRec = App.recording;
  App.recording = true; $('#chkRec').checked = true;
  Mic.chunks = [];
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m));
  Mic.rec = new MediaRecorder(Mic.stream, mime ? { mimeType: mime } : undefined);
  Mic.rec.ondataavailable = e => { if (e.data.size) Mic.chunks.push(e.data); };
  Mic.rec.onstart = () => { App.t = 0; App.duration = 3600; Mic.t0 = Mic.ctx.currentTime; Mic.taking = true; play(); updateTakeUI(); };
  Mic.rec.onstop = takeFinish;
  Mic.rec.start(250);
}
function takeStop() {
  Mic.taking = false; pause();
  App.recording = Mic.keepRec; $('#chkRec').checked = Mic.keepRec;
  if (Mic.rec && Mic.rec.state !== 'inactive') Mic.rec.stop();
  updateTakeUI();
}
async function takeFinish() {
  status('正在处理录音…');
  try {
    const blob = new Blob(Mic.chunks, { type: Mic.rec.mimeType });
    const ac = new AudioContext();
    const ab = await ac.decodeAudioData(await blob.arrayBuffer());
    ac.close();
    const name = `mic_take_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.wav`;
    await loadAudio(new File([encodeWAV(ab)], name, { type: 'audio/wav' }), true);
    seek(0);
  } catch (err) { status('录音处理失败：' + err.message, true); console.error(err); App.duration = Math.max(1, +$('#inDur').value); }
}
function updateTakeUI() {
  $('#btnTake').textContent = Mic.taking ? '■ 停止录音' : '● 录一段';
  $('#btnTake').classList.toggle('flash', Mic.taking);
  $('#takeBadge').hidden = !Mic.taking;
}
function encodeWAV(ab) {   // 混成单声道 16 位 PCM
  const ch = ab.numberOfChannels, n = ab.length, sr = ab.sampleRate;
  const dv = new DataView(new ArrayBuffer(44 + n * 2));
  const tag = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, n * 2, true);
  const data = Array.from({ length: ch }, (_, c) => ab.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let s = 0; for (const d of data) s += d[i];
    s = clamp(s / ch, -1, 1);
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([dv], { type: 'audio/wav' });
}

// ---------- 滤镜 / 曲线 ----------
function setCompare(on) { App.compare = on; applyVideoGrade(); $('#btnCompare').classList.toggle('on', on); }
function applyVideoGrade() { refVideo.style.filter = $('#chkGradeVideo').checked && !App.compare ? Grade.css() : 'none'; }
function bindGrade() {
  const fbox = $('#g_filter');
  for (const [v, f] of Object.entries(FILTERS)) {
    const b = document.createElement('button'); b.dataset.v = v; b.textContent = f.label;
    b.onclick = () => { Grade.filter = v; Grade.update(); };
    fbox.appendChild(b);
  }
  const tabs = $('#curveTabs');
  for (const c of CURVE_CH) {
    const b = document.createElement('button'); b.dataset.v = c.v; b.textContent = c.label; b.style.borderBottom = `2px solid ${c.color}`;
    b.onclick = () => { CurveEditor.ch = c.v; CurveEditor.hover = -1; Grade.onChange(); if (App.buf) CurveEditor.updateHist(App.buf); };
    tabs.appendChild(b);
  }
  $('#inFilterAmt').oninput = e => { Grade.amount = +e.target.value / 100; Grade.update(); };
  $('#btnCurveReset').onclick = () => { Grade.resetCurves(CurveEditor.ch); Grade.update(); };
  $('#btnCurveResetAll').onclick = () => { Grade.resetCurves(); Grade.update(); };
  $('#btnCompare').onpointerdown = () => setCompare(true);
  for (const ev of ['pointerup', 'pointerleave']) $('#btnCompare').addEventListener(ev, () => { if (App.compare) setCompare(false); });
  $('#chkGradeVideo').onchange = applyVideoGrade;
  Grade.onChange = () => {
    for (const b of fbox.children) b.classList.toggle('on', b.dataset.v === Grade.filter);
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.v === CurveEditor.ch);
    $('#inFilterAmt').value = Math.round(Grade.amount * 100);
    $('#filterAmtTxt').textContent = Math.round(Grade.amount * 100) + '%';
    applyVideoGrade();
    CurveEditor.draw();
  };
  CurveEditor.init($('#curveCanvas'));
  Grade.update();
}

// ---------- 界面绑定 ----------
// 右侧选项卡：记住上次打开的那个；Alt+1–5 切换
function showTab(name) {
  if (!$('#tab-' + name)) name = 'pose';
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const t of document.querySelectorAll('#panel .tab')) t.classList.toggle('on', t.id === 'tab-' + name);
  try { localStorage.setItem('avatarTab', name); } catch {}
}
function bindTabs() {
  const btns = [...document.querySelectorAll('#tabs button')];
  btns.forEach((b, i) => { b.innerHTML += `<kbd>Alt+${i + 1}</kbd>`; b.onclick = () => showTab(b.dataset.tab); });
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const i = '12345'.indexOf(e.key);
    if (i >= 0 && btns[i]) { e.preventDefault(); showTab(btns[i].dataset.tab); }
  });
  let last = null; try { last = localStorage.getItem('avatarTab'); } catch {}
  showTab(last || 'pose');
}

function bindUI() {
  bindTabs(); buildButtons(); renderEventList(); bindGrade();
  $('#btnPlay').onclick = () => (App.playing ? pause() : play());
  $('#btnStart').onclick = () => seek(0);
  $('#chkRec').onchange = e => { App.recording = e.target.checked; };
  $('#inDur').onchange = e => { if (!App.audioBuf) App.duration = Math.max(1, +e.target.value); };
  $('#liveClear').onclick = () => { App.live.over = []; App.live.acts = []; $('#liveBadge').hidden = true; };
  $('#btnUndo').onclick = () => { const e = App.history.pop(); const i = App.events.indexOf(e); if (i >= 0) App.events.splice(i, 1); renderEventList(); };
  $('#btnClearEv').onclick = () => { if (confirm('清空全部关键帧？')) { App.events = []; App.history = []; renderEventList(); } };
  $('#btnSaveProj').onclick = () => download(new Blob([projectJSON()], { type: 'application/json' }), 'avatar_project.json');
  $('#fileProj').onchange = async e => { const f = e.target.files[0]; if (f) loadProject(JSON.parse(await f.text())); };
  $('#filePSD').onchange = async e => { const f = e.target.files[0]; if (f) loadPSD(await f.arrayBuffer(), f.name); };
  $('#fileAudio').onchange = e => { const f = e.target.files[0]; if (f) loadAudio(f); };
  $('#fileVideo').onchange = e => { const f = e.target.files[0]; if (f) { refVideo.src = URL.createObjectURL(f); refVideo.currentTime = App.t; $('#selBg').value = 'video'; $('#selBg').onchange(); } };
  $('#btnAnalyze').onclick = analyze;
  $('#selBg').onchange = () => { $('#stageBox').className = 'bg-' + $('#selBg').value; };
  $('#btnExport').onclick = exportFrames;
  $('#btnCancel').onclick = () => { App.cancel = true; };
  $('#btnMic').onclick = () => (Mic.on ? micStop() : micStart());
  $('#btnTake').onclick = () => (Mic.taking ? takeStop() : takeStart());
  $('#btnSaveTake').onclick = () => { if (App.voiceWav) download(App.voiceWav.blob, App.voiceWav.name); };
  $('#btnDenoise').onclick = async () => {
    if (!App.raw || Mic.taking) { if (!App.raw) status('先载入配音或录一段', true); return; }
    if (App.denoised) { App.denoised = false; await setVoice(App.raw.ab, App.raw.blob, App.raw.name, App.raw.isTake); }
    else await applyDenoise();
  };
  // 改了口型参数，已有配音就自动重新分析
  let reTimer = 0;
  for (const id of ['#selLip', '#inSens', '#chkNrLip', '#inNr', '#inStable']) {
    $(id).addEventListener('change', () => { clearTimeout(reTimer); reTimer = setTimeout(() => { if (App.audioBuf && !Mic.taking) analyze(); }, 150); });
  }
  $('#selMicDev').onchange = async () => { if (Mic.taking) return; if (Mic.on) { micStop(); await micStart(); } };
  const box = $('#app');
  box.addEventListener('dragover', e => e.preventDefault());
  box.addEventListener('drop', async e => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) {
      const n = f.name.toLowerCase();
      if (n.endsWith('.psd')) loadPSD(await f.arrayBuffer(), f.name);
      else if (n.endsWith('.json')) loadProject(JSON.parse(await f.text()));
      else if (f.type.startsWith('audio') || /\.(wav|mp3|m4a|aac|flac|ogg)$/.test(n)) loadAudio(f);
      else if (f.type.startsWith('video')) { refVideo.src = URL.createObjectURL(f); $('#selBg').value = 'video'; $('#selBg').onchange(); }
    }
  });
}

(async function init() {
  readSettings(); bindUI();
  requestAnimationFrame(frame);
  if (location.protocol.startsWith('http')) {
    try {
      const r = await fetch('../vtuber_art.psd');
      if (r.ok) { await loadPSD(await r.arrayBuffer(), 'vtuber_art.psd'); return; }
    } catch {}
  }
  status('请选择或拖入 vtuber_art.psd');
})();
