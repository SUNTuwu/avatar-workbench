'use strict';
// 信号处理小工具：FFT、配音降噪。

// 原地复数 FFT，长度必须是 2 的幂
const fft = (() => {
  const cache = new Map();
  function tables(n) {
    let t = cache.get(n);
    if (!t) {
      const bits = Math.log2(n), rev = new Uint32Array(n), cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
      for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
      for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = -Math.sin(2 * Math.PI * i / n); }
      cache.set(n, t = { rev, cs, sn });
    }
    return t;
  }
  return function fft(re, im, inverse = false) {
    const n = re.length, { rev, cs, sn } = tables(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0; k < half; k++) {
          const wr = cs[k * step], wi = inverse ? -sn[k * step] : sn[k * step];
          const a = i + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };
})();

// 配音降噪：短时傅里叶变换 + 维纳滤波（判决引导法估计信噪比），噪声谱取整段里最安静的 15% 的帧。
// 适合风扇、电流声、底噪这类持续的噪声；键盘声、说话声这类突发的减不掉。
// reduceDb：噪声最多压低多少 dB（越大越干净，但人声也越容易发闷、出现“水声”）。输出单声道。
async function denoiseBuffer(ab, { reduceDb = 15, onProgress } = {}) {
  const sr = ab.sampleRate, len = ab.length, ch = ab.numberOfChannels;
  const x = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < len; i++) x[i] += d[i] / ch; }

  const N = sr > 24000 ? 1024 : 512, H = N / 4, NB = N / 2 + 1;
  const w = Float64Array.from({ length: N }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / N));
  const frames = Math.ceil((len + N) / H), s0 = i => i * H - N;
  const at = k => (k >= 0 && k < len ? x[k] : 0);
  const re = new Float64Array(N), im = new Float64Array(N);
  const spectrum = i => { const s = s0(i); for (let k = 0; k < N; k++) { re[k] = at(s + k) * w[k]; im[k] = 0; } fft(re, im); };

  // 1. 噪声谱
  const energy = new Float64Array(frames);
  for (let i = 0; i < frames; i++) { const s = s0(i); let e = 0; for (let k = 0; k < N; k++) { const v = at(s + k) * w[k]; e += v * v; } energy[i] = e; }
  const inside = Array.from(energy.keys()).filter(i => s0(i) >= 0 && s0(i) + N <= len);
  const pool = inside.length > 20 ? inside : Array.from(energy.keys());
  const quiet = pool.sort((a, b) => energy[a] - energy[b]).slice(0, Math.max(10, Math.floor(pool.length * 0.15)));
  const noise = new Float64Array(NB);
  for (const i of quiet) { spectrum(i); for (let k = 0; k < NB; k++) noise[k] += (re[k] * re[k] + im[k] * im[k]) / quiet.length; }
  for (let k = 0; k < NB; k++) noise[k] = noise[k] * 1.2 + 1e-12;

  // 2. 逐帧维纳增益，再重叠相加
  const gmin = Math.pow(10, -reduceDb / 20);
  const out = new Float32Array(len), wsum = new Float32Array(len);
  const prevS = new Float64Array(NB), G = new Float64Array(NB), Gs = new Float64Array(NB);
  for (let i = 0; i < frames; i++) {
    spectrum(i);
    for (let k = 0; k < NB; k++) {
      const P = re[k] * re[k] + im[k] * im[k], gamma = P / noise[k];
      const xi = 0.98 * prevS[k] / noise[k] + 0.02 * Math.max(gamma - 1, 0);
      G[k] = Math.max(gmin, xi / (1 + xi));
      prevS[k] = G[k] * G[k] * P;
    }
    for (let k = 0; k < NB; k++) Gs[k] = (G[Math.max(0, k - 1)] + 2 * G[k] + G[Math.min(NB - 1, k + 1)]) / 4;   // 频率上轻微平滑，减少“水声”
    for (let k = 0; k < NB; k++) { re[k] *= Gs[k]; im[k] *= Gs[k]; if (k && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; } }
    fft(re, im, true);
    const s = s0(i);
    for (let k = 0; k < N; k++) { const j = s + k; if (j >= 0 && j < len) { out[j] += re[k] * w[k]; wsum[j] += w[k] * w[k]; } }
    if (i % 400 === 0) { if (onProgress) onProgress(i / frames); await new Promise(r => setTimeout(r)); }
  }
  for (let j = 0; j < len; j++) out[j] = wsum[j] > 1e-3 ? out[j] / wsum[j] : 0;
  const res = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 1 });
  res.copyToChannel(out, 0);
  return res;
}
