'use strict';

// x 为工程秒数，rate 为相对全局 BPM 的倍率。对平滑曲线积分得到动作时钟。
const MIN_SPEED = 0.5, MAX_SPEED = 1.25;
const SPEED_SPAN = MAX_SPEED - MIN_SPEED;
const SpeedCurve = {
  points: [{ t: 0, rate: 1 }],
  load(points) {
    const byTime = new Map([[0, 1]]);
    for (const p of Array.isArray(points) ? points : []) {
      if (p && Number.isFinite(p.t) && p.t >= 0 && Number.isFinite(p.rate))
        byTime.set(p.t, clamp(p.rate, MIN_SPEED, MAX_SPEED));
    }
    this.points = [...byTime].sort((a,b) => a[0] - b[0]).map(([t,rate]) => ({t,rate}));
  },
  sample(t) {
    let elapsed = 0, a = this.points[0];
    for (let i = 1; i < this.points.length; i++) {
      const b = this.points[i], span = b.t - a.t;
      if (t < b.t) {
        const u = (t - a.t) / span, delta = b.rate - a.rate;
        return { rate: a.rate + delta * u*u*(3-2*u),
          time: elapsed + span * (a.rate*u + delta*u*u*u*(1-u/2)) };
      }
      elapsed += span * (a.rate + b.rate) / 2;
      a = b;
    }
    return { rate: a.rate, time: elapsed + (t-a.t)*a.rate };
  },
};

function bindSpeedCurve() {
  const canvas = $('#speedCurve');
  let drag = null;
  function pointer(e) {
    const box = canvas.getBoundingClientRect(), view = App.tlView;
    const t = Math.max(0, view.t0 + (e.clientX-box.left)/box.width*view.span);
    const rate = clamp(MAX_SPEED - (e.clientY-box.top-6)/(box.height-12)*SPEED_SPAN, MIN_SPEED, MAX_SPEED);
    const hit = SpeedCurve.points.find(p =>
      Math.hypot((p.t-t)/view.span*box.width, (p.rate-rate)/SPEED_SPAN*(box.height-12)) <= 8);
    return { t, rate: Math.round(rate*100)/100, hit };
  }
  canvas.onpointerdown = e => {
    if (e.button !== 0 || !App.tlView) return;
    const { t,rate,hit } = pointer(e);
    drag = hit;
    if (!drag) {
      const time = +snapKeyTime(t).toFixed(3);
      drag = SpeedCurve.points.find(p => p.t === time);
      if (drag) drag.rate = rate;
      else { drag = {t:time,rate}; SpeedCurve.points.push(drag); SpeedCurve.points.sort((a,b)=>a.t-b.t); }
    }
    canvas.dataset.editRate = drag.rate;
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = e => {
    if (!drag) return;
    const { t,rate } = pointer(e), pts = SpeedCurve.points, i = pts.indexOf(drag);
    if (i < 0) return;
    if (i > 0) drag.t = clamp(+snapKeyTime(t, drag).toFixed(3), pts[i-1].t+.001, (pts[i+1]?.t ?? Infinity)-.001);
    drag.rate = rate;
    canvas.dataset.editRate = rate;
  };
  canvas.onlostpointercapture = () => { drag = null; delete canvas.dataset.editRate; recordTimelineEdit(); };
  canvas.oncontextmenu = e => {
    e.preventDefault();
    if (!App.tlView) return;
    const {hit} = pointer(e);
    if (hit && hit.t > 0) SpeedCurve.points.splice(SpeedCurve.points.indexOf(hit),1);
    else if (hit) hit.rate = 1;
    recordTimelineEdit();
  };
  $('#resetSpeed').onclick = () => { SpeedCurve.load([]); recordTimelineEdit(); };
}

function drawSpeedCurve() {
  const canvas = $('#speedCurve'), view = App.tlView;
  if (!view) return;
  const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w || h < 13) return;
  if (canvas.width !== Math.round(w*dpr) || canvas.height !== Math.round(h*dpr)) {
    canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr);
  }
  const ctx = canvas.getContext('2d'), x = t => (t-view.t0)/view.span*w, y = rate => 6+(MAX_SPEED-rate)/SPEED_SPAN*(h-12);
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
  ctx.fillStyle = '#404752'; ctx.fillRect(0,y(1),w,1);
  ctx.strokeStyle = '#70cfb8'; ctx.lineWidth = 2; ctx.beginPath();
  const pts = SpeedCurve.points;
  ctx.moveTo(x(0),y(pts[0].rate));
  for (let i=1;i<pts.length;i++) {
    const a=pts[i-1], b=pts[i], third=(b.t-a.t)/3;
    ctx.bezierCurveTo(x(a.t+third),y(a.rate),x(b.t-third),y(b.rate),x(b.t),y(b.rate));
  }
  ctx.lineTo(Math.max(w,x(pts.at(-1).t)),y(pts.at(-1).rate)); ctx.stroke();
  ctx.fillStyle = '#b6efe2';
  for (const p of pts) { ctx.beginPath(); ctx.arc(x(p.t),y(p.rate),4,0,Math.PI*2); ctx.fill(); }
  ctx.fillStyle = '#ff5a4e'; ctx.fillRect(x(App.t),0,1,h);
  const value = canvas.dataset.editRate ? +canvas.dataset.editRate : SpeedCurve.sample(App.t).rate;
  $('#speedReadout').value = value.toFixed(2)+'× · '+Math.round(S.rhythmBpm*value)+' BPM';
}
