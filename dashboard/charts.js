/* Tiny dependency-free chart helpers (HTML/SVG) so the dashboard also works inside a VS Code webview with a strict CSP. */
(function (root) {
  'use strict';

  const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmt(n, digits) {
    if (n === undefined || n === null || Number.isNaN(n)) return '–';
    if (typeof n !== 'number') return String(n);
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'k';
    return n.toLocaleString('en-US', { maximumFractionDigits: digits === undefined ? 2 : digits });
  }

  function legend(series) {
    return '<div class="legend">' + series.map((s, i) => `<span><i style="background:${s.color || COLORS[i % COLORS.length]}"></i>${esc(s.label)}</span>`).join('') + '</div>';
  }

  function none(text) {
    return `<div class="none">${esc(text || 'No data in this file')}</div>`;
  }

  /**
   * Horizontal (optionally stacked) bar chart.
   * rows: [{ label, values: number[] , text?: string }]; series: [{ label, color? }]
   */
  function hbar(el, rows, series, opts) {
    const o = opts || {};
    if (!rows.length || rows.every(r => r.values.every(v => !v))) { el.innerHTML = none(o.empty); return; }
    const max = Math.max(...rows.map(r => r.values.reduce((s, v) => s + (v || 0), 0))) || 1;
    let html = series.length > 1 ? legend(series) : '';
    html += '<div class="hbar">';
    for (const r of rows) {
      const total = r.values.reduce((s, v) => s + (v || 0), 0);
      const segs = r.values.map((v, i) => {
        const tip = `${series[i].label}: ${fmt(v)}`;
        return `<div class="seg" title="${esc(tip)}" style="width:${(100 * (v || 0)) / max}%;background:${series[i].color || COLORS[i % COLORS.length]}"></div>`;
      }).join('');
      html += `<div class="lbl" title="${esc(r.label)}">${esc(r.label)}</div><div class="track">${segs}</div><div class="val">${esc(r.text !== undefined ? r.text : fmt(total))}</div>`;
    }
    el.innerHTML = html + '</div>';
  }

  /** Simple key -> count map rendered as single-series hbar. */
  function countBars(el, map, opts) {
    const o = opts || {};
    const rows = Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, o.limit || 15).map(([label, v]) => ({ label, values: [v] }));
    hbar(el, rows, [{ label: o.label || 'count', color: o.color }], o);
  }

  /** Donut chart with legend. items: [{ label, value }] */
  function donut(el, items, opts) {
    const o = opts || {};
    const data = items.filter(i => i.value > 0);
    const total = data.reduce((s, i) => s + i.value, 0);
    if (!total) { el.innerHTML = none(o.empty); return; }
    const R = 60, r = 38, cx = 70, cy = 70;
    let a0 = -Math.PI / 2;
    let paths = '';
    data.forEach((d, i) => {
      const frac = d.value / total;
      const a1 = a0 + frac * Math.PI * 2;
      const color = d.color || COLORS[i % COLORS.length];
      if (frac >= 0.9999) {
        paths += `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" style="fill:none;stroke:${color};stroke-width:${R - r}"><title>${esc(d.label)}: ${fmt(d.value)}</title></circle>`;
      } else {
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (rad, ang) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
        paths += `<path d="M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z" style="fill:${color}"><title>${esc(d.label)}: ${fmt(d.value)} (${(frac * 100).toFixed(1)}%)</title></path>`;
      }
      a0 = a1;
    });
    const center = o.center !== undefined ? o.center : fmt(total);
    const svg = `<svg viewBox="0 0 140 140">${paths}<text x="70" y="74" text-anchor="middle" style="font-size:16px;fill:var(--fg);font-weight:600">${esc(center)}</text></svg>`;
    const leg = '<div class="stat-list">' + data.map((d, i) => `<div><i style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;background:${d.color || COLORS[i % COLORS.length]}"></i>${esc(d.label)}</div><div>${fmt(d.value)} <span class="muted">${((d.value / total) * 100).toFixed(0)}%</span></div>`).join('') + '</div>';
    el.innerHTML = `<div class="donut-wrap">${svg}${leg}</div>`;
  }

  /**
   * Stacked column chart over time with an optional line overlay on a secondary axis.
   * buckets: [{ t, ... }]; bars: [{ key, label, color? }]; line?: { key, label, color }
   */
  function columns(el, buckets, bars, opts) {
    const o = opts || {};
    if (!buckets.length) { el.innerHTML = none(o.empty); return; }
    const W = 1000, H = 240, padL = 50, padR = o.line ? 50 : 10, padT = 10, padB = 34;
    const iw = W - padL - padR, ih = H - padT - padB;
    const maxBar = Math.max(1, ...buckets.map(b => bars.reduce((s, s2) => s + (b[s2.key] || 0), 0)));
    const maxLine = o.line ? Math.max(1, ...buckets.map(b => b[o.line.key] || 0)) : 1;
    const bw = iw / buckets.length;
    let svg = '';
    for (let i = 0; i <= 4; i++) {
      const y = padT + ih - (ih * i) / 4;
      svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" /><text x="${padL - 6}" y="${y + 3}" text-anchor="end">${fmt((maxBar * i) / 4, 0)}</text>`;
      if (o.line) svg += `<text x="${W - padR + 6}" y="${y + 3}">${fmt((maxLine * i) / 4, 0)}</text>`;
    }
    const labelEvery = Math.ceil(buckets.length / 10);
    buckets.forEach((b, i) => {
      let y = padT + ih;
      const x = padL + i * bw + bw * 0.12;
      const w = Math.max(1, bw * 0.76);
      const tip = [o.formatX(b.t)].concat(bars.map(s => `${s.label}: ${fmt(b[s.key] || 0)}`)).concat(o.line ? [`${o.line.label}: ${fmt(b[o.line.key] || 0)}`] : []).join('\n');
      svg += `<g><title>${esc(tip)}</title><rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${ih}" fill="transparent" />`;
      bars.forEach((s, si) => {
        const h = (ih * (b[s.key] || 0)) / maxBar;
        y -= h;
        if (h > 0) svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" style="fill:${s.color || COLORS[si % COLORS.length]}" />`;
      });
      svg += '</g>';
      if (i % labelEvery === 0) svg += `<text x="${padL + i * bw + bw / 2}" y="${H - padB + 14}" text-anchor="middle">${esc(o.formatTick ? o.formatTick(b.t) : o.formatX(b.t))}</text>`;
    });
    if (o.line) {
      const pts = buckets.map((b, i) => `${padL + i * bw + bw / 2},${padT + ih - (ih * (b[o.line.key] || 0)) / maxLine}`).join(' ');
      svg += `<polyline points="${pts}" style="fill:none;stroke:${o.line.color};stroke-width:2" pointer-events="none" />`;
    }
    const series = bars.concat(o.line ? [o.line] : []);
    el.innerHTML = legend(series) + `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg>`;
  }

  /** Line chart for small series. points: [{ x, label, values: number[] }] (values in 0..1 when opts.percent) */
  function lines(el, points, series, opts) {
    const o = opts || {};
    if (!points.length) { el.innerHTML = none(o.empty); return; }
    const W = 600, H = 200, padL = 40, padR = 10, padT = 10, padB = 28;
    const iw = W - padL - padR, ih = H - padT - padB;
    const maxV = o.max || Math.max(1e-9, ...points.flatMap(p => p.values));
    const minV = o.min !== undefined ? o.min : 0;
    const x = i => padL + (points.length === 1 ? iw / 2 : (iw * i) / (points.length - 1));
    const y = v => padT + ih - (ih * (v - minV)) / (maxV - minV || 1);
    let svg = '';
    for (let i = 0; i <= 4; i++) {
      const v = minV + ((maxV - minV) * i) / 4;
      svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" /><text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${o.percent ? Math.round(v * 100) + '%' : fmt(v)}</text>`;
    }
    points.forEach((p, i) => { svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(p.label)}</text>`; });
    series.forEach((s, si) => {
      const color = s.color || COLORS[si % COLORS.length];
      svg += `<polyline points="${points.map((p, i) => `${x(i)},${y(p.values[si])}`).join(' ')}" style="fill:none;stroke:${color};stroke-width:2" />`;
      points.forEach((p, i) => { svg += `<circle cx="${x(i)}" cy="${y(p.values[si])}" r="3.5" style="fill:${color}"><title>${esc(`${s.label} @ ${p.label}: ${o.percent ? (p.values[si] * 100).toFixed(1) + '%' : fmt(p.values[si])}`)}</title></circle>`; });
    });
    el.innerHTML = legend(series) + `<div class="chart"><svg viewBox="0 0 ${W} ${H}">${svg}</svg></div>`;
  }

  /** columns: [{ key, label, num?, render?(row) }] */
  function table(el, cols, rows, opts) {
    const o = opts || {};
    if (!rows.length) { el.innerHTML = none(o.empty); return; }
    const head = '<tr>' + cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('') + '</tr>';
    const body = rows.map(r => '<tr>' + cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(c.num ? fmt(r[c.key]) : r[c.key])}</td>`).join('') + '</tr>').join('');
    el.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  function statList(el, pairs) {
    el.innerHTML = '<div class="stat-list">' + pairs.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('') + '</div>';
  }

  root.Charts = { hbar, countBars, donut, columns, lines, table, statList, fmt, esc, none, COLORS };
})(typeof self !== 'undefined' ? self : this);
