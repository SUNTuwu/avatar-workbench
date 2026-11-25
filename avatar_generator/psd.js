'use strict';
// 最小 PSD 读取器：8 位 RGB，图层通道支持 raw / RLE / zip。
// 返回 { width, height, layers }，layers[i] 的 i 就是 PSD 里从下往上数的图层记录序号（组的起止标记也占一个号）。

async function readPSD(buf) {
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  let p = 0;
  const u8 = () => dv.getUint8(p++);
  const u16 = () => { const v = dv.getUint16(p); p += 2; return v; };
  const i16 = () => { const v = dv.getInt16(p); p += 2; return v; };
  const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };
  const i32 = () => { const v = dv.getInt32(p); p += 4; return v; };
  const ascii = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[p + i]); p += n; return s; };
  const skipBlock = () => { const n = u32(); p += n; };   // 不能写成 p += u32()：右边先读到旧的 p

  if (ascii(4) !== '8BPS') throw new Error('不是 PSD 文件');
  if (u16() !== 1) throw new Error('暂不支持 PSB 大文件格式');
  p += 6;
  u16();
  const height = u32(), width = u32(), depth = u16(), mode = u16();
  if (depth !== 8) throw new Error(`只支持 8 位/通道（这个文件是 ${depth} 位）`);
  if (mode !== 3) throw new Error('只支持 RGB 颜色模式');
  skipBlock();         // color mode data
  skipBlock();         // image resources
  u32(); u32();        // layer & mask section length, layer info length
  const count = Math.abs(i16());

  const layers = [];
  for (let i = 0; i < count; i++) {
    const L = { index: i, top: i32(), left: i32(), bottom: i32(), right: i32() };
    const nc = u16();
    L.channels = Array.from({ length: nc }, () => ({ id: i16(), len: u32() }));
    p += 4;
    L.blend = ascii(4);
    L.opacity = u8() / 255;
    L.clipping = u8();
    L.hidden = !!(u8() & 2);
    p += 1;
    const exLen = u32(), exEnd = p + exLen;
    skipBlock();       // layer mask
    skipBlock();       // blending ranges
    const nl = u8();
    L.name = new TextDecoder().decode(bytes.subarray(p, p + nl));
    p += nl + ((4 - ((nl + 1) % 4)) % 4);
    L.section = 0;
    while (p + 12 <= exEnd) {
      const sig = ascii(4);
      if (sig !== '8BIM' && sig !== '8B64') break;
      const key = ascii(4), len = u32(), st = p;
      if (key === 'luni') {
        const n = u32(); let s = '';
        for (let k = 0; k < n; k++) s += String.fromCharCode(u16());
        L.name = s;
      } else if (key === 'lsct' || key === 'lsdk') {
        L.section = u32();
      }
      p = st + len;
    }
    p = exEnd;
    layers.push(L);
  }

  for (const L of layers) {
    const w = L.right - L.left, h = L.bottom - L.top;
    const planes = {};
    for (const c of L.channels) {
      const end = p + c.len;
      if (c.len < 2) { p = end; continue; }
      const comp = u16();
      if (c.id < -1 || w <= 0 || h <= 0) { p = end; continue; }   // 跳过蒙版
      if (comp === 0) planes[c.id] = bytes.slice(p, p + w * h);
      else if (comp === 1) planes[c.id] = unpackRLE(w, h);
      else planes[c.id] = await inflate(bytes.subarray(p, end), comp === 3, w, h);
      p = end;
    }
    if (w > 0 && h > 0 && !L.section) toCanvas(L, planes, w, h);
  }

  // 组归属：记录是从下往上排的，组的结束标记(3)在下，组头(1/2)在上
  const stack = [[]];
  for (const L of layers) {
    if (L.section === 3) { stack.push([]); continue; }
    if (L.section === 1 || L.section === 2) {
      const kids = stack.length > 1 ? stack.pop() : [];
      for (const k of kids) if (!k.group) k.group = L.name;
      L.isGroup = true;
    }
    stack[stack.length - 1].push(L);
  }
  return { width, height, layers };

  function unpackRLE(w, h) {
    const counts = [];
    for (let r = 0; r < h; r++) counts.push(u16());
    const out = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      const e = p + counts[r];
      let o = r * w; const rowEnd = o + w;
      while (p < e) {
        const n = dv.getInt8(p++);
        if (n >= 0) { const m = Math.min(n + 1, rowEnd - o); out.set(bytes.subarray(p, p + m), o); o += m; p += n + 1; }
        else if (n !== -128) { const m = Math.min(1 - n, rowEnd - o); out.fill(bytes[p], o, o + m); o += m; p++; }
      }
      p = e;
    }
    return out;
  }
}

async function inflate(data, predict, w, h) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (predict) for (let r = 0; r < h; r++) for (let x = 1; x < w; x++) out[r * w + x] = (out[r * w + x] + out[r * w + x - 1]) & 255;
  return out;
}

// 拼成 RGBA 并裁掉透明边，绘制时只画有内容的区域
function toCanvas(L, planes, w, h) {
  const R = planes[0], G = planes[1], B = planes[2], A = planes[-1];
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  if (A) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (A[y * w + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  } else { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
  if (x1 < 0) return;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const img = new ImageData(cw, ch), d = img.data;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const s = (y0 + y) * w + x0 + x, k = (y * cw + x) * 4;
    d[k] = R ? R[s] : 0; d[k + 1] = G ? G[s] : 0; d[k + 2] = B ? B[s] : 0; d[k + 3] = A ? A[s] : 255;
  }
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  cv.getContext('2d').putImageData(img, 0, 0);
  Object.assign(L, { canvas: cv, x: L.left + x0, y: L.top + y0, w: cw, h: ch });
}
