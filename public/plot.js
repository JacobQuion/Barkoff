// Minimal canvas charting: HiDPI-aware line plots with crosshair tooltips,
// and heatmaps with overlays. Colors come from CSS custom properties so the
// charts follow the page's tokens.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const FONT = '11px ui-monospace, "SF Mono", Menlo, monospace';
const PAD = { l: 44, r: 10, t: 10, b: 26 };

function setup(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: height };
}

export function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

function axes(ctx, { w, h, x, y, xMap, yMap }) {
  ctx.font = FONT;
  ctx.lineWidth = 1;
  ctx.strokeStyle = css('--grid');
  ctx.fillStyle = css('--muted');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of y.ticks || niceTicks(y.min, y.max, 4)) {
    const py = Math.round(yMap(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.l, py);
    ctx.lineTo(w - PAD.r, py);
    ctx.stroke();
    ctx.fillText((y.format || String)(v), PAD.l - 6, py);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of x.ticks || niceTicks(x.min, x.max, Math.max(2, Math.floor((w - PAD.l) / 70)))) {
    ctx.fillText((x.format || String)(v), xMap(v), h - PAD.b + 6);
  }
  if (y.label) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(y.label, PAD.l + 4, PAD.t);
    ctx.restore();
  }
}

function tooltipFor(canvas) {
  const wrap = canvas.parentElement;
  let tip = wrap.querySelector('.tip-box');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip-box';
    tip.hidden = true;
    wrap.appendChild(tip);
  }
  return tip;
}

// series: [{ name, color, xs, ys, width, dash, points }], ys entries may be null (gap)
export function linePlot(canvas, opts) {
  const { height = 160, x, y, series, vlines = [], hlines = [], format = {} } = opts;
  const { ctx, w, h } = setup(canvas, height);
  const xMap = (v) => PAD.l + ((v - x.min) / (x.max - x.min || 1)) * (w - PAD.l - PAD.r);
  const yMap = (v) => h - PAD.b - ((v - y.min) / (y.max - y.min || 1)) * (h - PAD.t - PAD.b);

  const draw = (hoverX) => {
    ctx.clearRect(0, 0, w, h);
    axes(ctx, { w, h, x, y, xMap, yMap });
    for (const hl of hlines) {
      ctx.save();
      ctx.strokeStyle = hl.color || css('--muted');
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(PAD.l, yMap(hl.y));
      ctx.lineTo(w - PAD.r, yMap(hl.y));
      ctx.stroke();
      ctx.fillStyle = css('--muted');
      ctx.font = FONT;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      if (hl.label) ctx.fillText(hl.label, w - PAD.r, yMap(hl.y) - 2);
      ctx.restore();
    }
    for (const vl of vlines) {
      ctx.save();
      ctx.strokeStyle = vl.color || css('--grid-strong');
      ctx.setLineDash(vl.dash || []);
      ctx.beginPath();
      ctx.moveTo(xMap(vl.x), PAD.t);
      ctx.lineTo(xMap(vl.x), h - PAD.b);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.l, PAD.t, w - PAD.l - PAD.r, h - PAD.t - PAD.b);
    ctx.clip();
    if (opts.under) opts.under(ctx, xMap, yMap);
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width || 2;
      ctx.lineJoin = 'round';
      ctx.setLineDash(s.dash || []);
      if (s.points) {
        for (let i = 0; i < s.xs.length; i++) {
          if (s.ys[i] == null) continue;
          ctx.beginPath();
          ctx.arc(xMap(s.xs[i]), yMap(s.ys[i]), s.points, 0, 2 * Math.PI);
          ctx.fill();
        }
        continue;
      }
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < s.xs.length; i++) {
        const v = s.ys[i];
        if (v == null || !Number.isFinite(v)) {
          pen = false;
          continue;
        }
        const px = xMap(s.xs[i]);
        const py = yMap(Math.max(y.min, Math.min(y.max, v)));
        if (pen) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.restore();
    if (hoverX != null) {
      ctx.strokeStyle = css('--grid-strong');
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xMap(hoverX), PAD.t);
      ctx.lineTo(xMap(hoverX), h - PAD.b);
      ctx.stroke();
    }
  };
  draw(null);

  const tip = tooltipFor(canvas);
  canvas.onpointermove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < PAD.l || px > w - PAD.r) {
      canvas.onpointerleave();
      return;
    }
    const xv = x.min + ((px - PAD.l) / (w - PAD.l - PAD.r)) * (x.max - x.min);
    const ref = series.find((s) => !s.noTip) || series[0];
    let best = 0;
    for (let i = 0; i < ref.xs.length; i++) if (Math.abs(ref.xs[i] - xv) < Math.abs(ref.xs[best] - xv)) best = i;
    const hx = ref.xs[best];
    draw(hx);
    const rows = series
      .filter((s) => !s.noTip)
      .map((s) => {
        let j = 0;
        for (let i = 0; i < s.xs.length; i++) if (Math.abs(s.xs[i] - hx) < Math.abs(s.xs[j] - hx)) j = i;
        const v = s.ys[j];
        return { name: s.name, color: s.color, v: v == null ? '—' : (format.y || ((n) => n.toFixed(1)))(v) };
      });
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = (format.x || ((n) => n.toFixed(2)))(hx);
    tip.appendChild(head);
    for (const r of rows) {
      const row = document.createElement('div');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = r.color;
      row.append(sw, `${r.name} `, Object.assign(document.createElement('b'), { textContent: r.v }));
      tip.appendChild(row);
    }
    tip.hidden = false;
    const left = Math.min(px + 12, w - tip.offsetWidth - 4);
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${PAD.t}px`;
  };
  canvas.onpointerleave = () => {
    tip.hidden = true;
    draw(null);
  };
}

// Heatmap of cols × rows cells; value(c, r) in [0, 1] mapped through ramp(v) → [r,g,b].
export function heatmap(canvas, opts) {
  const { height = 160, cols, rows, value, ramp, x, yTicks = [], overlay, tooltip } = opts;
  const { ctx, w, h } = setup(canvas, height);
  const plotW = w - PAD.l - PAD.r;
  const plotH = h - PAD.t - PAD.b;

  const img = ctx.createImageData(cols, rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [R, G, B] = ramp(value(c, r));
      const o = ((rows - 1 - r) * cols + c) * 4;
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    }
  }
  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  off.getContext('2d').putImageData(img, 0, 0);

  const xMap = (v) => PAD.l + ((v - x.min) / (x.max - x.min || 1)) * plotW;
  const rowMap = (r) => PAD.t + plotH - ((r + 0.5) / rows) * plotH; // fractional row → y
  const draw = (hover) => {
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = cols < plotW / 2 ? false : true;
    ctx.drawImage(off, PAD.l, PAD.t, plotW, plotH);
    ctx.font = FONT;
    ctx.fillStyle = css('--muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yTicks) ctx.fillText(t.label, PAD.l - 6, rowMap(t.row));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of niceTicks(x.min, x.max, Math.max(2, Math.floor(plotW / 70)))) ctx.fillText((x.format || String)(v), xMap(v), h - PAD.b + 6);
    if (overlay) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.l, PAD.t, plotW, plotH);
      ctx.clip();
      overlay(ctx, { colX: (c) => PAD.l + ((c + 0.5) / cols) * plotW, rowY: rowMap, top: PAD.t, bottom: PAD.t + plotH, css });
      ctx.restore();
    }
    if (hover) {
      ctx.strokeStyle = css('--fg');
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD.l + (hover.c / cols) * plotW, PAD.t + plotH - ((hover.r + 1) / rows) * plotH, plotW / cols, plotH / rows);
    }
  };
  draw(null);

  if (!tooltip) return;
  const tip = tooltipFor(canvas);
  canvas.onpointermove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const c = Math.floor(((px - PAD.l) / plotW) * cols);
    const r = Math.floor(((PAD.t + plotH - py) / plotH) * rows);
    if (c < 0 || c >= cols || r < 0 || r >= rows) {
      canvas.onpointerleave();
      return;
    }
    draw({ c, r });
    tip.textContent = tooltip(c, r);
    tip.hidden = false;
    tip.style.left = `${Math.max(4, Math.min(px + 12, w - tip.offsetWidth - 4))}px`;
    tip.style.top = `${PAD.t}px`;
  };
  canvas.onpointerleave = () => {
    tip.hidden = true;
    draw(null);
  };
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Piecewise-linear ramp through hex stops.
export function makeRamp(stops) {
  const rgb = stops.map(hexToRgb);
  return (v) => {
    const t = Math.min(1, Math.max(0, v)) * (rgb.length - 1);
    const i = Math.min(rgb.length - 2, Math.floor(t));
    return lerp(rgb[i], rgb[i + 1], t - i);
  };
}
