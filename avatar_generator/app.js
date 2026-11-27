'use strict';
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function mulberry32(a) { return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function schedule(seed, min, max, horizon = 4000) { const r = mulberry32(seed), out = []; let t = min * r(); while (t < horizon) { out.push(t); t += min + (max - min) * r(); } return out; }
function sinceLast(starts, t) { let lo = 0, hi = starts.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k < 0 ? Infinity : t - starts[k]; }
// 随机间隔先按 120 BPM 换算为整拍，再用全局拍钟读取。
const scheduleBeats = (seed, min, max) => schedule(seed, min, max).map(t => Math.round(t * 2));
const BLINK_T = scheduleBeats(7, 2.2, 5.0);
const EAR_T = { L: scheduleBeats(13, 4, 9), R: scheduleBeats(29, 5, 10) };

// ---------- 全局状态 ----------
const App = {
  layers: [], ready: false,
  events: [], history: [],
  // 试看：按键 / 拖骨骼 / 拖缩放框的临时效果，不进导出
  live: { over: [], acts: [], bone: {}, box: {} },
  visemes: null, audioBuf: null, audioName: '',
  duration: 120, t: 0, playing: false, recording: false,
  wallStart: 0, tStart: 0, pauseWall: performance.now(),
  view0: 0, exporting: false, cancel: false,
  tab: 'pose', selBone: 'head', sel: null, frame: null, drag: null, bps: [],
};
const earDefaults = {
  L: { earOffset: 200, earBoneMs: 250, earPoseMs: 250, earOutDeg: 20, earBackDeg: 0 },
  R: { earOffset: 100, earBoneMs: 250, earPoseMs: 250, earOutDeg: 20, earBackDeg: 20 },
};
const S = { earCalibration: structuredClone(earDefaults) };
const SETTING_IDS = ['boilFps', 'jitter', 'idle', 'rhythm', 'rhythmAmount', 'rhythmBpm', 'blink', 'earTwitch', 'talkBob', 'startHidden', 'outW', 'outH', 'scale', 'ax', 'ay', 'fps', 'lapScale', 'lapX', 'lapY'];
function readSettings() {
  for (const k of SETTING_IDS) { const el = $('#s_' + k); S[k] = el.type === 'checkbox' ? el.checked : +el.value; }
  S.rhythmAmount = clamp(S.rhythmAmount, 0, 200);
  S.rhythmBpm = clamp(S.rhythmBpm || 120, 30, 300);
  const view = $('#view');
  if (view.width !== S.outW || view.height !== S.outH) { view.width = S.outW; view.height = S.outH; }
}
function writeSettings(o) {
  for (const k of SETTING_IDS) { if (!(k in o)) continue; const el = $('#s_' + k); if (el.type === 'checkbox') el.checked = !!o[k]; else el.value = o[k]; }
  showEarCalibration();
  readSettings();
}

const audio = $('#audio'), refVideo = $('#refVideo');
const status = (msg, err) => { const el = $('#status'); el.textContent = msg; el.className = err ? 'err' : ''; };
const autoKeyOn = () => $('#chkAutoKey').checked || App.recording;
const curEase = () => $('#selEase').value;

// ---------- 状态计算 ----------
function initialState() {
  return { expr: 'normal', eyes: 'normal', earL: 'up', earR: 'up', idleMouth: 'n', whiskers: 'normal', loop: null,
    hands: { L: null, R: null }, laptop: 'none', wasted: false, wastedT: -1, mouth: null, visible: !S.startHidden };
}
// 打开一个手势：它占用的每一边，原来在那边的手势整个放下（双手手势两边一起放下）
function handOn(hands, id) {
  const G = HANDS[id]; if (!G) return;
  for (const side of G.side) { const cur = hands[side]; if (cur && cur !== id) for (const sd of HANDS[cur].side) if (hands[sd] === cur) hands[sd] = null; }
  for (const side of G.side) hands[side] = id;
}
function handOff(hands, id) { for (const side of ['L', 'R']) if (id === 'all' || hands[side] === id) hands[side] = null; }
const currentEyeId = id => id === 'sparkle' ? 'sparkle2' : id;
function applyEvent(s, k, v, t) {
  if (k === 'expr' || k === 'eyes') v = currentEyeId(v);
  switch (k) {
    case 'expr': {
      const x = EXPRESSIONS[v]; if (!x) return;
      Object.assign(s, { expr: v, eyes: x.eyes, earL: x.ears, earR: x.ears, idleMouth: x.mouth, whiskers: x.whiskers || 'normal', loop: x.loop || null });
      break;
    }
    case 'ears': s.earL = s.earR = v; break;
    case 'act': if (v === 'pop') s.visible = true; if (v === 'out') s.visible = false; break;
    case 'gact': break;
    // 兼容旧工程：「敲电脑」= 展示手 + 白屏；「FINAL 字」开关；旧的身体方向关键帧忽略
    case 'hand': if (v === 'none') handOff(s.hands, 'all'); else if (v === 'laptop') { handOn(s.hands, 'show'); s.laptop = 'white'; } else handOn(s.hands, v); break;
    case 'handOff': handOff(s.hands, v); break;
    case 'final': s.laptop = v ? 'final' : 'none'; break;
    case 'body': break;
    case 'wasted': if (v && !s.wasted) s.wastedT = t; s.wasted = !!v; break;
    default: s[k] = v;
  }
}
function stateAt(t, live) {
  const st = initialState(), acts = [];
  for (const e of App.events) {
    if (e.t > t + 1e-9) break;
    applyEvent(st, e.k, e.v, e.t);
    if (e.k === 'act' || e.k === 'gact') acts.push(e);
  }
  if (live) for (const [k, v] of App.live.over) applyEvent(st, k, v, -1e9);
  return { st, acts };
}
function visemeAt(t) {
  const V = App.visemes; if (!V) return { label: null, energy: 0 };
  const i = Math.floor(t * V.fps);
  return i >= 0 && i < V.labels.length ? { label: V.labels[i], energy: V.energy[i] || 0 } : { label: null, energy: 0 };
}
function beatSeconds() { return 60 / S.rhythmBpm; }
const earCycleMs = ms => Math.max(1, Math.round(ms / 62.5)) * 62.5; // 120 BPM 标尺上的 1/8 拍
function liveMotionAge(action, now) {
  const end = action.timelineStart + (now - action.start) / 1000;
  return SpeedCurve.sample(end).time - SpeedCurve.sample(action.timelineStart).time;
}
function actionSeconds(action) { return action.beats * beatSeconds(); }
function gestureAction(value) {
  return (value === 'heart:beat' ? 'heart:swayHeart' : String(value)).split(':');
}
function actDef(k, v) {
  if (k === 'act') return ACTIONS[v];
  const [, an] = gestureAction(v); return HAND_ANIMS[an];
}
const boneVals = (id, t, live) => (live && App.live.bone[id]) ? { ...BONE_DEF, ...App.live.bone[id] } : Tracks.eval('bone.' + id, t, BONE_DEF);
const boxVals = (id, t, live) => (live && App.live.box[id]) ? { ...BOX_DEF, ...App.live.box[id] } : Tracks.eval('hand.' + id, t, BOX_DEF);

// 这一帧的姿势：程序动作 → 手势动画 → 关键帧轨道
function framePose(t, tIdle, live, now) {
  const { st, acts } = stateAt(t, live);
  const beats = tIdle / beatSeconds();
  const p = newPose(); p.show = st.visible;
  if (S.idle) {
    const b = Math.sin(2 * Math.PI * beats / 7);
    p.body.sy *= 1 + 0.008 * b; p.head.y += 1.5 * Math.sin(2 * Math.PI * beats / 7 + 0.6); p.head.rot += 0.8 * Math.sin(2 * Math.PI * beats / 12);
    p.earL.rot -= 1.2 * Math.sin(2 * Math.PI * beats / 9 + 1); p.earR.rot += 1.2 * Math.sin(2 * Math.PI * beats / 10 + 2);
  }
  if (S.rhythm) {
    const strength = Tracks.eval('rhythm.strength', t, {percent:100}).percent;
    const amount = S.rhythmAmount / 100 * clamp(strength, 0, 100) / 100;
    const beat = 2 * Math.PI * beats;
    p.body.y += 12 * amount * Math.cos(beat);
    p.head.y += 5 * amount * Math.cos(beat - 0.4);
    // 每拍上下弹一次，两拍完成一次左右摇摆。
    p.body.x += 7 * amount * Math.cos(beat / 2);
    p.body.rot += 4 * amount * Math.cos(beat / 2);
  }
  if (st.loop === 'tremble') { const i = Math.floor(beats * 12); p.body.x += noise(i, 11) * 2.5; p.body.y += noise(i, 12) * 1.5; }

  const run = [];
  const motionTime = SpeedCurve.sample(t).time;
  for (const a of acts) {
    const def = actDef(a.k, a.v);
    if (!def) continue;
    const u = (motionTime - SpeedCurve.sample(a.t).time) / actionSeconds(def);
    if (u >= 0 && u < 1) run.push({ k: a.k, v: a.v, u, beat: motionTime / beatSeconds() });
  }
  if (live) for (const la of App.live.acts) { const D = actDef(la.k, la.v); if (!D) continue; const u = liveMotionAge(la, now) / actionSeconds(D); if (u >= 0 && u < 1) run.push({ k: la.k, v: la.v, u, beat: beats }); }
  for (const a of run) if (a.k === 'act') { ACTIONS[a.v].fn(p, a.u, tIdle, a.beat); if (a.v === 'pop' || a.v === 'out') p.show = true; }

  const hands = { ...st.hands };
  if (p.force) for (const [side, id] of Object.entries(p.force)) { const cur = hands[side]; if (cur && cur !== id) for (const sd of HANDS[cur].side) if (hands[sd] === cur) hands[sd] = null; hands[side] = id; }
  const vis = [...new Set([hands.L, hands.R].filter(Boolean))];
  for (const a of run) if (a.k === 'gact') { const [g, an] = gestureAction(a.v); if (vis.includes(g) && HAND_ANIMS[an]) HAND_ANIMS[an].fn(handVals(p, g), p, a.u, tIdle, a.beat); }

  const ears = { L: st.earL, R: st.earR };
  const lab = live && App.tab === 'earLab';
  const labMs = lab ? earLabTime(now) : 0;
  if (S.earTwitch || lab) for (const side of ['L', 'R']) {
    if (run.some(a => a.k === 'act' && (a.v === 'earflick' || a.v === 'ear' + side))) continue;
    const calibration = S.earCalibration[side];
    if (lab) {
      if (side !== $('#earLabSide').value) continue;
      ears[side] = $('#earLabPose').value;
    }
    if (ears[side] === 'back') continue;
    const elapsed = lab ? labMs : 500 * sinceLast(EAR_T[side], beats);
    // 在偏移后的时钟上查触发点，让负偏移也能在换图之前开始摆动。
    const boneMs = lab ? labMs - calibration.earOffset : 500 * sinceLast(EAR_T[side], beats - calibration.earOffset / 500);
    const fold = 0.25, release = 0.6875;
    const posePhase = elapsed / earCycleMs(calibration.earPoseMs);
    if (posePhase >= 0 && posePhase < 1) ears[side] = posePhase >= fold && posePhase < release ? 'back' : 'tilt';
    const phase = boneMs / earCycleMs(calibration.earBoneMs);
    if (phase < 0 || phase >= 1) continue;
    let angle;
    if (phase < fold) angle = calibration.earOutDeg * ease(phase / fold);
    else if (phase < release) angle = calibration.earOutDeg - (calibration.earOutDeg + calibration.earBackDeg) * ease((phase - fold) / (release - fold));
    else angle = -calibration.earBackDeg * (1 - ease((phase - release) / (1 - release)));
    p['ear' + side].rot += side === 'L' ? -angle : angle;
  }

  const vis2 = live && Mic.on && (Mic.taking || !App.playing) ? Mic.cur : visemeAt(t);
  const mouth = st.mouth || vis2.label || st.idleMouth;
  if (S.talkBob && !st.mouth && vis2.label) { p.head.y -= vis2.energy * 3; p.head.rot += vis2.energy * 1.2 * Math.sin(beats * Math.PI); }

  for (const b of BONES) addBoneVals(p[b.id], boneVals(b.id, t, live));
  return { st, p, hands, vis, ears, mouth };
}

// 手的矩阵：父骨骼（身体）× 手势动画（绕手腕）× 缩放框（绕锚点）。nb = 不含缩放框
function boxAnchor(g, anchor) {
  const G = HANDS[g];
  if (anchor !== 'center') return G.pivot;
  const [x, y, w, h] = handRect(g); return [x + w / 2, y + h / 2];
}
// 一个图层（可以带 clip 多边形）的包围盒
function layerRect(layer, clip) {
  const L = App.layers[layer];
  if (!clip) return [L.x, L.y, L.w, L.h];
  const xs = clip.map(p => p[0]), ys = clip.map(p => p[1]);
  const x0 = Math.max(Math.min(...xs), L.x), y0 = Math.max(Math.min(...ys), L.y), x1 = Math.min(Math.max(...xs), L.x + L.w), y1 = Math.min(Math.max(...ys), L.y + L.h);
  return [x0, y0, x1 - x0, y1 - y0];
}
function handRect(g) {
  const G = HANDS[g];
  if (!G.parts) return layerRect(G.layer, G.clip);
  const R = G.parts.map(q => layerRect(q.layer, q.clip));
  const x0 = Math.min(...R.map(r => r[0])), y0 = Math.min(...R.map(r => r[1])), x1 = Math.max(...R.map(r => r[0] + r[2])), y1 = Math.max(...R.map(r => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}
const handLayers = G => (G.parts ? [...new Set(G.parts.map(q => q.layer))] : [G.layer]);
function handMatrix(Wbody, g, h, box) {
  const [px, py] = HANDS[g].pivot, [ax, ay] = boxAnchor(g, box.anchor);
  const nb = Wbody.translate(px + h.dx, py + h.dy).rotate(h.rot).scale(h.sx, h.sy).translate(box.x - px, box.y - py);
  return { nb, M: nb.translate(ax, ay).scale(box.sx, box.sy).translate(-ax, -ay), anchor: [ax, ay] };
}
// 在同一动作时钟上重放手势边沿。这样倒拖时间轴、逐帧导出和实时点击都能得到同样的过渡。
function handTransitions(t, live, now) {
  const duration = beatSeconds() * 0.32;
  const changes = [], hands = {L:null,R:null}, preview = [];
  let waves = 0;
  const end = t;
  function waveLength(start, action) {
    const target = SpeedCurve.sample(start).time + actionSeconds(action);
    let lo = start, hi = start + actionSeconds(action) / MIN_SPEED;
    for (let i=0;i<24;i++) {
      const mid = (lo+hi)/2;
      if (SpeedCurve.sample(mid).time < target) lo=mid; else hi=mid;
    }
    return hi-start;
  }
  for (const e of App.events) {
    if (e.t > t) break;
    if (e.k === 'hand' || e.k === 'handOff' || (e.k === 'act' && ACTIONS[e.v]?.wave)) {
      const at = e.t;
      changes.push({at,k:e.k,v:e.v});
      if (e.k === 'act') changes.push({at:at+waveLength(at,ACTIONS[e.v]),k:'waveEnd'});
    }
  }
  // 试看手势覆盖时间轴上的手势。记录按下的墙钟时间，使暂停时的按钮也有过渡。
  if (live) {
    for (const [k,v,start] of App.live.over) if (k === 'hand' || k === 'handOff') {
      changes.push({at:end-(now-start)/1000,k,v,preview:true});
    }
    for (const a of App.live.acts) if (a.k === 'act' && ACTIONS[a.v]?.wave) {
      const at=end-(now-a.start)/1000;
      changes.push({at,k:'act',v:a.v},{at:at+waveLength(a.timelineStart,ACTIONS[a.v]),k:'waveEnd'});
    }
  }
  changes.sort((a,b)=>a.at-b.at);
  const states = new Map();
  let previous = new Set();
  for (let i=0;i<changes.length;) {
    const at=changes[i].at;
    if (at>end+1e-9) break;
    do {
      const e=changes[i++];
      if (e.k==='act') waves++;
      else if (e.k==='waveEnd') waves--;
      else if (e.preview) preview.push(e);
      else applyHand(hands,e);
    } while(i<changes.length && changes[i].at===at);
    const shown={...hands};
    for(const e of preview) applyHand(shown,e);
    if(waves>0) handOn(shown,'paw');
    const next=new Set([shown.L,shown.R].filter(Boolean));
    for(const g of new Set([...previous,...next])) {
      if(previous.has(g)===next.has(g)) continue;
      const old=states.get(g);
      const from=old?opacity(old,at):0;
      states.set(g,{at,from,to:next.has(g)?1:0});
    }
    previous=next;
  }
  function applyHand(target,e) {
    if (e.k === 'handOff' || e.v === 'none') handOff(target,e.v==='none'?'all':e.v);
    else handOn(target,e.v==='laptop'?'show':e.v);
  }
  function progress(s,time) {
    if (!s.to) return clamp((time-s.at)/0.1,0,1);
    const motionAt = x => x < 0 ? x * SpeedCurve.sample(0).rate : SpeedCurve.sample(x).time;
    return clamp((motionAt(time)-motionAt(s.at))/duration,0,1);
  }
  function opacity(s,time) {
    const u=progress(s,time);
    return s.from+(s.to-s.from)*ease(u);
  }
  const result={};
  for(const [g,s] of states){
    const u=progress(s,end), alpha=opacity(s,end);
    if(alpha<=0&&!s.to) continue;
    const bump=Math.sin(Math.PI*u);
    result[g]={alpha,scale:1-0.045*(1-alpha)+0.035*bump};
  }
  return result;
}
const hashKey = s => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 997; return h; };

// ---------- 绘制 ----------
// t：关键帧时间；tIdle：呼吸/眨眼/抖动用的时间（暂停时也继续走，导出时等于 t）
function drawAvatar(ctx, t, tIdle, live, now) {
  const clock = SpeedCurve.sample(t);
  tIdle = clock.time + (tIdle - t) * clock.rate;
  const F = framePose(t, tIdle, live, now);
  const { st, p } = F;
  const transitions = handTransitions(t, live, now);
  const vis = [...new Set([...F.vis,...Object.keys(transitions)])];
  if (!p.show) { if (live) App.frame = null; return st; }

  const tick = Math.floor(tIdle / beatSeconds() * S.boilFps / 2);
  const pick = arr => (arr.length > 1 && S.boilFps > 0 ? arr[tick % arr.length] : arr[0]);
  const [bx, by] = boneById.body.pivot;
  const root = new DOMMatrix().translate(S.ax, S.ay).scale(S.scale).translate(-bx, -by);
  const W = computeSkeleton(root, p);
  const HM = {}, boxes = {};
  for (const g of vis) { boxes[g] = boxVals(g, t, live); const h = handVals(p,g), scale = transitions[g]?.scale ?? 1; HM[g] = handMatrix(W.body,g,{...h,sx:h.sx*scale,sy:h.sy*scale},boxes[g]); }

  // z：画的先后（默认就是图层序号）；mk：用哪个矩阵；jk：线稿微抖用哪组随机数；clip / inv：只画多边形里面 / 外面
  const list = [];
  const add = (idx, mk, o = {}) => { if (idx != null) list.push({ idx, mk, z: idx, ...o }); };
  const bodyHand = vis.find(g => HANDS[g].isBody);
  if (bodyHand) {
    const G = HANDS[bodyHand];
    add(G.layer, 'body', { clip: G.clip, inv: true });
    add(G.layer, 'hand:' + bodyHand, { clip: G.clip, z: G.layer + 0.01, jk: 'body' });
  } else add(vis.some(g => HANDS[g].body === 'mirror') ? RIG.body.mirror : pick(RIG.body.normal), 'body');
  add(pick(RIG.neck), 'head');
  // 耳朵位于颈毛和头部底色之间；画面右耳始终盖住左耳。
  add(pick(RIG.ears.L[F.ears.L]), 'earL', { z: 10 });
  add(pick(RIG.ears.R[F.ears.R]), 'earR', { z: 11 });
  add(RIG.head, 'head');
  let eyes = st.eyes;
  if (S.blink && RIG.eyes[eyes]?.blinks && sinceLast(BLINK_T, tIdle / beatSeconds()) < 0.25) eyes = 'closed';
  const E = RIG.eyes[eyes] || RIG.eyes.normal;
  add(E.white, 'head'); add(RIG.lens, 'head'); add(pick(E.eye), 'head');
  add(pick(RIG.face), 'head'); add(pick(RIG.glasses), 'head');
  add(RIG.mouths[F.mouth], 'head');
  if (RIG.whiskers[st.whiskers]) add(pick(RIG.whiskers[st.whiskers]), 'head');
  for (const g of vis) {
    if (HANDS[g].isBody) continue;
    if (HANDS[g].parts) { HANDS[g].parts.forEach((q, i) => add(q.layer, `hand:${g}:${i}`, { clip: q.clip, z: q.layer + i * 0.001, jk: 'hand:' + g })); continue; }
    let layer = HANDS[g].layer;
    if (g === 'paw' || g === 'paw2') {
      const speed = (p.swaySpeed || 0) + (p.hands[g].beckonSpeed || 0);
      if (Math.abs(speed) > 1e-6) layer = speed > 0 ? HANDS.paw2.layer : HANDS.paw.layer;
    }
    add(layer, 'hand:' + g);
  }
  if (st.laptop !== 'none') {
    const lp = RIG.laptop;
    add(lp.layer, 'laptop', { z: lp.z, img: st.laptop === 'green' ? App.laptopGreen : null });
    if (st.laptop === 'final') add(lp.final, 'laptop', { z: lp.z + 0.1 });
  }
  // 背景层：WASTED 画在身体后面，不跟着身体动
  if (st.wasted) add(RIG.wasted, 'wasted', { z: RIG.wasted });
  list.sort((a, b) => a.z - b.z);

  const M = { root, body: W.body, head: W.head, earL: W.earL, earR: W.earR };
  for (const g of vis) {
    M['hand:' + g] = HM[g].M;
    (HANDS[g].parts || []).forEach((q, i) => {
      const v = (p.hands[g]?.parts || [])[i] || { dx: 0, dy: 0, rot: 0 }, [px, py] = q.pivot;
      M[`hand:${g}:${i}`] = HM[g].M.translate(px + v.dx, py + v.dy).rotate(v.rot).translate(-px, -py);
    });
  }
  M.laptop = (HM[RIG.laptop.hand] ? HM[RIG.laptop.hand].nb : W.body).translate(S.lapX, S.lapY).scale(S.lapScale);
  {   // WASTED 字：打开的一瞬间从 1.8 倍砸下来
    const L = App.layers[RIG.wasted], u = st.wastedT >= 0 ? (clock.time - SpeedCurve.sample(st.wastedT).time) / (0.75 * beatSeconds()) : 1;
    const s = u < 1 ? 1.8 - 0.8 * easeOutCubic(Math.max(0, u)) : 1;
    M.wasted = L ? root.translate(L.x + L.w / 2, L.y + L.h / 2).scale(s).translate(-L.x - L.w / 2, -L.y - L.h / 2) : root;
  }
  const J = {};
  const jit = (mk, jk) => {
    const key = jk || mk;
    if (!(key in J)) J[key] = S.jitter > 0 && S.boilFps > 0 ? [noise(tick * 7 + hashKey(key), 3) * S.jitter, noise(tick * 7 + hashKey(key), 4) * S.jitter] : [0, 0];
    return M[mk].translate(J[key][0], J[key][1]);
  };

  ctx.imageSmoothingQuality = 'high';
  for (const it of list) {
    const L = App.layers[it.idx];
    if (!L || !L.canvas || !M[it.mk]) continue;
    ctx.setTransform(jit(it.mk, it.jk));
    const gesture = it.mk.startsWith('hand:') ? it.mk.split(':')[1] : null;
    ctx.globalAlpha = L.opacity * (transitions[gesture]?.alpha ?? 1);
    if (it.clip) {
      ctx.save(); ctx.beginPath();
      if (it.inv) ctx.rect(L.x - 4, L.y - 4, L.w + 8, L.h + 8);
      it.clip.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.clip(it.inv ? 'evenodd' : 'nonzero');
      ctx.drawImage(L.canvas, L.x, L.y);
      ctx.restore();
    } else ctx.drawImage(it.img || L.canvas, L.x, L.y);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  // 缩放框：关键帧里开了「显示框」就画出来，会跟着导出
  for (const g of F.vis) if (boxes[g].box) drawTransformBox(ctx, HM[g].M, handRect(g));
  if (live) App.frame = { W, root, p, HM, boxes, vis:F.vis, st };
  return st;
}

// 仿 PS 自由变换框：细线 + 8 个方形手柄 + 中心十字
function boxHandles(Mx, r) {
  const [x, y, w, h] = r;
  return [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]].map(([a, b]) => Mx.transformPoint(new DOMPoint(a, b)));
}
function drawTransformBox(ctx, Mx, r, ghost = false) {
  const P = boxHandles(Mx, r), k = Math.max(1, S.outW / 1000), c = Mx.transformPoint(new DOMPoint(r[0] + r[2] / 2, r[1] + r[3] / 2));
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = ghost ? 0.75 : 1;
  ctx.beginPath(); [0, 2, 4, 6].forEach((i, n) => (n ? ctx.lineTo(P[i].x, P[i].y) : ctx.moveTo(P[i].x, P[i].y))); ctx.closePath();
  ctx.lineWidth = 1.5 * k; ctx.strokeStyle = ghost ? '#2f8cff' : '#111'; if (ghost) ctx.setLineDash([6 * k, 4 * k]); ctx.stroke(); ctx.setLineDash([]);
  const s = 9 * k;
  for (const q of P) { ctx.fillStyle = '#fff'; ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s); ctx.lineWidth = 1.2 * k; ctx.strokeStyle = '#111'; ctx.strokeRect(q.x - s / 2, q.y - s / 2, s, s); }
  ctx.lineWidth = 1.2 * k; ctx.strokeStyle = ghost ? '#2f8cff' : '#111'; ctx.beginPath(); ctx.moveTo(c.x - 6 * k, c.y); ctx.lineTo(c.x + 6 * k, c.y); ctx.moveTo(c.x, c.y - 6 * k); ctx.lineTo(c.x, c.y + 6 * k); ctx.stroke();
  ctx.restore();
}
function drawBones(ctx) {
  const F = App.frame; if (!F) return;
  const k = Math.max(1, S.outW / 1000);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${13 * k}px sans-serif`; ctx.lineCap = 'round';
  for (const b of BONES) {
    const a = bonePivotW(F.W, b.id), c = boneTipW(F.W, b.id), sel = b.id === App.selBone;
    ctx.strokeStyle = sel ? '#ffd23f' : '#ff3030'; ctx.lineWidth = (sel ? 4 : 2.5) * k;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(a.x, a.y, 5 * k, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2 * k; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(c.x, c.y, 7 * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.fillText(b.label, c.x + 10 * k, c.y - 6 * k);
  }
  ctx.restore();
}
const showBones = () => App.tab === 'bones' || $('#chkBonesAlways').checked;

// ---------- 播放 ----------
function clockTime() {
  if (Mic.taking && Mic.ctx) return Mic.ctx.currentTime - Mic.t0;   // 录音时跟麦克风的音频时钟走，关键帧和录音不会漂
  if (App.audioBuf && !audio.paused) return audio.currentTime;
  return App.tStart + (performance.now() - App.wallStart) / 1000;
}
function outputRange() {
  const start = Math.max(0, +$('#exStart').value);
  const end = $('#exEnd').value === '' ? App.duration : +$('#exEnd').value;
  return { start, end };
}
function allKeyTimes() {
  return [App.events, SpeedCurve.points, ...Object.values(Tracks.data)].flatMap(keys => keys.map(k => k.t));
}
function setTimelineView(start, span) {
  const width = Math.max(0.1, span);
  $('#inSpan').value = width;
  App.view0 = Math.max(0, start);
}
function fitTimeline() {
  const end = allKeyTimes().reduce((latest,t) => Math.max(latest,t), Math.max(1,outputRange().end,App.audioBuf?.duration || 0));
  setTimelineView(0,end*1.04);
}
function zoomTimeline(factor, anchor, fraction) {
  const width = clamp(+$('#inSpan').value*factor,0.1,Math.max(86400,+$('#inSpan').value));
  setTimelineView(anchor-width*fraction,width);
}
function play() {
  const {start,end} = outputRange();
  if (!Mic.taking && end <= start) { status('输出终点须晚于起点', true); return; }
  if (!Mic.taking && (App.t < start || App.t >= end)) App.t = start;
  App.playing = true; App.wallStart = performance.now(); App.tStart = App.t;
  if (App.audioBuf && App.t < App.audioBuf.duration) { audio.currentTime = App.t; audio.play().catch(() => {}); }
  if (refVideo.src) { refVideo.currentTime = App.t; refVideo.play().catch(() => {}); }
  $('#btnPlay').textContent = '⏸';
}
function pause() {
  App.playing = false; audio.pause(); refVideo.pause(); App.pauseWall = performance.now();
  $('#btnPlay').textContent = '▶';
}
function seek(t) {
  App.t = Math.max(0,t);
  if (App.playing) {
    App.wallStart = performance.now(); App.tStart = App.t;
    if (App.audioBuf) {
      if (App.t < App.audioBuf.duration) { audio.currentTime = App.t; audio.play().catch(() => {}); }
      else audio.pause();
    }
  }
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
    const end = outputRange().end;
    if (!Mic.taking && App.t >= end) { App.t = end; pause(); }
    if (refVideo.src && Math.abs(refVideo.currentTime - App.t) > 0.15) refVideo.currentTime = App.t;
  }
  if (Mic.on) micTick(now);
  if (App.ready && !App.exporting) {
    readSettings();
    // 先画到缓冲层，再套着滤镜贴到预览上；骨骼红线和编辑用的缩放框只画在预览上
    const buf = layerBuf(S.outW, S.outH), bctx = buf.getContext('2d');
    bctx.clearRect(0, 0, S.outW, S.outH);
    const tIdle = App.playing ? App.t : App.t + (now - App.pauseWall) / 1000;
    drawAvatar(bctx, App.t, tIdle, true, now);
    const ctx = $('#view').getContext('2d');
    ctx.clearRect(0, 0, S.outW, S.outH);
    ctx.filter = App.compare ? 'none' : Grade.css();
    ctx.drawImage(buf, 0, 0);
    ctx.filter = 'none';
    const F = App.frame, bh = $('#selBoxHand').value;
    if (F && $('#chkBoxEdit').checked && F.vis.includes(bh) && !F.boxes[bh].box) drawTransformBox(ctx, F.HM[bh].M, handRect(bh), true);
    if (showBones()) drawBones(ctx);
    if (now - (App.histT || 0) > 400) { App.histT = now; CurveEditor.updateHist(buf); }
  }
  const range = outputRange();
  $('#outLength').textContent = range.end > range.start ? '输出 ' + (range.end-range.start).toFixed(2) + ' s' : '输出区间无效';
  $('#exEnd').placeholder = String(+App.duration.toFixed(2));
  drawTimeline();
  drawSpeedCurve();
  $('#timeText').textContent = `${App.t.toFixed(2)} / ${outputRange().end.toFixed(2)} s`;
  if (now - lastUI > 120) { lastUI = now; updateButtons(); refreshEditors(); }
  App.live.acts = App.live.acts.filter(a => { const D = actDef(a.k, a.v); return D && liveMotionAge(a, now) < actionSeconds(D) + (D.wave ? 0.1 * MAX_SPEED : 0); });
  requestAnimationFrame(frame);
}

// ---------- 按键 / 按钮 ----------
const GROUPS = [
  { id: 'g_expr', k: 'expr', items: Object.entries(EXPRESSIONS).map(([v, x]) => ({ v, label: x.label, key: x.key })) },
  { id: 'g_mouth', k: 'mouth', items: [{ v: null, label: '自动', key: '`' }, ...MOUTHS], hold: true },
  { id: 'g_eyes', k: 'eyes', items: EYES },
  { id: 'g_ears', k: 'ears', items: EAR_POSES },
  { id: 'g_earL', k: 'earL', items: EAR_POSES },
  { id: 'g_earR', k: 'earR', items: EAR_POSES },
  { id: 'g_whiskers', k: 'whiskers', items: WHISKERS },
  { id: 'g_laptop', k: 'laptop', items: LAPTOP },
  { id: 'g_act', k: 'act', items: Object.entries(ACTIONS).map(([v, a]) => ({ v, label: a.label, key: a.key })) },
];
const KEYMAP = {};

function markLive() {
  $('#liveBadge').hidden = !(App.live.over.length || Object.keys(App.live.bone).length || Object.keys(App.live.box).length);
}
function insertEvent(e) {
  let i = App.events.length; while (i > 0 && App.events[i - 1].t > e.t) i--;
  App.events.splice(i, 0, e);
}
function trigger(k, v) {
  if (!App.ready) return;
  if (App.recording) {
    const e = { t: +snapKeyTime(App.t).toFixed(3), k, v };
    insertEvent(e);
    renderEventList();
  } else {
    if (k === 'act' || k === 'gact') App.live.acts.push({ k, v, start: performance.now(), timelineStart: App.t });
    if (k !== 'gact' && (k !== 'act' || v === 'pop' || v === 'out')) App.live.over.push([k, v, performance.now()]);
    if (App.live.over.length > 200) App.live.over.splice(0, 100);
    markLive();
  }
  if (k === 'act' || k === 'gact') flash(k, v);
}
function flash(k, v) {
  const b = document.querySelector(`#${k === 'act' ? 'g_act' : 'g_gact'} button[data-v="${v}"]`);
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
  // 手势：按左 / 右 / 双手分组，点一下打开，再点一下放下
  for (const grp of HAND_GROUPS) {
    const box = $('#g_hand' + grp.side);
    for (const [id, G] of Object.entries(HANDS)) {
      if (G.side.join('') !== grp.side) continue;
      const b = document.createElement('button'); b.dataset.v = id; b.textContent = G.label;
      b.title = `图层 ${handLayers(G).join(' + ')}${G.body === 'mirror' ? '，配身体镜像版' : ''}${G.isBody ? '，和衣服在同一图层' : ''}`;
      b.onclick = () => { const st = stateAt(App.t, true).st; trigger(st.hands.L === id || st.hands.R === id ? 'handOff' : 'hand', id); };
      box.appendChild(b);
    }
  }
  $('#btnHandsOff').onclick = () => trigger('handOff', 'all');
  $('#btnWasted').onclick = () => trigger('wasted', !stateAt(App.t, true).st.wasted);
  const sel = $('#selBoxHand');
  for (const [id, G] of Object.entries(HANDS)) sel.appendChild(new Option(`${G.label}（${G.side.map(s => (s === 'L' ? '左' : '右')).join('')}）`, id));
}
let gactSig = '';
function updateButtons() {
  if (!App.ready) return;
  const st = stateAt(App.t, true).st;
  const cur = { expr: st.expr, mouth: st.mouth === null ? '' : st.mouth, eyes: st.eyes, earL: st.earL, earR: st.earR, ears: st.earL === st.earR ? st.earL : '', whiskers: st.whiskers, laptop: st.laptop };
  for (const g of GROUPS) {
    if (g.k === 'act') continue;
    for (const b of document.querySelectorAll(`#${g.id} button`)) b.classList.toggle('on', cur[g.k] === b.dataset.v);
  }
  const on = [st.hands.L, st.hands.R];
  for (const b of document.querySelectorAll('.handbtns button')) b.classList.toggle('on', on.includes(b.dataset.v));
  $('#btnWasted').classList.toggle('on', st.wasted);
  // 手势专属动画：只列出现在举着的手势的
  const vis = [...new Set(on.filter(Boolean))], sig = vis.join(',');
  if (sig !== gactSig) {
    gactSig = sig;
    const box = $('#g_gact'); box.replaceChildren();
    for (const g of vis) for (const an of HANDS[g].anims || []) {
      const b = document.createElement('button'); b.dataset.v = `${g}:${an}`; b.textContent = `${HANDS[g].label}·${HAND_ANIMS[an].label}`;
      b.onclick = () => trigger('gact', `${g}:${an}`); box.appendChild(b);
    }
    if (!box.children.length) box.innerHTML = '<span class="dim">先举起一个手势，这里会出现它的专属动画</span>';
    if (vis.length && !vis.includes($('#selBoxHand').value)) $('#selBoxHand').value = vis[0];
  }
}

const held = new Set();
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) App.playing ? pause() : play(); return; }
  if (e.key === 'Home') { e.preventDefault(); fitTimeline(); return; }
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    e.preventDefault(); pause();
    const r = outputRange();
    let target;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const right = e.key === 'ArrowRight', fps = S.fps || 30;
      target = e.shiftKey ? (right ? r.end : r.start) : (Math.round(App.t*fps)+(right?1:-1))/fps;
    } else {
      const next = e.key === 'ArrowUp';
      const times = allKeyTimes().filter(t => next ? t > App.t+1e-6 : t < App.t-1e-6).sort((a,b)=>a-b);
      target = (next ? times[0] : times.at(-1)) ?? App.t;
    }
    seek(target);
    const width = +$('#inSpan').value;
    if (App.t < App.view0 || App.t > App.view0+width) setTimelineView(App.t-width/2,width);
    return;
  }
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

// ---------- 骨骼 / 缩放框的编辑 ----------
function setBone(id, v) {
  if (autoKeyOn()) { Tracks.setKey('bone.' + id, snapKeyTime(App.t), v, curEase()); delete App.live.bone[id]; onTracksChanged(); }
  else { App.live.bone[id] = { ...v }; markLive(); }
}
function setBox(id, v) {
  if (autoKeyOn()) { Tracks.setKey('hand.' + id, snapKeyTime(App.t), v, curEase()); delete App.live.box[id]; onTracksChanged(); }
  else { App.live.box[id] = { ...v }; markLive(); }
}
function keyNow(name, v) { Tracks.setKey(name, snapKeyTime(App.t), v, curEase()); onTracksChanged(); }

function buildBoneUI() {
  const box = $('#g_bones');
  for (const b of BONES) { const btn = document.createElement('button'); btn.dataset.v = b.id; btn.textContent = b.label; btn.onclick = () => { App.selBone = b.id; renderBoneKeys(); refreshEditors(true); }; box.appendChild(btn); }
  const grid = $('#boneFields');
  for (const P of BONE_PARAMS) {
    const lab = document.createElement('label');
    lab.innerHTML = `${P.label} <input type="range" data-k="${P.k}" min="${P.min}" max="${P.max}" step="${P.step}"> <input type="number" data-k="${P.k}" step="${P.step}">`;
    grid.appendChild(lab);
  }
  grid.addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    const v = boneVals(App.selBone, App.t, true); v[k] = +e.target.value; setBone(App.selBone, v); refreshEditors(true, e.target);
  });
  $('#btnBoneKey').onclick = () => { const id = App.selBone; keyNow('bone.' + id, boneVals(id, App.t, true)); delete App.live.bone[id]; markLive(); };
  $('#btnBoneDelKey').onclick = () => { if (Tracks.removeKeyAt('bone.' + App.selBone, App.t)) onTracksChanged(); else status('当前时间没有这根骨骼的关键帧', true); };
  $('#btnBoneReset').onclick = () => setBone(App.selBone, { ...BONE_DEF });
  for (const [k, e] of Object.entries(EASES)) $('#selEase').appendChild(new Option(e.label, k));
}
function buildBoxUI() {
  const sync = e => {
    $('#rhythmStrengthNow').value = Math.round(Tracks.eval('rhythm.strength',App.t,{percent:100}).percent)+'%';
    const id = $('#selBoxHand').value, v = boxVals(id, App.t, true), k = e.target.dataset.k;
    if (k === 'sx' || k === 'sy') v[k] = e.target.type === 'range' ? +Math.pow(2, +e.target.value).toFixed(3) : +e.target.value;
    else if (k === 'x' || k === 'y') {
      if (!Number.isFinite(e.target.valueAsNumber)) return;
      v[k] = e.target.valueAsNumber;
    }
    else if (k === 'box') v.box = e.target.checked ? 1 : 0;
    else if (k === 'anchor') v.anchor = e.target.value;
    setBox(id, v); refreshEditors(true, e.target);
  };
  for (const el of document.querySelectorAll('#boxFields [data-k]')) el.addEventListener(el.type === 'range' || el.type === 'number' ? 'input' : 'change', sync);
  $('#selBoxHand').onchange = () => { renderBoxKeys(); refreshEditors(true); };
  $('#btnBoxKey').onclick = () => { const id = $('#selBoxHand').value; keyNow('hand.' + id, boxVals(id, App.t, true)); delete App.live.box[id]; markLive(); };
  $('#btnBoxDelKey').onclick = () => { if (Tracks.removeKeyAt('hand.' + $('#selBoxHand').value, App.t)) onTracksChanged(); else status('当前时间没有这个手势的缩放框关键帧', true); };
  $('#btnBoxMoveReset').onclick = () => { const id = $('#selBoxHand').value; setBox(id, { ...boxVals(id, App.t, true), x: 0, y: 0 }); refreshEditors(true); };
  $('#btnBoxReset').onclick = () => { const id = $('#selBoxHand').value; setBox(id, { ...boxVals(id, App.t, true), sx: 1, sy: 1 }); };
}
// 面板上的数值跟着时间 / 拖动刷新（正在输入的那个框不动）
function refreshEditors(force, skip) {
  if (!App.ready) return;
  if (App.tab === 'bones' || force) {
    const v = boneVals(App.selBone, App.t, true);
    for (const el of document.querySelectorAll('#boneFields [data-k]')) if (el !== skip && el !== document.activeElement) el.value = +(+v[el.dataset.k]).toFixed(3);
    for (const b of document.querySelectorAll('#g_bones button')) b.classList.toggle('on', b.dataset.v === App.selBone);
    const hasKey = Tracks.keys('bone.' + App.selBone).some(k => Math.abs(k.t - App.t) < 1e-3);
    $('#btnBoneKey').textContent = hasKey ? '◆ 更新关键帧' : '◇ 记关键帧';
  }
  if (App.tab === 'pose' || force) {
    $('#rhythmStrengthNow').value = Math.round(Tracks.eval('rhythm.strength',App.t,{percent:100}).percent)+'%';
    const id = $('#selBoxHand').value, v = boxVals(id, App.t, true);
    for (const el of document.querySelectorAll('#boxFields [data-k]')) {
      if (el === skip || el === document.activeElement) continue;
      const k = el.dataset.k;
      if (k === 'box') el.checked = !!v.box;
      else if (k === 'anchor') el.value = v.anchor;
      else el.value = el.type === 'range' ? Math.log2(Math.max(0.05, Math.abs(v[k]))).toFixed(3) : +(+v[k]).toFixed(3);
    }
  }
}
function keyRow(name, k, i, summary) {
  const tr = document.createElement('tr');
  const ti = document.createElement('input'); ti.type = 'number'; ti.step = '0.01'; ti.value = k.t;
  ti.onchange = () => { const K = Tracks.keys(name); K[i].t = Math.max(0, +ti.value); K.sort((a, b) => a.t - b.t); onTracksChanged(); };
  const es = document.createElement('select'); for (const [ek, e] of Object.entries(EASES)) es.appendChild(new Option(e.label, ek)); es.value = k.ease;
  es.onchange = () => { k.ease = es.value; onTracksChanged(); };
  const go = document.createElement('button'); go.textContent = '跳到'; go.onclick = () => seek(k.t);
  const del = document.createElement('button'); del.textContent = '✕'; del.onclick = () => { Tracks.keys(name).splice(i, 1); if (!Tracks.keys(name).length) delete Tracks.data[name]; onTracksChanged(); };
  tr.insertCell().appendChild(ti); tr.insertCell().textContent = summary; tr.insertCell().appendChild(es); tr.insertCell().append(go, del);
  return tr;
}
const fmtBone = v => `角${(+v.rot).toFixed(1)}° 移${(+v.x).toFixed(0)},${(+v.y).toFixed(0)} 缩${(+v.sx).toFixed(2)}×${(+v.sy).toFixed(2)}`;
const fmtBox = v => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}) · ${(+v.sx).toFixed(2)}×${(+v.sy).toFixed(2)}${v.box ? ' 显示框' : ''}${v.anchor === 'center' ? ' 中心' : ''}`;
function renderBoneKeys() {
  const name = 'bone.' + App.selBone, K = Tracks.keys(name), box = $('#boneKeyList');
  if (!K.length) { box.innerHTML = '<span class="dim">还没有关键帧</span>'; return; }
  const tb = document.createElement('table'); K.forEach((k, i) => tb.appendChild(keyRow(name, k, i, fmtBone({ ...BONE_DEF, ...k.v })))); box.replaceChildren(tb);
}
function renderBoxKeys() {
  const name = 'hand.' + $('#selBoxHand').value, K = Tracks.keys(name), box = $('#boxKeyList');
  if (!K.length) { box.innerHTML = '<span class="dim">这个手势还没有缩放框关键帧（默认 1×1、不显示框）</span>'; return; }
  const tb = document.createElement('table'); K.forEach((k, i) => tb.appendChild(keyRow(name, k, i, fmtBox({ ...BOX_DEF, ...k.v })))); box.replaceChildren(tb);
}
function renderRhythmKeys() {
  const table = $('#rhythmKeys');
  table.replaceChildren();
  Tracks.keys('rhythm.strength').forEach((k,i) => table.appendChild(keyRow('rhythm.strength',k,i,k.v.percent+'%')));
}
function onTracksChanged() { renderRhythmKeys(); recordTimelineEdit(); renderBoneKeys(); renderBoxKeys(); refreshEditors(true); }

// 在预览上拖：缩放框手柄 / 骨骼末端（转动，IK）/ 按住 Shift 拖关节（平移）
function viewPt(e) { const v = $('#view'), r = v.getBoundingClientRect(); return { x: (e.clientX - r.left) * v.width / r.width, y: (e.clientY - r.top) * v.height / r.height }; }
function bindViewDrag() {
  const view = $('#view');
  const near = (a, b, px) => Math.hypot(a.x - b.x, a.y - b.y) < px;
  view.addEventListener('pointerdown', e => {
    const F = App.frame; if (!F || e.button !== 0) return;
    const q = viewPt(e), tol = 14 * view.width / view.getBoundingClientRect().width;
    const bh = $('#selBoxHand').value;
    if ($('#chkBoxEdit').checked && F.vis.includes(bh)) {
      const r = handRect(bh), P = boxHandles(F.HM[bh].M, r);
      const hi = P.findIndex(p => near(p, q, tol));
      const inv = F.HM[bh].nb.inverse(), start = inv.transformPoint(q);
      const local = F.HM[bh].M.inverse().transformPoint(q);
      const [x, y, w, h] = r;
      const inside = local.x >= x && local.x <= x+w && local.y >= y && local.y <= y+h;
      if (hi >= 0 || inside) {
        const c0 = [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]][hi];
        App.drag = { type: 'box', g: bh, hi, c0, inv, start, anchor: F.HM[bh].anchor, base: boxVals(bh, App.t, true) };
        view.setPointerCapture(e.pointerId); e.preventDefault(); return;
      }
    }
    if (!showBones()) return;
    let best = null;
    for (const b of BONES) {
      const pt = e.shiftKey ? bonePivotW(F.W, b.id) : boneTipW(F.W, b.id), d = Math.hypot(pt.x - q.x, pt.y - q.y);
      if (d < tol * 1.3 && (!best || d < best.d)) best = { id: b.id, d };
    }
    if (!best) return;
    App.selBone = best.id; renderBoneKeys();
    const chain = []; let id = best.id;
    for (let n = 0; n < +$('#selIKLen').value && id; n++) { chain.push(id); id = boneById[id].parent; }
    const base = {}; for (const c of chain) base[c] = boneVals(c, App.t, true);
    const par = boneById[best.id].parent;
    App.drag = { type: e.shiftKey ? 'move' : 'ik', id: best.id, chain, base, pose: clonePose(F.p), root: F.root, start: q,
      inv: (par ? F.W[par] : F.root).inverse(), baseMove: boneVals(best.id, App.t, true) };
    view.setPointerCapture(e.pointerId); e.preventDefault();
  });
  view.addEventListener('pointermove', e => {
    const D = App.drag; if (!D) return;
    const q = viewPt(e);
    if (D.type === 'box') {
      const local = D.inv.transformPoint(q);
      const dx = local.x - D.start.x, dy = local.y - D.start.y;
      if (D.hi < 0) {
        setBox(D.g, { ...D.base, x: +(D.base.x + dx).toFixed(2), y: +(D.base.y + dy).toFixed(2) });
        return;
      }
      const [ax, ay] = D.anchor, [cx, cy] = D.c0;
      const v = { ...D.base };
      const fx = [0, 2, 3, 4, 6, 7].includes(D.hi) && Math.abs(cx - ax) > 2, fy = [0, 1, 2, 4, 5, 6].includes(D.hi) && Math.abs(cy - ay) > 2;
      const lim = s => Math.sign(s || 1) * clamp(Math.abs(s), 0.05, 12);
      if (fx) v.sx = lim(D.base.sx + dx / (cx - ax));
      if (fy) v.sy = lim(D.base.sy + dy / (cy - ay));
      if (e.shiftKey && fx && fy) { const rx = v.sx / D.base.sx, ry = v.sy / D.base.sy;
        const ratio = Math.abs(rx - 1) > Math.abs(ry - 1) ? rx : ry;
        v.sx = lim(D.base.sx * ratio); v.sy = lim(D.base.sy * ratio); }
      v.sx = +v.sx.toFixed(3); v.sy = +v.sy.toFixed(3);
      setBox(D.g, v);
    } else if (D.type === 'ik') {
      const delta = solveIK(D.root, D.pose, D.id, D.chain, q);
      for (const c of D.chain) setBone(c, { ...D.base[c], rot: +(D.base[c].rot + (delta[c] || 0)).toFixed(2) });
    } else {
      const a = D.inv.transformPoint(new DOMPoint(D.start.x, D.start.y)), b = D.inv.transformPoint(new DOMPoint(q.x, q.y));
      setBone(D.id, { ...D.baseMove, x: +(D.baseMove.x + b.x - a.x).toFixed(1), y: +(D.baseMove.y + b.y - a.y).toFixed(1) });
    }
  });
  const end = () => { App.drag = null; };
  view.addEventListener('pointerup', end); view.addEventListener('pointercancel', end);
}

// ---------- 时间轴 ----------
const EV_ROW = { expr: 0, mouth: 1, eyes: 2, ears: 2, earL: 2, earR: 2, whiskers: 2, hand: 3, handOff: 3, laptop: 3, wasted: 3, final: 3, body: 3, act: 4, gact: 4 };
const handName = id => (id === 'all' ? '全部' : HANDS[id]?.label || id);
function evLabel(e) {
  const find = (arr, v) => (arr.find(x => x.v === v) || {}).label || v;
  switch (e.k) {
    case 'expr': return EXPRESSIONS[currentEyeId(e.v)]?.label || e.v;
    case 'mouth': return e.v === null ? '嘴:自动' : '嘴:' + find(MOUTHS, e.v);
    case 'eyes': return '眼:' + find(EYES, currentEyeId(e.v));
    case 'ears': return '耳:' + find(EAR_POSES, e.v);
    case 'earL': return '左耳:' + find(EAR_POSES, e.v);
    case 'earR': return '右耳:' + find(EAR_POSES, e.v);
    case 'whiskers': return '胡子:' + find(WHISKERS, e.v);
    case 'hand': return e.v === 'none' ? '手:全放下' : e.v === 'laptop' ? '手:展示+电脑(旧)' : '手:' + handName(e.v);
    case 'handOff': return '放下:' + handName(e.v);
    case 'gact': { const [g, an] = gestureAction(e.v); return `${handName(g)}·${HAND_ANIMS[an]?.label || an}`; }
    case 'final': return 'FINAL ' + (e.v ? '开' : '关');
    case 'body': return '身体(旧，已忽略)';
    case 'laptop': return '电脑:' + find(LAPTOP, e.v);
    case 'wasted': return 'WASTED ' + (e.v ? '开' : '关');
    case 'act': return ACTIONS[e.v]?.label || e.v;
  }
  return e.k;
}
const trackLabel = n => { if(n==='rhythm.strength') return '律动强度'; const [type, id] = n.split('.'); return type === 'bone' ? '骨骼·' + (boneById[id]?.label || id) : '缩放框·' + handName(id); };
function drawTimeline() {
  const cv = $('#timeline'), dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const span = +$('#inSpan').value;
  if (App.playing && !tlDrag && (App.t < App.view0 || App.t > App.view0+span)) App.view0 = Math.max(0,App.t-span*0.15);
  const t0 = App.view0, X = t => (t - t0) / span * W;
  App.tlView = { t0, span, W };

  const range = outputRange();
  ctx.fillStyle = '#101216'; ctx.fillRect(0,0,clamp(X(range.start),0,W),H);
  const right = clamp(X(range.end),0,W); ctx.fillRect(right,0,W-right,H);
  ctx.fillStyle = '#70cfb8'; ctx.fillRect(X(range.start),0,2,H); ctx.fillRect(X(range.end)-1,0,2,H);
  if (App.sel) {
    const a = X(Math.min(App.sel.t0, App.sel.t1)), b = X(Math.max(App.sel.t0, App.sel.t1));
    ctx.fillStyle = 'rgba(95,179,154,.18)'; ctx.fillRect(a, 0, b - a, H);
    ctx.fillStyle = '#5fb39a'; ctx.fillRect(a, 0, 1, H); ctx.fillRect(b - 1, 0, 1, H);
  }
  ctx.font = '10px sans-serif'; ctx.fillStyle = '#666'; ctx.strokeStyle = '#2b2f36';
  const step = 2 ** Math.ceil(Math.log2(Math.max(0.001, span * 55 / Math.max(W,1))));
  for (let s = Math.ceil(t0 / step) * step; s <= t0 + span; s += step) { const x = X(s); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.fillText(s.toFixed(Math.max(0,Math.ceil(-Math.log10(step)))), x + 2, 10); }

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
    ctx.fillStyle = e.k === 'act' || e.k === 'gact' ? '#e8463a' : e.k === 'mouth' ? '#e9c13b' : '#5fb39a';
    ctx.fillRect(x, y, 2, 8); ctx.fillText(evLabel(e), x + 3, y + 8);
  }
  // 骨骼 / 缩放框关键帧：菱形
  const y = 66 + 5 * 9 + 5;
  for (const [n, K] of Object.entries(Tracks.data)) {
    ctx.fillStyle = n.startsWith('bone.') ? (n === 'bone.' + App.selBone ? '#ffd23f' : '#ff6b6b') : '#4a8fd9';
    for (const k of K) { if (k.t < t0 || k.t > t0 + span) continue; const x = X(k.t); ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.fill(); }
  }
  ctx.fillStyle = '#ff5a4e'; ctx.fillRect(X(App.t) - 1, 0, 2, H);
}
let tlDrag = null;
function snapKeyTime(t, exclude = null) {
  const view = App.tlView;
  if (!$('#chkKeySnap').checked || !view?.W) return t;
  // 按屏幕距离吸附，长时间轴也只捕捉相邻的 0.1 秒。
  let nearest = t, distance = Math.min(0.1, 7 * view.span / view.W);
  for (const keys of [App.events, SpeedCurve.points, ...Object.values(Tracks.data)]) {
    for (const key of keys) {
      if (key === exclude) continue;
      const delta = Math.abs(key.t - t);
      if (delta <= distance && key.t >= 0) {
        nearest = key.t;
        distance = delta;
      }
    }
  }
  return nearest;
}
const tlTime = e => {
  const r = $('#timeline').getBoundingClientRect(), v = App.tlView;
  return v ? snapKeyTime(Math.max(0, v.t0 + (e.clientX - r.left) / r.width * v.span)) : 0;
};
let panStart;
$('#timeline').addEventListener('wheel', e => {
  e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  if (!rect.width || (!e.deltaX && !e.deltaY)) return;
  const span = +$('#inSpan').value;
  const horizontal = Math.abs(e.deltaX) >= Math.abs(e.deltaY);
  if (horizontal || e.shiftKey) {
    const delta = horizontal ? e.deltaX : e.deltaY;
    const pixelsPerUnit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.width : 1;
    setTimelineView(App.view0 + delta * pixelsPerUnit / rect.width * span, span);
    return;
  }
  const f = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  zoomTimeline(e.deltaY < 0 ? 0.8 : 1.25, App.view0 + span * f, f);
}, { passive:false });
$('#timeline').addEventListener('pointerdown', e => {
  if (e.button === 1) {
    e.preventDefault(); tlDrag='pan'; panStart={x:e.clientX,t:App.view0};
    e.currentTarget.setPointerCapture(e.pointerId); return;
  }
  if (e.button !== 0) return;
  if (e.shiftKey) { const t = tlTime(e); tlDrag = 'sel'; App.sel = { t0: t, t1: t }; }
  else { tlDrag = 'seek'; seek(tlTime(e)); }
});
window.addEventListener('pointermove', e => {
  if (tlDrag === 'pan') App.view0 = Math.max(0,panStart.t+(panStart.x-e.clientX)*App.tlView.span/App.tlView.W);
  if (tlDrag === 'seek') seek(tlTime(e));
  else if (tlDrag === 'sel') { App.sel.t1 = tlTime(e); syncSelInputs(); }
});
window.addEventListener('pointerup', () => {
  if (tlDrag === 'sel' && Math.abs(App.sel.t1 - App.sel.t0) < 0.02) App.sel = null;
  if (tlDrag === 'sel') syncSelInputs();
  tlDrag = null;
});

// 离散关键帧、插值轨道和速度曲线共享最近十次时间轴编辑。
let lastTimelineState = null, timelineDragPointer = null;
function recordTimelineEdit() {
  if (timelineDragPointer !== null) return;
  const state = JSON.stringify({ events: App.events, tracks: Tracks.data, curve: SpeedCurve.points });
  if (state !== lastTimelineState && lastTimelineState !== null) {
    App.history.push(lastTimelineState);
    if (App.history.length > 10) App.history.shift();
  }
  lastTimelineState = state;
  for (const b of document.querySelectorAll('[data-timeline-undo]')) {
    b.disabled = !App.history.length;
    b.title = '撤销时间轴编辑（Ctrl+Z / ⌘Z），可撤销 ' + App.history.length + ' 步';
  }
}
function undoTimelineEdit() {
  if (timelineDragPointer !== null || !App.history.length) return;
  lastTimelineState = App.history.pop();
  const state = JSON.parse(lastTimelineState);
  App.events = state.events;
  Tracks.data = state.tracks;
  SpeedCurve.load(state.curve);
  renderEventList(); onTracksChanged();
}
function bindTimelineUndo() {
  for (const b of document.querySelectorAll('[data-timeline-undo]')) b.onclick = undoTimelineEdit;
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
    if (e.target.isContentEditable || e.target.matches?.('textarea,input:not([type]),input[type=text],input[type=number]')) return;
    e.preventDefault();
    if (!e.repeat) undoTimelineEdit();
  });
  document.addEventListener('pointerdown', e => {
    if (e.button === 0 && e.target.matches('#view,#boneFields input[type=range],#boxFields input[type=range]'))
      timelineDragPointer = e.pointerId;
  }, true);
  const finish = e => {
    if (timelineDragPointer !== e.pointerId) return;
    timelineDragPointer = null; recordTimelineEdit();
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

// ---------- 关键帧列表 ----------
function renderEventList() {
  recordTimelineEdit();
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

// ---------- 片段蓝图：把选区里的关键帧记下来，之后整段部署，或者交给 agent 参考修改 ----------
function syncSelInputs() {
  const s = App.sel;
  $('#selT0').value = s ? Math.min(s.t0, s.t1).toFixed(2) : '';
  $('#selT1').value = s ? Math.max(s.t0, s.t1).toFixed(2) : '';
}
function stateSnapshot(t) {
  const st = stateAt(t, false).st;
  return { expr: st.expr, eyes: st.eyes, earL: st.earL, earR: st.earR, whiskers: st.whiskers, mouth: st.mouth, hands: { ...st.hands }, laptop: st.laptop, wasted: st.wasted };
}
// 把起始状态还原成一串关键帧（表情放最前，后面是单独改过的部分）
function snapshotEvents(s) {
  const ev = [{ k: 'expr', v: s.expr }, { k: 'eyes', v: s.eyes }, { k: 'earL', v: s.earL }, { k: 'earR', v: s.earR }, { k: 'whiskers', v: s.whiskers }, { k: 'mouth', v: s.mouth ?? null }, { k: 'handOff', v: 'all' }];
  for (const id of new Set([s.hands?.L, s.hands?.R].filter(Boolean))) ev.push({ k: 'hand', v: id });
  ev.push({ k: 'laptop', v: s.laptop || 'none' }, { k: 'wasted', v: !!s.wasted });
  return ev;
}
function makeBlueprint(t0, t1, name) {
  const dur = +(t1 - t0).toFixed(3);
  const events = App.events.filter(e => e.t >= t0 && e.t < t1).map(e => ({ t: +(e.t - t0).toFixed(3), k: e.k, v: e.v }));
  const tracks = {};
  for (const n of Object.keys(Tracks.data)) {
    const def = n === 'rhythm.strength' ? {percent:100} : n.startsWith('bone.') ? BONE_DEF : BOX_DEF, v0 = Tracks.eval(n, t0, def);
    const inside = Tracks.keys(n).filter(k => k.t >= t0 && k.t <= t1).map(k => ({ t: +(k.t - t0).toFixed(3), v: { ...k.v }, ease: k.ease }));
    const changed = JSON.stringify(v0) !== JSON.stringify(def);
    if (!inside.length && !changed) continue;
    // 片段开头已经不是默认值（前面有关键帧带过来的），补一个开头关键帧，部署后从同一个姿势开始
    if (changed && (!inside.length || inside[0].t > 0)) inside.unshift({ t: 0, v: v0, ease: 'step' });
    tracks[n] = inside;
  }
  const lines = [...events.map(e => ({ t: e.t, s: evLabel(e) })),
    ...Object.entries(tracks).flatMap(([n, K]) => K.map(k => ({ t: k.t, s: `${trackLabel(n)}：${n === 'rhythm.strength' ? k.v.percent+'%' : n.startsWith('bone.') ? fmtBone({ ...BONE_DEF, ...k.v }) : fmtBox({ ...BOX_DEF, ...k.v })}（${EASES[k.ease]?.label || k.ease}）` })))]
    .sort((a, b) => a.t - b.t).map(l => `${l.t.toFixed(2)}s  ${l.s}`);
  return {
    type: 'avatar_blueprint', version: 1, name: name || `片段 ${t0.toFixed(1)}–${t1.toFixed(1)}s`, duration: dur,
    source: { t0: +t0.toFixed(3), t1: +t1.toFixed(3), audio: App.audioName || null, psd: PSD_FILE }, created: new Date().toISOString(),
    startState: stateSnapshot(t0), events, tracks, summary: lines,
    notes: 't 为相对片段开头的秒数。events 的 k/v 和工程里的关键帧一样；tracks 是骨骼（bone.<骨骼>）和缩放框（hand.<手势>）的插值关键帧，ease 是插值方式。格式说明见 README「片段蓝图」。',
  };
}
function deployBlueprint(bp, T, { clear, withState }) {
  const t1 = T + bp.duration;
  if (clear) { App.events = App.events.filter(e => e.t < T || e.t >= t1); Tracks.clearRange(T, t1 + 1e-6); }
  if (withState && bp.startState) for (const e of snapshotEvents(bp.startState)) insertEvent({ t: +T.toFixed(3), ...e });
  for (const e of bp.events || []) insertEvent({ t: +(T + e.t).toFixed(3), k: e.k, v: e.v });
  for (const [n, K] of Object.entries(bp.tracks || {})) for (const k of K) Tracks.setKey(n, T + k.t, k.v, k.ease);
  if (t1 > App.duration && !App.audioBuf && !$('#exEnd').value) App.duration = Math.ceil(t1);
  renderEventList(); onTracksChanged();
  App.sel = { t0: T, t1 }; syncSelInputs();
  status(`已部署「${bp.name}」到 ${T.toFixed(2)}–${t1.toFixed(2)}s：${(bp.events || []).length} 个关键帧，${Object.keys(bp.tracks || {}).length} 条骨骼 / 缩放框轨道`);
}
function saveBps() { try { localStorage.setItem('avatarBlueprints', JSON.stringify(App.bps)); } catch (err) { status('蓝图存不进浏览器：' + err.message, true); } }
function addBp(bp) { App.bps.push(bp); saveBps(); renderBps(); }
function renderBps() {
  const box = $('#bpList');
  if (!App.bps.length) { box.innerHTML = '<span class="dim">还没有蓝图。选一段时间轴后点「记录选区」。</span>'; return; }
  box.replaceChildren(...App.bps.map((bp, i) => {
    const row = document.createElement('div'); row.className = 'bp';
    const info = document.createElement('div');
    info.innerHTML = `<b></b> <span class="dim">${bp.duration.toFixed(2)}s · ${(bp.events || []).length} 个关键帧 · ${Object.keys(bp.tracks || {}).length} 条轨道</span>`;
    info.querySelector('b').textContent = bp.name;
    const btn = (txt, fn, title) => { const b = document.createElement('button'); b.textContent = txt; b.onclick = fn; if (title) b.title = title; return b; };
    const ops = document.createElement('div'); ops.className = 'row';
    ops.append(
      btn('部署到当前时间', () => deployBlueprint(bp, App.t, { clear: $('#chkBpClear').checked, withState: $('#chkBpState').checked })),
      btn('下载', () => download(new Blob([JSON.stringify(bp, null, 1)], { type: 'application/json' }), `蓝图_${bp.name}.json`)),
      btn('复制', async () => { try { await navigator.clipboard.writeText(JSON.stringify(bp, null, 1)); status(`「${bp.name}」的 JSON 已复制，可以直接贴给 agent`); } catch (err) { status('复制失败：' + err.message, true); } }, '复制 JSON，贴给 agent 参考或修改'),
      btn('✕', () => { if (confirm(`删除蓝图「${bp.name}」？`)) { App.bps.splice(i, 1); saveBps(); renderBps(); } }));
    row.append(info, ops); return row;
  }));
}
function bindBlueprints() {
  try { App.bps = JSON.parse(localStorage.getItem('avatarBlueprints') || '[]'); } catch { App.bps = []; }
  const fromInputs = () => { const a = $('#selT0').value, b = $('#selT1').value; App.sel = a !== '' && b !== '' ? { t0: +a, t1: +b } : null; };
  $('#selT0').onchange = fromInputs; $('#selT1').onchange = fromInputs;
  $('#btnSelClear').onclick = () => { App.sel = null; syncSelInputs(); };
  $('#btnBpRecord').onclick = () => {
    if (!App.sel) { status('先在时间轴上按住 Shift 拖出一段，或者填起止时间', true); return; }
    const t0 = Math.min(App.sel.t0, App.sel.t1), t1 = Math.max(App.sel.t0, App.sel.t1);
    const bp = makeBlueprint(t0, t1, $('#bpName').value.trim());
    addBp(bp); $('#bpName').value = '';
    status(`已记录蓝图「${bp.name}」：${bp.events.length} 个关键帧，${Object.keys(bp.tracks).length} 条轨道`);
  };
  $('#fileBp').onchange = async e => { for (const f of e.target.files) importJSON(JSON.parse(await f.text())); e.target.value = ''; };
  renderBps();
}
function importJSON(o) {
  if (o && o.type === 'avatar_blueprint') { addBp(o); status(`已导入蓝图「${o.name}」`); }
  else loadProject(o);
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
  const G = [0, 255, 0], Wl = 250, B = 40;
  for (let pass = 2; pass <= 3; pass++) {   // 往外扩两圈，标成 2、3
    for (let q = 0; q < w * h; q++) {
      if (mask[q]) continue;
      const x = q % w, y = (q / w) | 0;
      if ((x > 0 && mask[q - 1] === pass - 1) || (x < w - 1 && mask[q + 1] === pass - 1) || (y > 0 && mask[q - w] === pass - 1) || (y < h - 1 && mask[q + w] === pass - 1)) mask[q] = pass;
    }
  }
  for (let q = 0; q < w * h; q++) {
    if (!mask[q]) continue;
    const t = mask[q] === 1 ? 1 : Math.min(1, Math.max(0, (lum(q) - B) / (Wl - B)));
    for (let k = 0; k < 3; k++) d[q * 4 + k] = Math.round(Math.min(255, Math.max(0, mask[q] === 1 ? G[k] : d[q * 4 + k] + t * (G[k] - Wl))));
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
    if (psd.layers.length !== RIG.expectedRecords) status(`PSD 有 ${psd.layers.length} 条图层记录，rig.js 按 ${RIG.expectedRecords} 条（${PSD_FILE}）写的：图层顺序可能变了，请到「图层」选项卡核对`, true);
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
  put(RIG.head, '头底色'); put(RIG.lens, '镜片白底'); put(RIG.laptop.layer, '电脑'); put(RIG.laptop.final, '电脑屏幕:FINAL 字'); put(RIG.body.mirror, '身体镜像版');
  put(RIG.wasted, 'WASTED 字');
  RIG.body.normal.forEach(i => put(i, '身体(抖动)')); RIG.neck.forEach(i => put(i, '下巴毛(抖动)'));
  RIG.face.forEach(i => put(i, '脸线稿(抖动)')); RIG.glasses.forEach(i => put(i, '眼镜线稿(抖动)'));
  for (const [side, poses] of Object.entries(RIG.ears)) for (const [k, a] of Object.entries(poses)) a.forEach(i => put(i, `${side === 'L' ? '左' : '右'}耳:` + (EAR_POSES.find(e => e.v === k) || {}).label + (a.length > 1 ? '(抖动)' : '')));
  for (const [k, e] of Object.entries(RIG.eyes)) { e.eye.forEach(i => put(i, '眼睛:' + e.label + (e.eye.length > 1 ? '(抖动)' : ''))); put(e.white, '眼底:' + e.label); }
  for (const [k, i] of Object.entries(RIG.mouths)) put(i, '嘴:' + (MOUTHS.find(m => m.v === k) || {}).label);
  for (const [k, a] of Object.entries(RIG.whiskers)) a.forEach(i => put(i, '胡子:' + (WHISKERS.find(f => f.v === k) || {}).label + (a.length > 1 ? '(抖动)' : '')));
  for (const [k, G] of Object.entries(HANDS)) for (const l of handLayers(G)) put(l, `手势(${G.side.map(s => (s === 'L' ? '左' : '右')).join('')}):${G.label}${G.isBody ? '（含衣服）' : ''}`);
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
    app: 'avatar_generator', version: 2, psd: PSD_FILE, audio: App.audioName, duration: App.duration,
    outputRange: { start: outputRange().start, end: $('#exEnd').value === '' ? null : outputRange().end }, settings: { ...S }, speedCurve: SpeedCurve.points, grade: Grade.toJSON(), events: App.events, tracks: Tracks.toJSON(),
    visemes: App.visemes ? LipSync.encode(App.visemes) : null,
  }, null, 1);
}
function loadProject(o) {
  lastTimelineState = null; App.history.length = 0;
  SpeedCurve.load(o.speedCurve);
  const s = o.settings ? { ...o.settings } : null;
  // 旧版 PSD（812 宽）的工程：电脑图层换了大小和位置，换算到新 PSD 上同一个位置
  if (s && !(o.version >= 2) && 'lapScale' in s) {
    const so = +s.lapScale;
    s.lapScale = +(so * 1.254).toFixed(3); s.lapX = Math.round(+s.lapX + so * 43.1 + 219); s.lapY = Math.round(+s.lapY - so * 58.3);
  }
  for (const side of ['L', 'R']) {
    for (const [key, fallback] of Object.entries(earDefaults[side])) {
      const input = $('#s_' + key);
      const value = s?.earCalibration?.[side]?.[key] ?? s?.[key];
      S.earCalibration[side][key] = Number.isFinite(value) ? clamp(value, +input.min, +input.max) : fallback;
    }
  }
  writeSettings({ rhythm: true, rhythmAmount: 100, rhythmBpm: 120, ...s });
  if (o.grade) Grade.load(o.grade);
  App.events = (o.events || []).slice().sort((a, b) => a.t - b.t);
  Tracks.load(o.tracks);
  if (o.visemes) App.visemes = LipSync.decode(o.visemes);
  if (o.duration > 0) App.duration = o.duration;
  $('#exStart').value = o.outputRange?.start ?? 0;
  $('#exEnd').value = o.outputRange?.end ?? '';
  pause(); seek(outputRange().start); fitTimeline();
  renderEventList(); onTracksChanged();
  status(`工程已载入：${App.events.length} 个关键帧，${Object.keys(Tracks.data).length} 条骨骼 / 缩放框轨道` + (o.audio && o.audio !== App.audioName ? `。记得载入配音 ${o.audio} 听效果` : ''));
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
  const fps = S.fps, {start:t0,end:t1} = outputRange();
  if (t1 <= t0) { status('输出终点须晚于起点',true); return; }
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
  if (App.events.length && confirm('新录一段：要清空现有的关键帧吗？\n（取消 = 保留）')) { App.events = []; renderEventList(); }
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
  } catch (err) { status('录音处理失败：' + err.message, true); console.error(err); App.duration = Math.max(1,App.t); }
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
function bindGradePresets() {
  const key = 'avatarGradePresets';
  const select = $('#gradePreset'), nameInput = $('#gradePresetName');
  const initialGrade = {
    filter: 'cyber', amount: 1,
    curves: {
      rgb: [[0,0],[1,1]],
      r: [[0,0],[0.27213525772094727,0.26302075386047363],[0.7955727577209473,0.796875],[1,1]],
      g: [[0,0],[1,1]],
      b: [[0,0],[0.24869775772094727,0.2890625],[0.8059892654418945,0.78125],[1,1]],
    },
  };
  function read() {
    const raw = localStorage.getItem(key);
    const stored = raw === null ? [] : JSON.parse(raw);
    if (stored.version === 2) return stored.items;
    const previous = raw === null ? [{ id: 'cyber', name: '自定义赛博曲线', grade: initialGrade }] : stored;
    return [{ id: 'final-reference', name: 'FINAL 截图校色', grade: screenshotGrade }, ...previous];
  }
  function render(items, selected) {
    select.replaceChildren(...items.map(item => new Option(item.name, item.id)));
    if (items.some(item => item.id === selected)) select.value = selected;
    if (!items.length) select.add(new Option('暂无模板', ''));
    select.disabled = $('#btnCustomGrade').disabled = $('#deleteGradePreset').disabled = !items.length;
  }
  function refresh() {
    try { render(read(), select.value); }
    catch (err) { status('无法读取本地色彩模板：' + err.message, true); }
  }
  function save(items, selected) {
    localStorage.setItem(key, JSON.stringify({ version: 2, items }));
    render(items, selected);
  }
  $('#addGradePreset').onclick = () => {
    const name = nameInput.value.trim();
    if (!name) { status('请先输入新模板名称', true); nameInput.focus(); return; }
    try {
      const items = read();
      if (items.some(item => item.name === name)) { status('已有同名色彩模板，请换个名称', true); return; }
      const id = crypto.randomUUID();
      save([...items, { id, name, grade: Grade.toJSON() }], id);
      nameInput.value = '';
      status('已保存色彩模板：' + name);
    } catch (err) { status('无法保存本地色彩模板：' + err.message, true); }
  };
  $('#btnCustomGrade').onclick = () => {
    try {
      const item = read().find(item => item.id === select.value);
      if (item) Grade.load(structuredClone(item.grade));
    } catch (err) { status('无法套用色彩模板：' + err.message, true); }
  };
  $('#deleteGradePreset').onclick = () => {
    try {
      const items = read(), item = items.find(item => item.id === select.value);
      if (item && confirm('删除本地色彩模板「' + item.name + '」？')) save(items.filter(entry => entry.id !== item.id));
    } catch (err) { status('无法删除本地色彩模板：' + err.message, true); }
  };
  window.addEventListener('storage', e => { if (!e.key || e.key === key) refresh(); });
  refresh();
}
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
  bindGradePresets();
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
// 右侧选项卡：记住上次打开的那个；Alt+1–6 切换
function showTab(name) {
  if (!$('#tab-' + name)) name = 'pose';
  App.tab = name;
  if (name === 'earLab') earLabStart = performance.now();
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const t of document.querySelectorAll('#panel .tab')) t.classList.toggle('on', t.id === 'tab-' + name);
  $('#view').classList.toggle('editing', name === 'bones');
  refreshEditors(true);
  try { localStorage.setItem('avatarTab', name); } catch {}
}
function bindTabs() {
  const btns = [...document.querySelectorAll('#tabs button')];
  btns.forEach((b, i) => { b.innerHTML += `<kbd>Alt+${i + 1}</kbd>`; b.onclick = () => showTab(b.dataset.tab); });
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const i = '1234567'.indexOf(e.key);
    if (i >= 0 && btns[i]) { e.preventDefault(); showTab(btns[i].dataset.tab); }
  });
  let last = null; try { last = localStorage.getItem('avatarTab'); } catch {}
  showTab(last || 'pose');
}

let earLabStart = 0;
function earLabTime(now) {
  const slider = $('#earLabTime');
  if ($('#earLabLoop').checked) {
    slider.value = ((now - earLabStart) * +$('#earLabRate').value / (2 * beatSeconds())) % 1400 - 200;
  }
  $('#earLabReadout').value = Math.round(+slider.value * 2 * beatSeconds()) + ' ms';
  return +slider.value;
}
function showEarCalibration() {
  const values = S.earCalibration[$('#earLabSide').value];
  for (const [key, value] of Object.entries(values)) {
    const input = $('#s_' + key);
    input.value = value;
    input.nextElementSibling.value = input.value;
  }
}
function bindEarLab() {
  const side = $('#earLabSide');
  side.onchange = showEarCalibration;
  showEarCalibration();
  const slider = $('#earLabTime'), loop = $('#earLabLoop'), rate = $('#earLabRate');
  slider.oninput = () => { loop.checked = false; };
  loop.onchange = rate.onchange = () => { earLabStart = performance.now() - (+slider.value + 200) * 2 * beatSeconds() / +rate.value; };
  for (const key of Object.keys(earDefaults.L)) {
    const input = $('#s_' + key);
    input.oninput = () => { S.earCalibration[side.value][key] = +input.value; input.nextElementSibling.value = input.value; };
  }
  $('#earLabReset').onclick = () => { S.earCalibration[side.value] = { ...earDefaults[side.value] }; showEarCalibration(); };
}
function bindUI() {
  bindEarLab(); bindSpeedCurve();
  buildButtons(); buildBoneUI(); buildBoxUI(); bindTabs(); renderEventList(); bindGrade(); bindBlueprints(); bindViewDrag();
  renderBoneKeys(); renderBoxKeys();
  $('#btnPlay').onclick = () => (App.playing ? pause() : play());
  $('#btnStart').onclick = () => seek(outputRange().start);
  $('#chkRec').onchange = e => { App.recording = e.target.checked; };
  $('#fitTime').onclick = fitTimeline;
  for (const [id,factor] of [['zoomIn',0.8],['zoomOut',1.25]]) {
    $('#'+id).onclick = () => { const span=+$('#inSpan').value; zoomTimeline(factor, App.view0+span/2,0.5); };
  }
  $('#liveClear').onclick = () => { App.live = { over: [], acts: [], bone: {}, box: {} }; markLive(); refreshEditors(true); };
  bindTimelineUndo();
  $('#keyRhythm').onclick = () => keyNow('rhythm.strength',{percent:clamp(+$('#keyRhythmValue').value,0,100)});
  renderRhythmKeys();
  $('#btnClearEv').onclick = () => { if (confirm('清空全部关键帧（包括骨骼和缩放框的）？')) { App.events = []; Tracks.data = {}; renderEventList(); onTracksChanged(); } };
  $('#btnSaveProj').onclick = () => download(new Blob([projectJSON()], { type: 'application/json' }), 'avatar_project.json');
  $('#fileProj').onchange = async e => { const f = e.target.files[0]; if (f) importJSON(JSON.parse(await f.text())); };
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
      else if (n.endsWith('.json')) importJSON(JSON.parse(await f.text()));
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
      const r = await fetch('../' + PSD_FILE);
      if (r.ok) { await loadPSD(await r.arrayBuffer(), PSD_FILE); return; }
    } catch {}
  }
  status(`请选择或拖入 ${PSD_FILE}`);
})();
