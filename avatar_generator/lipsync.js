'use strict';
// 口型分析。每帧（约 32ms）做 FFT，减掉估计出来的噪声谱（降噪），然后：
//  · 用信噪比判断有没有在说话，带回差和保持时间，嘴不会在噪声边缘乱开乱合
//  · 3200Hz 以上能量占比大 → 擦音 s/sh/x，嘴型 i
//  · 干净频谱 → 自相关 → LPC → 共振峰 F1/F2 → 元音 a e o i u
// 离线（整段配音）和实时（麦克风）共用这套帧特征和口型判定。标签 a e o i u bf n，null = 没说话。

const LS = { SR: 11025, N: 352, NFFT: 512, ORDER: 12 };
LS.NB = LS.NFFT / 2 + 1;
LS.LO = Math.round(100 / LS.SR * LS.NFFT);    // 100Hz 以下（电流哼声、桌面震动）不算
LS.HI = Math.round(3200 / LS.SR * LS.NFFT);   // 3200Hz 以上算擦音能量
LS.GL = Math.round(250 / LS.SR * LS.NFFT);    // 说话开关只看 250–4000Hz：人声主要在这里，
LS.GT = Math.round(4000 / LS.SR * LS.NFFT);   //   风扇轰鸣、电流哼声主要在 250Hz 以下
LS.MINBIAS = 2.0;                             // 最小值统计的偏差补偿（最小值比平均噪声低约 3dB）
LS.FLOOR = 1e-5;                              // 噪声至少按最响人声的 -50dB 算，纯数字静音时不至于把一点点尾音当成说话
LS.alpha = nr => (nr > 0 ? 1 + nr / 10 : 0);   // 降噪强度 0–30 → 谱减过减系数
LS.hold = stable => 0.03 + 0.012 * (stable ?? 5);   // 防闪 0–10 → 新口型至少持续多久（秒）

const LipSync = {
  FPS: 60,

  async analyze(audioBuffer, opt = {}) {
    const mode = opt.mode || 'vowel', sens = opt.sens || 0, alpha = LS.alpha(opt.nr ?? 12), hold = LS.hold(opt.stable);
    const { SR, N, NB, LO } = LS;
    const off = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * SR), SR);
    const src = off.createBufferSource();
    src.buffer = audioBuffer; src.connect(off.destination); src.start();
    const x = (await off.startRendering()).getChannelData(0);

    const fps = this.FPS, hop = SR / fps, n = Math.ceil(audioBuffer.duration * fps), dt = 1 / fps;
    const A = new FrameAnalyzer();
    const Ps = new Float32Array(n * NB), tot = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const P = A.power(x, Math.round(i * hop) - N / 2);
      Ps.set(P, i * NB);
      let s = 0; for (let k = LO; k < NB; k++) s += P[k]; tot[i] = s;
    }
    // 噪声谱：最安静的 15% 帧的平均
    const quiet = Array.from(tot.keys()).sort((a, b) => tot[a] - tot[b]).slice(0, Math.max(5, Math.floor(n * 0.15)));
    const noise = new Float64Array(NB);
    for (const i of quiet) for (let k = 0; k < NB; k++) noise[k] += Ps[i * NB + k] / quiet.length;
    const peakTot = Array.from(tot).sort((a, b) => a - b)[Math.floor(n * 0.98)] || 0;
    applyFloor(noise, peakTot);

    const snr = new Float32Array(n), db = new Float32Array(n), hiR = new Float32Array(n), F1 = new Float32Array(n), F2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = A.features(Ps.subarray(i * NB, (i + 1) * NB), noise, alpha, mode === 'vowel');
      snr[i] = f.snr; db[i] = f.db; hiR[i] = f.hiRatio; F1[i] = f.F1; F2[i] = f.F2;
    }

    const gate = new SpeechGate(), speaking = new Uint8Array(n), energy = new Float32Array(n);
    for (let i = 0; i < n; i++) { speaking[i] = gate.step(snr[i], dt, sens) ? 1 : 0; energy[i] = gate.energy(snr[i], sens); }
    const fric = i => hiR[i] > 0.5;

    // 说话人归一化 (Lobanov)：本段所有元音帧的均值/标准差
    const idx = []; for (let i = 0; i < n; i++) if (speaking[i] && !fric(i) && F1[i] && F2[i]) idx.push(i);
    const stat = arr => { const m = arr.reduce((s, v) => s + v, 0) / arr.length; const sd = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length) || 1; return [m, sd]; };
    const [m1, s1] = idx.length > 10 ? stat(idx.map(i => F1[i])) : [550, 200];
    const [m2, s2] = idx.length > 10 ? stat(idx.map(i => F2[i])) : [1500, 500];
    const loud = idx.length ? idx.map(i => db[i]).sort((a, b) => a - b)[idx.length >> 1] : 0;
    // 共振峰前后各 2 帧取中值，去掉单帧跳变
    const med = (arr, i) => { const w = []; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n && arr[k]) w.push(arr[k]); w.sort((a, b) => a - b); return w.length ? w[w.length >> 1] : 0; };

    // 离线能看到整段，不需要实时那种「等一等再切」：逐帧直接判，后面用前后都看的平滑去闪
    const lab = new Labeler(), labels = new Array(n);
    for (let i = 0; i < n; i++) {
      const f1 = med(F1, i), f2 = med(F2, i);
      labels[i] = lab.step({
        speaking: !!speaking[i], fric: fric(i), quiet: db[i] < loud - 9,
        z: f1 && f2 ? [(f1 - m1) / s1, (f2 - m2) / s2] : null,
      }, dt, 0, mode, energy[i], 0.015);
    }
    const smoothed = modeFilter(labels, 2);
    mergeShort(smoothed, Math.round(hold * fps));
    return { fps, labels: smoothed, energy, duration: audioBuffer.duration, noiseDb: 10 * Math.log10(noise.reduce((s, v) => s + v, 0) / LS.NFFT + 1e-12) };
  },

  // 元音原型（归一化后的 F1, F2）；ie/ian 里的 e 和 ü 也归到相近的嘴型
  PROTOS: [['a', 1.9, -0.2], ['e', 0.0, -0.35], ['e', 0.5, 1.0], ['o', 0.15, -1.1], ['u', -0.9, -1.4], ['i', -1.1, 1.7], ['u', -1.1, 0.9]],
  dists(z1, z2) {
    const by = {}; let best = 'n', min = Infinity;
    for (const [v, p1, p2] of this.PROTOS) {
      const d = 1.3 * (z1 - p1) ** 2 + (z2 - p2) ** 2;
      if (!(v in by) || d < by[v]) by[v] = d;
      if (d < min) { min = d; best = v; }
    }
    return { best, min, by };
  },

  encode(v) { return { fps: v.fps, duration: v.duration, labels: v.labels.map(l => l === null ? '.' : l === 'bf' ? 'b' : l).join(''), energy: Array.from(v.energy, e => Math.round(e * 9)).join('') }; },
  decode(o) { return { fps: o.fps, duration: o.duration, labels: [...o.labels].map(c => c === '.' ? null : c === 'b' ? 'bf' : c), energy: Float32Array.from([...(o.energy || '')], c => +c / 9) }; },
};

// 单帧频谱特征
class FrameAnalyzer {
  constructor() {
    const { N, NFFT, NB, ORDER } = LS;
    this.win = Float64Array.from({ length: N }, (_, k) => 0.54 - 0.46 * Math.cos(2 * Math.PI * k / (N - 1)));
    this.re = new Float64Array(NFFT); this.im = new Float64Array(NFFT);
    this.P = new Float64Array(NB); this.C = new Float64Array(NB); this.r = new Float64Array(ORDER + 1);
    // 功率谱 → 自相关的余弦表（实信号功率谱对称，中间的点算两次）
    this.cos = Array.from({ length: ORDER + 1 }, (_, j) => Float64Array.from({ length: NB }, (_, k) => (k === 0 || k === NB - 1 ? 1 : 2) * Math.cos(2 * Math.PI * k * j / NFFT)));
  }
  // x[s0, s0+N) 这一帧（预加重 + 汉明窗）的功率谱；越界当 0
  power(x, s0) {
    const { N, NFFT, NB } = LS, re = this.re, im = this.im, at = k => (k >= 0 && k < x.length ? x[k] : 0);
    for (let k = 0; k < NFFT; k++) { re[k] = k < N ? (at(s0 + k) - 0.95 * at(s0 + k - 1)) * this.win[k] : 0; im[k] = 0; }
    fft(re, im);
    for (let k = 0; k < NB; k++) this.P[k] = re[k] * re[k] + im[k] * im[k];
    return this.P;
  }
  // 谱减降噪（alpha = 过减系数，0 = 不减），返回信噪比、响度、高频占比、共振峰
  features(P, noise, alpha, wantFormants, sr = LS.SR) {
    const { NB, LO, HI, ORDER } = LS, C = this.C;
    let ps = 0, ph = 0, gs = 0, gn = 0;
    for (let k = 0; k < NB; k++) {
      if (k < LO) { C[k] = 0; continue; }
      const c = Math.max(P[k] - alpha * noise[k], 0.02 * P[k]);
      C[k] = c; ps += c;
      if (k >= HI) ph += c;
      if (k >= LS.GL && k < LS.GT) { gs += P[k]; gn += noise[k]; }
    }
    let F1 = 0, F2 = 0;
    if (wantFormants) {
      for (let j = 0; j <= ORDER; j++) { let s = 0; const cs = this.cos[j]; for (let k = LO; k < NB; k++) s += C[k] * cs[k]; this.r[j] = s; }
      const a = levinson(this.r, ORDER);
      if (a) [F1, F2] = formants(a, sr);
    }
    // snr 用减噪前的人声频段：谱减会把弱的人声也减掉，拿它判断说话会漏字
    return { snr: 10 * Math.log10((gs + 1e-12) / (gn + 1e-12)), db: 10 * Math.log10(ps / LS.NFFT + 1e-12), hiRatio: ph / (ps + 1e-12), F1, F2 };
  }
}

// 噪声谱的下限：总量不低于 peakTot（最响的人声帧）的 -50dB
function applyFloor(noise, peakTot) {
  let s = 0; for (let k = LS.LO; k < LS.NB; k++) s += noise[k];
  const min = peakTot * LS.FLOOR;
  if (s < min) { const add = (min - s) / (LS.NB - LS.LO); for (let k = LS.LO; k < LS.NB; k++) noise[k] += add; }
}

// 说话开关：人声频段的信噪比超过「开」就张嘴，低于「关」之后再等 50ms 才闭，中间不会来回跳
// （这里的信噪比是 (人声+噪声)/噪声，安静时约 0dB）
class SpeechGate {
  constructor() { this.open = false; this.hold = 0; }
  limits(sens) { const on = 3.5 - 0.25 * (sens || 0); return [on, on - 1.5]; }
  step(snr, dt, sens) {
    const [on, off] = this.limits(sens);
    if (snr > on || (this.open && snr > off)) { this.open = true; this.hold = 0.05; }
    else if (this.open) { this.hold -= dt; if (this.hold <= 0) this.open = false; }
    return this.open;
  }
  energy(snr, sens) { return Math.min(1, Math.max(0, (snr - this.limits(sens)[1]) / 18)); }
}

// 逐帧定口型：共振峰平滑、元音回差、最短持续时间、句中短停顿算闭嘴
class Labeler {
  constructor() { this.label = null; this.cand = null; this.candT = 0; this.gapT = 0; this.z1 = 0; this.z2 = 0; this.fresh = true; }
  // smoothT：共振峰平滑的时间常数（实时 40ms；离线已经做了中值平滑，用很短的）
  step(f, dt, hold, mode, energy, smoothT = 0.04) {
    let raw = null;
    if (f.speaking) {
      if (mode === 'volume') raw = energy > 0.6 ? 'a' : energy > 0.3 ? 'e' : 'n';
      else if (f.fric) raw = 'i';
      else if (f.z) {
        const k = this.fresh ? 1 : Math.min(1, dt / smoothT);   // 刚开口时直接用当前值
        this.z1 += (f.z[0] - this.z1) * k; this.z2 += (f.z[1] - this.z2) * k; this.fresh = false;
        const d = LipSync.dists(this.z1, this.z2);
        raw = d.best;
        if (this.label in d.by && d.by[this.label] < d.min * 1.3) raw = this.label;   // 差不多的话不换嘴型
        if (raw === 'a' && f.quiet) raw = 'e';                                       // 小声时嘴张小一点
      } else raw = this.label && this.label !== 'bf' ? this.label : 'e';
    } else this.fresh = true;

    if (raw === null) { this.gapT += dt; if (this.label !== null && this.gapT < 0.08) raw = 'bf'; }   // 刚停下先抿嘴
    else this.gapT = 0;

    if (raw === this.label) this.cand = null;
    else if (raw === null || this.label === null) { this.label = raw; this.cand = null; }   // 开口、闭嘴马上切
    else {
      if (raw === this.cand) this.candT += dt; else { this.cand = raw; this.candT = dt; }
      if (this.candT >= hold) { this.label = raw; this.cand = null; }
    }
    return this.label;
  }
}

// 实时口型：每帧给最新一段采样（约 11025Hz，至少 353 点），返回当前口型。
// 噪声谱按频点跟踪：往下很快跟，往上很慢（说话时更慢），开麦后安静 0.5 秒就能估准。
class LiveLipSync {
  constructor() {
    this.A = new FrameAnalyzer(); this.gate = new SpeechGate(); this.lab = new Labeler();
    this.noise = new Float64Array(LS.NB); this.Ps = new Float64Array(LS.NB); this.t = 0; this.peakTot = 0;
    this.curMin = new Float64Array(LS.NB).fill(Infinity); this.ring = []; this.winT = 0;
    this.m1 = 550; this.s1 = 200; this.m2 = 1500; this.s2 = 500; this.loud = -30;
  }
  step(x, sr, dt, opt = {}) {
    const P = this.A.power(x, x.length - LS.N), noise = this.noise, Ps = this.Ps;
    this.t += dt;
    // 噪声谱用「最小值统计」：每个频点平滑后的功率在最近 1.5 秒里的最小值 × 偏差系数。
    // 说话时字与字之间总有空隙，所以说着话也能一直更新，不会因为一次判错卡死
    const a = Math.min(1, dt / 0.08);
    let tot = 0;
    for (let k = 0; k < LS.NB; k++) {
      Ps[k] = this.t === dt ? P[k] : Ps[k] + (P[k] - Ps[k]) * a;
      if (Ps[k] < this.curMin[k]) this.curMin[k] = Ps[k];
      if (k >= LS.LO) tot += P[k];
    }
    this.winT += dt;
    if (this.winT >= 0.25) { this.winT = 0; this.ring.push(this.curMin); if (this.ring.length > 6) this.ring.shift(); this.curMin = new Float64Array(LS.NB).fill(Infinity); }
    for (let k = 0; k < LS.NB; k++) {
      let m = this.curMin[k];
      for (const r of this.ring) if (r[k] < m) m = r[k];
      noise[k] = m === Infinity ? Ps[k] : m * LS.MINBIAS;
    }
    // 最响的人声慢慢回落（约每秒 -1dB），用来定噪声下限
    this.peakTot = Math.max(tot, this.peakTot * Math.pow(10, -dt / 10));
    applyFloor(noise, this.peakTot);
    const mode = opt.mode || 'vowel', sens = opt.sens || 0;
    const f = this.A.features(P, noise, LS.alpha(opt.nr ?? 12), mode === 'vowel', sr);
    const speaking = this.gate.step(f.snr, dt, sens), energy = this.gate.energy(f.snr, sens);
    const fric = f.hiRatio > 0.5;
    let z = null;
    if (speaking && !fric && f.F1 && f.F2) {
      const k = Math.min(1, dt / 4);           // 归一化统计约 4 秒的记忆
      this.m1 += (f.F1 - this.m1) * k; this.s1 = Math.max(60, this.s1 + (Math.abs(f.F1 - this.m1) * 1.25 - this.s1) * k);
      this.m2 += (f.F2 - this.m2) * k; this.s2 = Math.max(150, this.s2 + (Math.abs(f.F2 - this.m2) * 1.25 - this.s2) * k);
      this.loud += (f.db - this.loud) * k;
      z = [(f.F1 - this.m1) / this.s1, (f.F2 - this.m2) / this.s2];
    }
    const label = this.lab.step({ speaking, fric, z, quiet: f.db < this.loud - 9 }, dt, LS.hold(opt.stable), mode, energy);
    return { label, energy, snr: f.snr, warming: this.t < 0.5 };
  }
}

function levinson(r, p) {
  if (r[0] <= 1e-12) return null;
  r[0] *= 1.0001;
  const a = new Float64Array(p + 1); a[0] = 1;
  let e = r[0];
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e, prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    e *= 1 - k * k;
    if (e <= 0) return null;
  }
  return a;
}

// LPC 包络上找峰：第一个 250–1100Hz 的峰是 F1，之后 200Hz 以上、3200Hz 以内的第一个峰是 F2
function formants(a, sr) {
  const M = 200, fmax = 5000, H = new Float64Array(M);
  for (let m = 0; m < M; m++) {
    const w = 2 * Math.PI * (m * fmax / M) / sr;
    let re = 0, im = 0;
    for (let j = 0; j < a.length; j++) { re += a[j] * Math.cos(w * j); im -= a[j] * Math.sin(w * j); }
    H[m] = -Math.log(re * re + im * im + 1e-12);
  }
  let f1 = 0, f2 = 0;
  for (let m = 1; m < M - 1; m++) {
    if (!(H[m] > H[m - 1] && H[m] >= H[m + 1])) continue;
    const den = H[m - 1] - 2 * H[m] + H[m + 1];
    const f = (m + (den ? 0.5 * (H[m - 1] - H[m + 1]) / den : 0)) * fmax / M;
    if (!f1) { if (f >= 250 && f <= 1100) f1 = f; }
    else if (f > f1 + 200 && f <= 3200) { f2 = f; break; }
  }
  return [f1, f2];
}

function modeFilter(labels, r) {
  const out = labels.slice();
  for (let i = 0; i < labels.length; i++) {
    const c = new Map();
    for (let k = Math.max(0, i - r); k <= Math.min(labels.length - 1, i + r); k++) c.set(labels[k], (c.get(labels[k]) || 0) + 1);
    let best = labels[i], bc = c.get(best);
    for (const [v, k] of c) if (k > bc) { best = v; bc = k; }
    out[i] = best;
  }
  return out;
}

// 太短的口型并到前一段，避免嘴型闪烁
function mergeShort(labels, min) {
  for (let pass = 0; pass < 3; pass++) {
    let i = 0;
    while (i < labels.length) {
      let j = i; while (j < labels.length && labels[j] === labels[i]) j++;
      if (j - i < min && (i > 0 || j < labels.length)) {
        const fill = i > 0 ? labels[i - 1] : labels[j];
        for (let k = i; k < j; k++) labels[k] = fill;
      }
      i = j;
    }
  }
}
