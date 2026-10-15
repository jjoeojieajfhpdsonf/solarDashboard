/* Solar-Dashboard – Frontend
   Widgets lassen sich unter "Anpassen" hinzufügen, entfernen, verschieben und in der Breite ändern.
   Layout und Einstellungen werden auf dem Server gespeichert. */
(() => {
  'use strict';

  // ---------- Helfer ----------
  const $ = (id) => document.getElementById(id);
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  // Inhalt nur ersetzen, wenn er sich geändert hat. iOS bricht sonst das Scrollen ab, wenn das Element
  // unter dem Finger alle paar Sekunden neu erzeugt wird.
  const setHTML = (el, html) => { if (el && el.__html !== html) { el.__html = html; el.innerHTML = html; } };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nf = (d) => new Intl.NumberFormat('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d });
  const f0 = nf(0), f1 = nf(1), f2 = nf(2);
  const kW = (w) => (w >= 10000 ? f1 : f2).format(w / 1000);
  const power = (w) => w == null ? '–' : w < 1000 ? `${f0.format(w)} W` : `${f2.format(w / 1000)} kW`;
  const kWh = (wh) => wh == null ? '–' : (Math.abs(wh) >= 100000 ? f0 : f1).format(wh / 1000);
  const kWhU = (wh) => wh == null ? '–' : `${kWh(wh)} kWh`;
  const pct = (x) => x == null || !isFinite(x) ? '–' : f0.format(x * 100);
  const chf = (x) => `CHF ${f2.format(x)}`;
  const addDaysStr = (day, n) => { const d = new Date(`${day || new Date().toISOString().slice(0, 10)}T12:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  // Netzbezug im Jahr eines Tages ("2024-05-03") oder Monats: mit automatischem Tarif der damalige Preis der Gemeinde
  const impAt = (day) => settings?.tariffByYear?.[String(day || '').slice(0, 4)] ?? settings?.tariffImport ?? 0;
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dateLong = (day) => new Date(day + 'T12:00:00').toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  // in der Datumsnavigation auf schmalen Bildschirmen kurz, z. B. "Fr., 9.10.2026"
  const dateNav = (day) => isWide() ? dateLong(day) : new Date(day + 'T12:00:00').toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' });

  async function api(path, opts) {
    const r = await fetch(path, { cache: 'no-store', ...opts });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // Erscheinungsbild: automatisch nach System, oder fest hell/dunkel (pro Gerät gespeichert)
  const isLight = () => document.documentElement.classList.contains('light');
  const themePref = () => { try { return localStorage.getItem('solar.theme') || 'auto'; } catch { return 'auto'; } };
  function applyTheme() {
    const p = themePref(), light = p === 'light' || (p === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.classList.toggle('light', light);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#F2F3F7' : '#0A0D18');
  }
  applyTheme();

  // Farben aus CSS
  let C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    C = { sun: v('--sun'), use: v('--use'), feed: v('--feed'), own: v('--own'), imp: v('--imp'), bat: v('--bat'), grid: v('--grid'), ink: v('--ink'), muted: v('--muted'), line: v('--line'), bg: v('--bg'), surface: v('--surface') };
    C.alpha = (col, a) => `color-mix(in srgb, ${col} ${Math.round(a * 100)}%, transparent)`;
    C.inv = [C.sun, '#C06A00', '#F3CF7A', '#8A5300', '#FFE0A0', '#A04800', '#E6B54D', '#6B3E00', '#FAD58C', '#D98A1C'];
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = C.muted;
    Chart.defaults.borderColor = C.line;
    Chart.defaults.scale.ticks.maxRotation = 0;
    Chart.defaults.animation.duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 400;
  }
  // Chart.js versteht color-mix nicht überall, deshalb echte rgba-Werte erzeugen
  const probe = document.createElement('canvas').getContext('2d');
  function rgba(col, a) {
    probe.fillStyle = '#000'; probe.fillStyle = col;
    const hex = probe.fillStyle;
    if (hex.startsWith('#')) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
    return hex.replace(/rgba?\(([^)]+)\)/, (_, p) => `rgba(${p.split(',').slice(0, 3).join(',')},${a})`);
  }

  const GRID_RED = '#E5574B'; // Strom vom Netz im Tagesverlauf: klar rot statt Koralle, damit er sich vom eigenen Strom abhebt
  const tooltipBase = () => ({
    backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(),
    titleColor: '#EEF1F6', bodyColor: '#EEF1F6', padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
  });
  // ausgeblendete Linien (Prognose, Soll aus) nicht durchgestrichen in der Legende zeigen, sondern weglassen
  const legendBase = () => ({ position: 'bottom', align: 'start', labels: { boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 3, padding: 14, filter: (it) => !it.hidden } });
  // ---------- Diagramme im iPhone-Stil (wie Apple Health und Aktien) ----------
  // Wird zentral auf jede Diagramm-Konfiguration angewendet (ctx.chart): Skala rechts, feine gestrichelte Hilfslinien,
  // keine Achsenlinien, wenige Beschriftungen, abgerundete Balken, Flächen mit Verlauf nach unten, Werte oben im Diagramm
  // und eine senkrechte Linie an der angetippten Stelle.
  // Wertanzeige weicht den Daten aus: liegen die angetippten Werte oben, steht sie unten im Diagramm, sonst oben;
  // waagrecht neben der senkrechten Linie, auf der Seite mit mehr Platz
  Chart.Tooltip.positioners.iosTop = function (items) {
    if (!items.length) return false;
    const ch = this.chart, a = ch.chartArea, sx = ch.scales.x;
    const bars = ch.config.data.datasets.some((d) => (d.type || ch.config.type) === 'bar');
    // bei Balken: Mitte des Tages (alle Balken dieses Tages) und eine halbe Balkenbreite Abstand, damit sie frei bleiben
    const x = bars && sx ? sx.getPixelForValue(items[0].index) : items[0].element.x;
    const gap = bars && sx ? (a.right - a.left) / Math.max(1, sx.max - sx.min + 1) / 2 + 6 : 8;
    const topY = Math.min(...items.map((i) => i.element.y).filter(Number.isFinite));
    const high = topY < a.top + (a.bottom - a.top) * 0.5, right = x > (a.left + a.right) / 2;
    return { x: x + (right ? -gap : gap), y: high ? a.bottom : a.top, xAlign: right ? 'right' : 'left', yAlign: high ? 'bottom' : 'top' };
  };
  // gewählten Balken merken (für das Abblenden der anderen) und nur bei Wechsel neu zeichnen
  Chart.register({
    id: 'iosActive',
    afterEvent(chart) {
      const a = chart.tooltip?.getActiveElements?.()[0]?.index ?? null;
      if (a !== chart.$iosActive && chart.config.data.datasets.some((d) => (d.type || chart.config.type) === 'bar')) { chart.$iosActive = a; chart.update('none'); }
    },
  });
  Chart.register({
    id: 'iosScrub',
    afterDatasetsDraw(chart) {
      const act = chart.tooltip?.getActiveElements?.() || [];
      if (!act.length || chart.config.type === 'doughnut') return;
      const { ctx: g, chartArea: a } = chart, x = act[0].element.x;
      g.save(); g.strokeStyle = isLight() ? 'rgba(20,28,48,.35)' : 'rgba(255,255,255,.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, a.top); g.lineTo(x, a.bottom); g.stroke(); g.restore();
    },
  });
  const fadeFill = (col) => (c) => {
    const a = c.chart.chartArea; if (!a || typeof col !== 'string') return col;
    const top = col.replace(/rgba\(([^)]+),\s*[\d.]+\)/, (_, p) => `rgba(${p},.42)`), g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
    g.addColorStop(0, top); g.addColorStop(1, col.replace(/rgba\(([^)]+),\s*[\d.]+\)/, (_, p) => `rgba(${p},0)`));
    return g;
  };
  function iosify(cfg) {
    const o = cfg.options ||= {}, type = cfg.type;
    if (type === 'doughnut' || type === 'pie') return cfg;
    // Markierung beim Darüberfahren springt sofort mit (sonst zieht sie eine Spur aus kleiner werdenden Punkten nach)
    o.transitions = { ...(o.transitions || {}), active: { animation: { duration: 0 } } };
    // Werte von 0 (z. B. Solar in der Nacht) bekommen keinen Punkt auf der Nulllinie
    for (const ds of cfg.data?.datasets || []) {
      if ((ds.type || type) !== 'line' || typeof ds.pointHoverRadius === 'function') continue;
      const r = ds.pointHoverRadius ?? 4;
      ds.pointHoverRadius = (c) => (Math.abs(c.parsed?.y ?? 1) < 0.005 ? 0 : r);
    }
    o.layout = { ...(o.layout || {}), padding: { top: 6, ...(o.layout?.padding || {}) } };
    const scales = o.scales ||= {};
    scales.x ||= {}; scales.y ||= {};
    for (const [k, sc] of Object.entries(scales)) {
      const isX = k === 'x' || sc.axis === 'x';
      sc.border = { display: false, dash: [3, 4], ...(sc.border || {}) };
      sc.grid = isX ? { display: false, ...(sc.grid || {}) } : { color: isLight() ? 'rgba(20,28,48,.08)' : 'rgba(255,255,255,.08)', drawTicks: false, ...(sc.grid || {}) };
      sc.ticks = { padding: 8, font: { size: 11 }, ...(isX ? { maxTicksLimit: 6 } : { maxTicksLimit: 5 }), ...(sc.ticks || {}) };
      if (!isX && sc.position == null) sc.position = 'right';
    }
    for (const ds of cfg.data?.datasets || []) {
      const t = ds.type || type;
      if (t === 'bar') {
        ds.maxBarThickness ??= 26; ds.borderWidth ??= 0; ds.categoryPercentage ??= 0.78; ds.barPercentage ??= 0.92;
        // beim Antippen: gewählter Balken voll, die anderen blass (wie Apple Health)
        const base = ds.backgroundColor;
        if (typeof base === 'string') ds.backgroundColor = (c) => { const a = c.chart.$iosActive; return a == null || c.dataIndex === a ? base : rgba(base, 0.35); };
      } else if (t === 'line') {
        ds.pointRadius ??= 0; ds.pointHoverRadius ??= 4; ds.pointHoverBorderWidth ??= 2; ds.pointHoverBackgroundColor ??= '#0A0D18';
        if (ds.tension == null || ds.tension < 0.3) ds.tension = 0.35;
        if (ds.fill === 'origin' && !ds.area && typeof ds.backgroundColor === 'string' && ds.backgroundColor.startsWith('rgba')) ds.backgroundColor = fadeFill(ds.backgroundColor);
      }
    }
    // gestapelte Balken: nur der oberste Abschnitt jedes Stapels oben abgerundet
    const bars = (cfg.data?.datasets || []).filter((d) => (d.type || type) === 'bar');
    const stackedBars = scales.y?.stacked || scales.x?.stacked;
    const lastOf = {};
    bars.forEach((d) => { lastOf[d.stack ?? '_'] = d; });
    for (const d of bars) d.borderRadius ??= !stackedBars ? 6 : d === lastOf[d.stack ?? '_'] ? { topLeft: 6, topRight: 6 } : 0;
    if (stackedBars) bars.forEach((d) => { d.borderSkipped ??= 'start'; });
    const pl = o.plugins ||= {};
    if (pl.tooltip !== false && pl.tooltip?.enabled !== false) pl.tooltip = { ...(pl.tooltip || {}), // Texte und Filter des Widgets bleiben, das Aussehen kommt von hier
      position: 'iosTop', caretSize: 0, cornerRadius: 12, padding: { x: 11, y: 8 },
      backgroundColor: isLight() ? 'rgba(255,255,255,.97)' : 'rgba(30,34,48,.96)', borderColor: isLight() ? 'rgba(20,28,48,.12)' : 'rgba(255,255,255,.1)', borderWidth: 1,
      titleColor: C.muted, titleFont: { size: 11.5, weight: '500' }, bodyColor: C.ink, bodyFont: { size: 13, weight: '600' },
      boxWidth: 8, boxHeight: 8, usePointStyle: true, boxPadding: 5,
    };
    if (pl.legend && pl.legend.display !== false) pl.legend = { ...pl.legend, labels: { ...(pl.legend.labels || {}), usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, padding: 14, font: { size: 11.5 } } };
    o.interaction ||= { mode: 'index', intersect: false };
    return cfg;
  }

  // Zusatzlinie ein- oder ausblenden, ohne das Diagramm neu zu laden
  function showLine(canvas, name, on) {
    const ch = Chart.getChart(canvas);
    if (!ch) return;
    ch.data.datasets.forEach((d, i) => { if ((d.name || d.label) === name) ch.setDatasetVisibility(i, on); });
    ch.update();
  }

  // ---------- Globaler Zustand ----------
  let state = null;
  let settings = null;
  let layout = [];
  const mounted = []; // { def, ctx, el }

  // Ertragsprognose, von mehreren Widgets genutzt; der Server holt sie alle 30 min neu
  let fcData = null, fcAt = 0;
  async function getForecast(force) {
    if (force || !fcData || Date.now() - fcAt > 5 * 60e3) { fcData = await api('/api/forecast').catch(() => null); fcAt = Date.now(); }
    return fcData;
  }

  // Tageszeit für den Schimmer der App (Farben in styles.css): morgens ab 30 min vor Sonnenaufgang bis 3 h danach,
  // abends ab 2 h vor Sonnenuntergang bis 45 min danach, dazwischen mittags, sonst Nacht. Ohne Prognose 7 und 19 Uhr.
  // Zum Ausprobieren: ?tageszeit=morgen|mittag|abend|nacht
  async function applyDaypart() {
    let part = { morgen: 'morning', mittag: 'day', abend: 'evening', nacht: 'night' }[new URLSearchParams(location.search).get('tageszeit')];
    if (!part) {
      const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
      const fd = (await getForecast().catch(() => null))?.days?.[state?.today?.day];
      const min = (t, def) => { const x = /^(\d{2}):(\d{2})/.exec(t || ''); return x ? Number(x[1]) * 60 + Number(x[2]) : def; };
      const rise = min(fd?.sunrise, 7 * 60), set = min(fd?.sunset, 19 * 60);
      part = m < rise - 30 || m >= set + 45 ? 'night' : m < rise + 180 ? 'morning' : m >= set - 120 ? 'evening' : 'day';
    }
    const r = document.documentElement;
    r.dataset.daypart = part;
    if (!r.classList.contains('daypart-fade')) requestAnimationFrame(() => requestAnimationFrame(() => r.classList.add('daypart-fade')));
  }

  // Auf schmalen Bildschirmen 15-Minuten-Mittel: mit 5-Minuten-Werten liegt etwa ein Messpunkt auf jedem Pixel
  const chartRes = () => isWide() ? 5 : 15;
  function coarsen(points, res) {
    if (res === 5) return points;
    const out = new Map();
    for (const p of points) {
      const m = Math.floor(p.m / res) * res;
      const e = out.get(m) || { m, n: 0, pv: 0, cons: 0, ns: 0, soc: 0, nb: 0, bat: 0, inv: null };
      e.n++; e.pv += p.pv; e.cons += p.cons;
      if (p.soc != null) { e.ns++; e.soc += p.soc; }
      if (p.bat != null) { e.nb++; e.bat += p.bat; }
      if (p.inv) { e.inv ??= []; p.inv.forEach((w, k) => { e.inv[k] = (e.inv[k] || 0) + w; }); }
      out.set(m, e);
    }
    return [...out.values()].map((e) => ({ m: e.m, pv: e.pv / e.n, cons: e.cons / e.n, soc: e.ns ? e.soc / e.ns : null, bat: e.nb ? e.bat / e.nb : null, inv: e.inv && e.inv.map((w) => w / e.n) }));
  }

  // Zeitachse eines Tagesdiagramms mit Zoom: mit der Maus waagrecht ziehen, auf dem Handy mit zwei Fingern aufziehen
  // oder kurz halten und ziehen (einfaches Wischen liest Werte ab). "Ganzer Tag" oder Doppelklick setzt zurück. Der Ausschnitt bleibt beim Blättern
  // zwischen Tagen erhalten, die Beschriftung wird feiner, je kleiner er ist.
  function dayZoom(ctx, canvas) {
    const z = { range: null };
    const btn = h('<button class="btn" type="button" hidden>Ganzer Tag</button>');
    ctx.tools.append(btn);
    const apply = () => {
      btn.hidden = !z.range;
      const ch = Chart.getChart(canvas);
      if (ch) { ch.options.scales.x.min = z.range?.[0]; ch.options.scales.x.max = z.range?.[1]; ch.update('none'); }
    };
    btn.onclick = () => { z.range = null; apply(); };
    z.axis = (res) => ({ grid: { display: false }, min: z.range?.[0], max: z.range?.[1], ticks: { autoSkip: false, maxRotation: 0, callback: function (v) {
      const hrs = (this.max - this.min + 1) * res / 60, narrow = this.chart.width < 520;
      const stepH = hrs > 12 ? (narrow ? 6 : 3) : hrs > 6 ? (narrow ? 2 : 1) : hrs > 3 ? (narrow ? 1 : 0.5) : 0.25;
      return v % Math.max(1, Math.round(stepH * 60 / res)) === 0 ? this.getLabelForValue(v) : null;
    } } });
    const box = canvas.parentElement, sel = h('<div class="brush" hidden></div>');
    box.append(sel);
    canvas.style.touchAction = 'pan-y';
    // Gesten: Maus = ziehen wählt den Bereich. Finger = wischen liest Werte ab (Tooltip folgt dem Finger);
    // Bereich wählen mit zwei Fingern (zwischen den Fingern) oder kurz halten und dann ziehen.
    const rel = (e) => e.clientX - box.getBoundingClientRect().left;
    const pts = new Map(); // aktive Finger
    let x0 = null, dragging = false, hold = 0, held = false;
    const show = (xa, xb) => {
      const area = Chart.getChart(canvas)?.chartArea; if (!area) return;
      const a = Math.max(area.left, Math.min(xa, xb)), b = Math.min(area.right, Math.max(xa, xb));
      sel.hidden = false;
      Object.assign(sel.style, { left: `${a}px`, width: `${Math.max(0, b - a)}px`, top: `${area.top}px`, height: `${area.bottom - area.top}px` });
    };
    const commit = (xa, xb) => {
      const sx = Chart.getChart(canvas)?.scales.x; if (!sx) return;
      const a = Math.round(sx.getValueForPixel(Math.min(xa, xb))), b = Math.round(sx.getValueForPixel(Math.max(xa, xb)));
      if (b - a >= 3) { z.range = [Math.max(sx.min, a), Math.min(sx.max, b)]; apply(); }
    };
    const stop = () => { x0 = null; dragging = false; held = false; clearTimeout(hold); sel.hidden = true; };
    const pair = () => [...pts.values()];
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      if (e.pointerType === 'mouse') { x0 = rel(e); dragging = false; return; }
      pts.set(e.pointerId, rel(e));
      if (pts.size === 2) { clearTimeout(hold); x0 = null; const [a, b] = pair(); show(a, b); return; }
      x0 = rel(e); held = false; clearTimeout(hold);
      hold = setTimeout(() => { held = true; navigator.vibrate?.(10); show(x0, x0 + 2); }, 380); // kurz halten: Auswahl beginnt
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') {
        if (pts.has(e.pointerId)) pts.set(e.pointerId, rel(e));
        if (pts.size === 2) { const [a, b] = pair(); show(a, b); return; }
        if (x0 == null) return;
        if (!held) { if (Math.abs(rel(e) - x0) > 8) clearTimeout(hold); return; } // gewischt statt gehalten: nur Werte ablesen
        show(x0, rel(e)); return;
      }
      if (x0 == null) return;
      const x = rel(e);
      if (!dragging && Math.abs(x - x0) > 12) { dragging = true; canvas.setPointerCapture(e.pointerId); }
      if (dragging) show(x0, x);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'mouse') {
        if (pts.size === 2) { const [a, b] = pair(); commit(a, b); pts.clear(); stop(); return; }
        pts.delete(e.pointerId);
        if (held && x0 != null) commit(x0, rel(e));
        stop(); return;
      }
      if (dragging && x0 != null) commit(x0, rel(e));
      stop();
    });
    canvas.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); stop(); });
    // während der Auswahl mit dem Finger nicht scrollen
    canvas.addEventListener('touchmove', (e) => { if (held || e.touches.length > 1) e.preventDefault(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { z.range = null; apply(); });
    return z;
  }

  // ---------- Widget-Bausteine ----------
  function segmented(options, value, onChange) {
    const el = h(`<div class="seg" role="group">${options.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === value}">${l}</button>`).join('')}</div>`);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onChange(b.dataset.v);
    });
    return el;
  }
  function selectEl(options, value, onChange, label) {
    const el = h(`<select class="sel" aria-label="${esc(label)}">${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }
  // Ein/Aus-Knopf für gestrichelte Zusatzlinien (Prognose, Soll), im Stil der übrigen Bedienelemente
  function checkbox(label, value, onChange) {
    const el = h(`<button type="button" class="chip" aria-pressed="${!!value}"><i aria-hidden="true"></i>${esc(label)}</button>`);
    el.addEventListener('click', () => { const on = el.getAttribute('aria-pressed') !== 'true'; el.setAttribute('aria-pressed', String(on)); onChange(on); });
    return el;
  }
  // Blättern mit ‹ ›; mit onPick öffnet das Datum einen eigenen Kalender (statt der Datumsauswahl des Browsers)
  function navigator_(onMove, onPick) {
    const el = h(`<div class="nav"><button type="button" aria-label="Zurück">‹</button><button type="button" class="lbl${onPick ? ' pick' : ''}"${onPick ? ' aria-haspopup="dialog"' : ' disabled'}><span></span></button><button type="button" aria-label="Weiter">›</button></div>`);
    const [prev, lbl, next] = el.querySelectorAll('button'), txt = lbl.querySelector('span');
    let current = null;
    prev.onclick = () => onMove(-1); next.onclick = () => onMove(1);
    if (onPick) lbl.onclick = () => datePicker(lbl, current, onPick);
    return { el, set(label, canPrev, canNext, date) {
      txt.textContent = label; prev.disabled = !canPrev; next.disabled = !canNext;
      if (date) current = date;
    } };
  }

  // Kalender im App-Stil: Tage nach Ertrag eingefärbt, gesperrt ausserhalb des Messzeitraums. Liegt im body,
  // damit ihn der Widget-Rahmen nicht abschneidet; schliesst mit Klick daneben, Esc oder nach der Auswahl.
  const monthCache = new Map();
  function datePicker(anchor, value, onPick) {
    document.querySelector('.dp')?.remove();
    const min = state?.firstDay || '2000-01-01', max = state?.today?.day || value;
    let ref = (value || max).slice(0, 7);
    const dp = h('<div class="dp" role="dialog" aria-label="Datum wählen"></div>');
    document.body.append(dp);
    const place = () => {
      const r = anchor.getBoundingClientRect(), w = dp.offsetWidth;
      dp.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
      dp.style.top = `${Math.min(r.bottom + 8, window.innerHeight - dp.offsetHeight - 8)}px`;
    };
    const close = () => { dp.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc); window.removeEventListener('scroll', close, true); };
    const outside = (e) => { if (!dp.contains(e.target) && !anchor.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    async function render() {
      const [y, m] = ref.split('-').map(Number);
      const first = (new Date(y, m - 1, 1).getDay() + 6) % 7, n = new Date(y, m, 0).getDate();
      dp.innerHTML = `<div class="dp-head"><button type="button" data-a="-1" aria-label="Vormonat" ${ref <= min.slice(0, 7) ? 'disabled' : ''}>‹</button>
        <b>${MONTHS[m - 1]} ${y}</b><button type="button" data-a="1" aria-label="Nächster Monat" ${ref >= max.slice(0, 7) ? 'disabled' : ''}>›</button></div>
        <div class="dp-grid">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => `<span class="dp-wd">${d}</span>`).join('')}${'<span></span>'.repeat(first)}${Array.from({ length: n }, (_, i) => {
          const day = `${ref}-${pad(i + 1)}`, off = day < min || day > max;
          return `<button type="button" data-d="${day}" ${off ? 'disabled' : ''} class="${day === value ? 'sel' : ''}${day === max ? ' today' : ''}"><i></i><em>${i + 1}</em></button>`;
        }).join('')}</div>
        <div class="dp-foot"><span>Je heller, desto mehr Ertrag</span><button type="button" data-d="${max}">Heute</button></div>`;
      place();
      // Erträge des Monats nachladen und als Helligkeit eintragen
      if (!monthCache.has(ref)) monthCache.set(ref, api(`/api/series?period=month&ref=${ref}`).then((s) => s.buckets).catch(() => []));
      const b = await monthCache.get(ref), top = Math.max(1, ...b.map((x) => x.yieldWh || 0));
      for (const x of b) { const cell = dp.querySelector(`[data-d="${x.key}"] i`); if (cell && x.yieldWh) cell.style.opacity = (0.08 + 0.5 * x.yieldWh / top).toFixed(2); }
    }
    dp.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn || btn.disabled) return;
      if (btn.dataset.a) { ref = shiftRef('month', ref, Number(btn.dataset.a)); render(); }
      if (btn.dataset.d) { close(); onPick(btn.dataset.d); }
    });
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    render();
  }

  // Periodenlogik (Monat / Jahr / Gesamt)
  function currentRef(period) {
    const d = state?.today?.day || new Date().toISOString().slice(0, 10);
    return period === 'month' ? d.slice(0, 7) : period === 'year' ? d.slice(0, 4) : null;
  }
  function shiftRef(period, ref, dir) {
    if (period === 'month') { let [y, m] = ref.split('-').map(Number); m += dir; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } return `${y}-${pad(m)}`; }
    if (period === 'year') return String(Number(ref) + dir);
    return null;
  }
  function refLabel(period, ref) {
    if (period === 'month') { const [y, m] = ref.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; }
    if (period === 'year') return ref;
    return 'Alle Jahre';
  }
  const fmtAxisKWh = (v) => `${f0.format(v / 1000)} kWh`;

  // Senkrechte Linie bei "jetzt" mit Punkten auf jeder sichtbaren Kurve (nur heute); Option index = Zeitschritt
  const nowMarker = {
    id: 'nowMarker',
    afterDatasetsDraw(chart, _, opt) {
      const i = opt?.index, a = chart.chartArea, x = i == null ? null : chart.scales.x.getPixelForValue(i);
      if (x == null || x < a.left || x > a.right) return;
      const g = chart.ctx;
      g.save();
      g.strokeStyle = isLight() ? 'rgba(20,28,48,.3)' : 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, a.top); g.lineTo(x, a.bottom); g.stroke(); g.setLineDash([]);
      chart.data.datasets.forEach((ds, k) => {
        const v = ds.data[i];
        if (ds.noDot || v == null || !chart.isDatasetVisible(k)) return;
        g.fillStyle = ds.dot ? ds.dot(v) : ds.borderColor; g.strokeStyle = '#0A0D18'; g.lineWidth = 2;
        // Position wie vom Chart gezeichnet (bei gestapelten Kurven die Oberkante, nicht der Einzelwert)
        const y = chart.getDatasetMeta(k).data[i]?.y ?? chart.scales.y.getPixelForValue(v);
        g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
      });
      g.restore();
    },
  };

  // Sonnenauf- und -untergang als kleine halbe Sonne auf der Nulllinie (Horizont), daneben die Uhrzeit
  const sunMarks = {
    id: 'sunMarks',
    // Platz unter der Zeitachse für Sonnenauf- und -untergang
    beforeLayout(chart, _, opt) {
      if (!opt?.rise && !opt?.set) return;
      const p = chart.options.layout.padding;
      chart.options.layout.padding = typeof p === 'object' ? { ...p, bottom: 12 } : { top: p || 0, left: p || 0, right: p || 0, bottom: 12 };
    },
    afterDatasetsDraw(chart, _, opt) {
      const a = chart.chartArea, g = chart.ctx, sun = getComputedStyle(document.documentElement).getPropertyValue('--sun').trim();
      const y = chart.scales.y.getPixelForValue(0);
      for (const [t, rise] of [[opt?.rise, true], [opt?.set, false]]) {
        if (!t || !opt.res) continue;
        const [hh, mm] = t.split(':').map(Number), x = chart.scales.x.getPixelForValue((hh * 60 + mm) / opt.res);
        if (x == null || x < a.left || x > a.right) continue;
        // Symbol und Uhrzeit zusammen direkt unter der Zeitachse, nicht über den Daten
        g.save();
        g.font = `500 11px ${Chart.defaults.font.family}`; g.textBaseline = 'middle'; g.textAlign = 'left';
        const label = `${rise ? '↑' : '↓'} ${t}`, tw = g.measureText(label).width, ty = chart.scales.x.bottom + 4, x0 = x - (tw + 13) / 2;
        g.fillStyle = sun; g.strokeStyle = sun; g.lineWidth = 1.1; g.lineCap = 'round';
        // Verbindung zur Stelle im Diagramm: Punkt auf der Nulllinie, gestrichelt hinunter bis kurz über die Beschriftung
        g.save(); g.globalAlpha = 0.55; g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, ty - 8); g.stroke(); g.restore();
        g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(x0 + 4, ty, 2.4, 0, Math.PI * 2); g.fill();
        for (let k = 0; k < 8; k++) {
          const w = (k * Math.PI) / 4;
          g.beginPath(); g.moveTo(x0 + 4 + Math.cos(w) * 3.8, ty + Math.sin(w) * 3.8); g.lineTo(x0 + 4 + Math.cos(w) * 5.2, ty + Math.sin(w) * 5.2); g.stroke();
        }
        g.fillText(label, x0 + 13, ty);
        g.restore();
      }
    },
  };

  // ---------- Wetter-Szene ----------
  // Regen und Schnee als einzelne Tropfen bzw. Flocken auf einem Canvas: unterschiedliche Länge, Tempo und
  // Helligkeit, leicht vom Wind schräg. Hält an, wenn das Widget nicht mehr im Dokument ist.
  function weatherFx(canvas, onBolt) {
    const g = canvas.getContext('2d');
    let kind = null, parts = [], raf = 0, w = 0, ht = 0, last = 0, strength = 1;
    // Gewitter: ab und zu ein verästelter Blitz am Rand, dazu ein kurzes Aufhellen des Himmels
    const flashEl = canvas.parentElement?.querySelector('.sky-flash');
    let bolt = null, nextBolt = 0;
    const makeBolt = (t) => {
      const side = Math.random() < 0.5 ? 0.12 + Math.random() * 0.2 : 0.68 + Math.random() * 0.2;
      const seg = (x, y, len, depth) => {
        const pts = [[x, y]];
        while (y < len) { x += (Math.random() - 0.5) * 26; y += 8 + Math.random() * 14; pts.push([x, y]); }
        const out = [{ pts, wd: depth ? 1 : 2.2 }];
        if (depth < 1) for (let i = 0; i < 2; i++) { const [bx, by] = pts[2 + Math.floor(Math.random() * (pts.length - 3))] || pts[0]; out.push(...seg(bx, by, by + 30 + Math.random() * 50, depth + 1)); }
        return out;
      };
      flashEl?.animate([{ opacity: 0 }, { opacity: 0.28 }, { opacity: 0.04 }, { opacity: 0.2 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
      onBolt?.();
      return { t0: t, lines: seg(w * side, -10, ht * (0.45 + Math.random() * 0.3), 0) };
    };
    const drawBolt = (t) => {
      if (!nextBolt) nextBolt = t + 1500 + Math.random() * 3000;
      if (!bolt && t >= nextBolt) bolt = makeBolt(t);
      if (!bolt) return;
      const age = (t - bolt.t0) / 1000;
      if (age > 0.7) { bolt = null; nextBolt = t + 4000 + Math.random() * 7000; return; }
      const a = age < 0.08 ? 1 : age < 0.14 ? 0.25 : age < 0.24 ? 0.9 : Math.max(0, 0.9 - (age - 0.24) * 2); // zweimal aufzucken, dann verblassen
      g.save(); g.shadowColor = isLight() ? 'rgba(90,70,200,.55)' : 'rgba(170,190,255,.9)'; g.shadowBlur = 16; g.lineJoin = 'round'; g.lineCap = 'round';
      for (const l of bolt.lines) {
        g.strokeStyle = isLight() ? `rgba(84,62,205,${a * (l.wd > 1 ? 1 : 0.7)})` : `rgba(240,244,255,${a * (l.wd > 1 ? 1 : 0.7)})`; // hell: dunkler Blitz, sonst unsichtbar g.lineWidth = l.wd;
        g.beginPath(); l.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      }
      g.restore();
    };
    const resize = () => {
      const r = canvas.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      w = r.width; ht = r.height; canvas.width = Math.round(w * d); canvas.height = Math.round(ht * d); g.setTransform(d, 0, 0, d, 0, 0);
    };
    const spawn = (y) => kind === 'snow'
      ? { x: Math.random() * w, y: y ?? Math.random() * ht, r: 0.8 + Math.random() * 2.2, v: 14 + Math.random() * 28, s: Math.random() * 6.28 }
      : { x: Math.random() * (w + 80) - 20, y: y ?? Math.random() * ht, l: (7 + Math.random() * 14) * (0.6 + strength * 0.4), v: (300 + Math.random() * 320) * (0.55 + strength * 0.45), a: 0.15 + Math.random() * 0.4 };
    const frame = (t) => {
      if (!canvas.isConnected || !kind) return;
      const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t;
      g.clearRect(0, 0, w, ht);
      for (const p of parts) {
        if (kind === 'snow') {
          p.y += p.v * dt; p.s += dt * 1.3; p.x += Math.sin(p.s) * 14 * dt;
          g.fillStyle = isLight() ? 'rgba(140,155,185,.9)' : 'rgba(240,244,255,.85)'; g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283); g.fill();
        } else {
          p.y += p.v * dt; p.x -= p.v * dt * 0.14;
          g.strokeStyle = isLight() ? `rgba(60,95,150,${Math.min(1, p.a + 0.2)})` : `rgba(175,205,255,${p.a})`; g.lineWidth = 1.1;
          g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + p.l * 0.14, p.y - p.l); g.stroke();
        }
        if (p.y - 30 > ht || p.x < -30) Object.assign(p, spawn(-20));
      }
      if (kind === 'storm') drawBolt(t);
      raf = requestAnimationFrame(frame);
    };
    return {
      resize() { resize(); },
      // strength: 0.4 Niesel, 1 Regen, 1.6 Starkregen, 1.9 Gewitter -> mehr, längere und schnellere Tropfen
      set(k, s = 1) {
        if (k === kind && s === strength) return;
        strength = s;
        kind = k; cancelAnimationFrame(raf); resize(); g.clearRect(0, 0, w, ht); bolt = null; nextBolt = 0;
        if (!k || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        parts = Array.from({ length: Math.round(k === 'snow' ? 80 * s : 110 * s) }, () => spawn());
        last = 0; raf = requestAnimationFrame(frame);
      },
    };
  }
  // WMO-Wettercode (Open-Meteo) -> Szene hinter dem Haus, z. B. "rain day" oder "clear night"
  function weatherScene(c) {
    const k = c.code >= 95 ? 'storm' : (c.code >= 71 && c.code <= 77) || c.code === 85 || c.code === 86 ? 'snow'
      : c.code >= 51 ? 'rain' : c.code === 45 || c.code === 48 ? 'fog' : c.code === 3 || c.cloud > 70 ? 'clouds' : 'clear';
    return `${k} ${c.isDay ? 'day' : 'night'}`;
  }
  const ic = (d) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const CLOUD = '<path d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z" stroke="#C9D2E6"/>';
  const CLOUD_UP = '<path d="M7 15h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 15z" stroke="#C9D2E6"/>';
  const WX_ICON = {
    'clear-day': ic('<circle cx="12" cy="12" r="4.2" stroke="#FFC23D"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" stroke="#FFC23D"/>'),
    'clear-night': ic('<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z" stroke="#E6E9F5"/>'),
    'clouds-day': ic('<circle cx="8" cy="8" r="3" stroke="#FFC23D"/>' + CLOUD),
    'clouds-night': ic(CLOUD),
    rain: ic(CLOUD_UP + '<path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3" stroke="#4CC3F5"/>'),
    storm: ic(CLOUD_UP + '<path d="M13 15l-2 4h3l-2 4" stroke="#FFC23D"/>'),
    snow: ic(CLOUD_UP + '<path d="M9 19v.01M13 21v.01M16 19v.01" stroke="#E6E9F5" stroke-width="2.6"/>'),
    fog: ic('<path d="M4 9h16M6 13h12M4 17h16" stroke="#C9D2E6"/>'),
  };

  // ---------- 3D-Haus (isometrisch) ----------
  // Weltkoordinaten in Metern: x nach rechts unten, y nach links unten, z nach oben; Projektion ins SVG (400 × 330)
  function houseSVG() {
    // Farben: dunkel wie gehabt; hell mit hellen Fassaden, Dach und Module bleiben dunkel
    const L = isLight();
    const HC = L ? { shadow: '#5A6480', front: '#E3E7EF', side: '#CDD3DF', gable: '#C2C9D7', door: '#8F99AE', roof: '#2E3549', ridge: '#454E66', win: '#9FB2D3' }
      : { shadow: '#03050A', front: '#2A3048', side: '#20253A', gable: '#1B2034', door: '#171C2D', roof: '#11152A', ridge: '#2A3150', win: '#2F3A5E' };
    const S = 18, OX = 200, OY = 104; // etwas kleiner, damit die Beschriftungen rundherum Platz haben
    const iso = (x, y, z) => [OX + (x - y) * 0.866 * S, OY + (x + y) * 0.5 * S - z * S];
    const pts = (list) => list.map((p) => iso(...p).map((v) => v.toFixed(1)).join(',')).join(' ');
    const poly = (list, fill, extra = '') => `<polygon points="${pts(list)}" fill="${fill}" ${extra}/>`;
    const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    // Haus 7 × 5 m, Wände 3 m, Firstdach entlang x; die vordere Dachfläche trägt die Module
    const W = 7, D = 5, H = 3, RIDGE = 5.1;
    const eave = (x) => [x, D + 0.35, H - 0.2], ridge = (x) => [x, D / 2, RIDGE];
    let s = '<defs><filter id="hglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
    // Kein sichtbarer Boden: nur ein weicher Schatten unter Haus und Geräten
    s += '<defs><filter id="hsoft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter></defs>';
    // bei Schnee: eine dünne, weich auslaufende Schneedecke am Boden (kein heller Boden, nur ein Hauch)
    const gnd = Array.from({ length: 28 }, (_, i) => { const t = (i / 28) * Math.PI * 2; return [W / 2 + 0.3 + Math.cos(t) * (W * 0.78), D / 2 + 0.5 + Math.sin(t) * (D * 0.95), 0]; });
    s += `<g class="hx-snow" aria-hidden="true">${poly(gnd, L ? '#FFFFFF' : '#DCE3EF', `opacity="${L ? '.6' : '.16'}" filter="url(#hsoft)"`)}</g>`;
    s += poly([[-1.2, -0.6, 0], [W + 1.8, -0.6, 0], [W + 1.8, D + 1.5, 0], [-1.2, D + 1.5, 0]], HC.shadow, `opacity="${L ? '.28' : '.55'}" filter="url(#hsoft)"`);
    // sichtbare Wände (vorne und rechts) und Giebel
    s += poly([[0, D, 0], [W, D, 0], [W, D, H], [0, D, H]], HC.front);
    s += poly([[W, 0, 0], [W, D, 0], [W, D, H], [W, 0, H]], HC.side);
    s += poly([[W, 0, H], [W, D, H], [W, D / 2, RIDGE]], HC.gable);
    // Fenster: tagsüber Glas, das den Himmel spiegelt; in Dämmerung und Nacht blendet darüber warmes Licht ein (nach Uhrzeit)
    s += `<defs><linearGradient id="wglass" x1="0" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="${L ? '#DCE5F4' : '#566A96'}"/>`
      + `<stop offset=".45" stop-color="${L ? '#AFC0DC' : '#34425F'}"/><stop offset="1" stop-color="${L ? '#8EA2C4' : '#232C45'}"/></linearGradient></defs>`;
    const win = (pp) => poly(pp, 'url(#wglass)', 'class="win"') + poly(pp, '#C9A35A', 'class="win-light"');
    for (const [y0, y1] of [[0.7, 1.9], [3.1, 4.3]]) s += win([[W, y0, 1.0], [W, y1, 1.0], [W, y1, 2.3], [W, y0, 2.3]]);
    s += poly([[1.0, D, 0], [2.1, D, 0], [2.1, D, 2.2], [1.0, D, 2.2]], HC.door);
    s += win([[2.9, D, 1.0], [4.1, D, 1.0], [4.1, D, 2.3], [2.9, D, 2.3]]);
    const sill = (pts4) => poly(pts4, L ? '#FFFFFF' : '#E3E9F4', 'stroke-linejoin="round" stroke-width="1.5" stroke="' + (L ? '#FFFFFF' : '#E3E9F4') + '"');
    s += `<g class="hx-snow" aria-hidden="true">${sill([[2.85, D, 0.98], [4.15, D, 0.98], [4.15, D + 0.14, 1.04], [2.85, D + 0.14, 1.04]])}`
      + [[0.7, 1.9], [3.1, 4.3]].map(([y0, y1]) => sill([[W, y0 - 0.05, 0.98], [W + 0.14, y0 - 0.05, 1.04], [W + 0.14, y1 + 0.05, 1.04], [W, y1 + 0.05, 0.98]])).join('') + '</g>';
    // Dach mit 6 × 2 Modulen
    const beave = (x) => [x, -0.35, H - 0.2]; // hintere Traufe
    s += poly([ridge(-0.35), ridge(W + 0.35), beave(W + 0.35), beave(-0.35)], HC.roof);
    s += poly([eave(-0.35), eave(W + 0.35), ridge(W + 0.35), ridge(-0.35)], HC.roof);
    s += poly([ridge(-0.35), ridge(W + 0.35), [W + 0.35, D / 2, RIDGE + 0.12], [-0.35, D / 2, RIDGE + 0.12]], HC.ridge);
    for (let c = 0; c < 6; c++) for (let r = 0; r < 2; r++) {
      const u0 = 0.25 + c * (W - 0.5) / 6 + 0.05, u1 = 0.25 + (c + 1) * (W - 0.5) / 6 - 0.05, v0 = 0.12 + r * 0.4, v1 = 0.48 + r * 0.4;
      const P = (u, v) => lerp(eave(u), ridge(u), v);
      s += poly([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], '#1D2E5C', 'class="panel" stroke="#3A5BA8" stroke-width=".6"');
    }
    // Wetter am Haus (per CSS ein- und ausgeblendet): nasses Dach bei Regen, Schnee auf dem Dach, Licht eines Blitzes
    const R = (u, v) => lerp(eave(u), ridge(u), v), up = (p, dz) => [p[0], p[1], p[2] + dz];
    // Regen: nasse Flächen glänzen, die Fassade wird dunkler, die Fenster spiegeln sich im nassen Boden,
    // Tropfen spritzen auf Dach und Boden und fallen von der Traufe
    const pt = (p) => iso(...p).map((x) => x.toFixed(1)).join(' ');
    const rnd = ((seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(7);
    const [rx1, ry1] = iso(...R(-0.35, 0.1)), [rx2, ry2] = iso(...R(W + 0.35, 0.9));
    let wet = `<defs><linearGradient id="wetg" gradientUnits="userSpaceOnUse" x1="${rx1.toFixed(1)}" y1="${ry1.toFixed(1)}" x2="${rx2.toFixed(1)}" y2="${ry2.toFixed(1)}">`
      + '<stop offset=".25" stop-color="#DCE6FF" stop-opacity="0"/><stop offset=".48" stop-color="#DCE6FF" stop-opacity=".2"/><stop offset=".56" stop-color="#DCE6FF" stop-opacity=".08"/><stop offset=".7" stop-color="#DCE6FF" stop-opacity="0"/></linearGradient>'
      + '<linearGradient id="wetr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC768" stop-opacity=".34"/><stop offset="1" stop-color="#FFC768" stop-opacity="0"/></linearGradient></defs>';
    // dunklere, nasse Fassade
    wet += poly([[0, D, 0], [W, D, 0], [W, D, H], [0, D, H]], '#000', 'opacity=".14"') + poly([[W, 0, 0], [W, D, 0], [W, D, H], [W, 0, H]], '#000', 'opacity=".14"');
    // Glanz über Dach und Module
    wet += `<g class="sheen">${poly([eave(-0.35), eave(W + 0.35), ridge(W + 0.35), ridge(-0.35)], 'url(#wetg)')}</g>`;
    // Spiegelung der Fenster im nassen Boden (vor der Front und rechts neben dem Haus), weich auslaufend
    const refl = (a, b, c, d) => `<path d="M${pt(a)} L${pt(b)} L${pt(c)} L${pt(d)} Z" fill="url(#wetr)" filter="url(#hsoft)"/>`;
    wet += refl([2.9, D + 0.1, 0], [4.1, D + 0.1, 0], [4.1, D + 1.6, 0], [2.9, D + 1.6, 0]);
    for (const [y0, y1] of [[0.7, 1.9], [3.1, 4.3]]) wet += refl([W + 0.1, y0, 0], [W + 0.1, y1, 0], [W + 1.6, y1, 0], [W + 1.6, y0, 0]);
    // Spritzer: kleine Ringe, die kurz aufgehen und verschwinden
    const splash = (p, i) => { const [x, y] = iso(...p); return `<ellipse class="splash" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="2.6" ry="1.1" style="animation-delay:-${(i * 0.37 % 1.6).toFixed(2)}s"/>`; };
    let k = 0;
    for (let i = 0; i < 12; i++) wet += splash(up(R(-0.1 + rnd() * (W + 0.2), 0.1 + rnd() * 0.8), 0.02), k++);
    for (let i = 0; i < 10; i++) wet += splash(rnd() < 0.55 ? [-0.8 + rnd() * (W + 1.5), D + 0.4 + rnd() * 1.2, 0] : [W + 0.3 + rnd() * 1.6, -0.4 + rnd() * (D + 0.6), 0], k++);
    // Tropfen fallen von der Traufe bis zum Boden
    for (let i = 0; i < 6; i++) {
      const u = 0.5 + i * (W - 1) / 5 + (rnd() - 0.5) * 0.4, [x0, y0] = iso(...eave(u)), [, y1g] = iso(u, D + 0.35, 0);
      wet += `<line class="drip" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x0.toFixed(1)}" y2="${(y0 + 3).toFixed(1)}" style="--fall:${(y1g - y0).toFixed(1)}px;animation-delay:-${(rnd() * 1.4).toFixed(2)}s"/>`;
    }
    s += `<g class="hx-wet" aria-hidden="true">${wet}</g>`;
    // Schnee: weiche Decke mit runden Kanten, die das Dach nicht ganz bis zum Rand bedeckt; vorne hängt sie wellig über die Traufe
    const SN = 0.12, su0 = -0.2, su1 = W + 0.2, sv0 = 0.05, sv1 = 0.96;
    const sp2 = (u, v, dz = 0) => iso(...up(R(u, v), SN + dz)).map((x) => x.toFixed(1)).join(' ');
    const snowTop = L ? ['#FFFFFF', '#E6EBF3'] : ['#F1F4FA', '#CDD6E7'], snowSide = L ? '#CBD3E2' : '#AEB9D0';
    const [nx1, ny1] = iso(...up(R(W / 2, sv1), SN)), [nx2, ny2] = iso(...up(R(W / 2, sv0), SN));
    let wave = `M${sp2(su0, sv0)}`;
    const N = 9;
    for (let i = 1; i <= N; i++) wave += ` L${sp2(su0 + (su1 - su0) * i / N, sv0)}`;
    wave += ` L${sp2(su1, sv0, -0.13)}`;
    for (let i = N - 1; i >= 0; i--) { // weiche Bögen nach unten: abwechselnd etwas tiefer
      const um = su0 + (su1 - su0) * (i + 0.5) / N, ue = su0 + (su1 - su0) * i / N;
      wave += ` Q ${sp2(um, sv0, i % 2 ? -0.3 : -0.24)} ${sp2(ue, sv0, -0.13)}`;
    }
    const bp = (u, v, dz = 0) => iso(...up(lerp(beave(u), ridge(u), v), SN + dz)).map((x) => x.toFixed(1)).join(' ');
    const snowBack = `<path d="M${bp(su1, 0.04)} L${bp(su1, 1)} L${bp(su1, 1, -0.1)} L${bp(su1, 0.04, -0.12)} Z" fill="${snowSide}" stroke="${snowSide}" stroke-width="2" stroke-linejoin="round"/>`
      + `<path d="M${bp(su0, 0.04)} L${bp(su1, 0.04)} L${bp(su1, 1)} L${bp(su0, 1)} Z" fill="${snowTop[1]}" stroke="${snowTop[1]}" stroke-width="4" stroke-linejoin="round"/>`;
    s += `<g class="hx-snow" aria-hidden="true">${snowBack}<defs><linearGradient id="snowg" gradientUnits="userSpaceOnUse" x1="${nx1.toFixed(1)}" y1="${ny1.toFixed(1)}" x2="${nx2.toFixed(1)}" y2="${ny2.toFixed(1)}">`
      + `<stop offset="0" stop-color="${snowTop[0]}"/><stop offset="1" stop-color="${snowTop[1]}"/></linearGradient></defs>`
      + `<path d="${wave} Z" fill="${snowSide}" stroke="${snowSide}" stroke-width="2" stroke-linejoin="round"/>`
      + `<path d="M${sp2(su1, sv0)} L${sp2(su1, sv1)} L${sp2(su1, sv1, -0.1)} L${sp2(su1, sv0, -0.13)} Z" fill="${snowSide}" stroke="${snowSide}" stroke-width="3" stroke-linejoin="round"/>`
      + `<path d="M${sp2(su0, sv0)} L${sp2(su1, sv0)} L${sp2(su1, sv1)} L${sp2(su0, sv1)} Z" fill="url(#snowg)" stroke="url(#snowg)" stroke-width="5" stroke-linejoin="round"/>`
      + `<path d="M${sp2(su0, 1, 0.1)} L${sp2(su1, 1, 0.1)}" stroke="${snowTop[0]}" stroke-width="6" stroke-linecap="round"/>`
      + '</g>';
    s += `<g class="hx-flash" aria-hidden="true">`
      + poly([[0, D, 0], [W, D, 0], [W, D, H], [0, D, H]], '#E8ECFF') + poly([[W, 0, 0], [W, D, 0], [W, D, H], [W, 0, H]], '#E8ECFF', 'opacity=".6"')
      + poly([[W, 0, H], [W, D, H], [W, D / 2, RIDGE]], '#E8ECFF', 'opacity=".6"') + poly([eave(-0.35), eave(W + 0.35), ridge(W + 0.35), ridge(-0.35)], '#E8ECFF')
      + '</g>';
    // Wechselrichter flach an der Front, wie eingebaut (einer pro Gerät, aneinander), in einer dunklen Fuge
    const IZ0 = 1.0, IZ1 = 1.7, IW = 0.5, DEP = 0.14, FY = D + DEP;
    const invX = (settings.inverterCount || 1) >= 2 ? [4.3, 4.3 + IW] : [4.5];
    const ix1 = invX.at(-1) + IW;
    const flat = (x0, x1, z0, z1, front, side, top) => poly([[x0 - 0.06, D + 0.005, z0 - 0.06], [x1 + 0.06, D + 0.005, z0 - 0.06], [x1 + 0.06, D + 0.005, z1 + 0.06], [x0 - 0.06, D + 0.005, z1 + 0.06]], '#141828')
      + poly([[x0, FY, z0], [x1, FY, z0], [x1, FY, z1], [x0, FY, z1]], front)
      + poly([[x1, D, z0], [x1, FY, z0], [x1, FY, z1], [x1, D, z1]], side)
      + poly([[x0, FY, z1], [x1, FY, z1], [x1, D, z1], [x0, D, z1]], top);
    const onFront = (x0, x1, z0, z1, fill, extra = '') => poly([[x0, FY + 0.005, z0], [x1, FY + 0.005, z0], [x1, FY + 0.005, z1], [x0, FY + 0.005, z1]], fill, extra);
    s += L ? flat(invX[0], ix1, IZ0, IZ1, '#B4BBC9', '#959DAE', '#C8CEDA') : flat(invX[0], ix1, IZ0, IZ1, '#D7DCE8', '#AEB6CA', '#EEF1F7'); // hell: grauer, sonst verschwinden sie auf der hellen Fassade
    for (const x0 of invX) {
      s += onFront(x0 + 0.1, x0 + IW - 0.1, IZ0 + 0.4, IZ0 + 0.54, '#2A3150'); // Display
      if (x0 > invX[0]) s += `<path d="M${pts([[x0, FY + 0.005, IZ0]])} L${pts([[x0, FY + 0.005, IZ1]])} L${pts([[x0, D, IZ1]])}" stroke="#9AA3B8" stroke-width=".8" fill="none"/>`; // Trennlinie
    }
    // Schneehaube: weiche Decke oben auf einem Kasten, mit Kante vorne und rechts
    const snowCap = (x0, x1, y0, y1, z) => {
      const t = L ? '#FFFFFF' : '#EEF2F9', e = L ? '#CDD5E3' : '#B8C2D7', h2 = 0.09, o = 0.04;
      const r = (pp, f) => poly(pp, f, `stroke="${f}" stroke-width="2" stroke-linejoin="round"`);
      return `<g class="hx-snow" aria-hidden="true">${r([[x0 - o, y1 + o, z], [x1 + o, y1 + o, z], [x1 + o, y1 + o, z + h2], [x0 - o, y1 + o, z + h2]], e)}`
        + r([[x1 + o, y0 - o, z], [x1 + o, y1 + o, z], [x1 + o, y1 + o, z + h2], [x1 + o, y0 - o, z + h2]], e)
        + r([[x0 - o, y0 - o, z + h2], [x1 + o, y0 - o, z + h2], [x1 + o, y1 + o, z + h2], [x0 - o, y1 + o, z + h2]], t) + '</g>';
    };
    // Batterie-Turm rechts neben dem Haus mit vier Zellen
    const bx0 = W + 0.6, bx1 = W + 1.6, by0 = D - 1.4, by1 = D - 0.5, bz = 2.1;
    let bat = poly([[bx0, by1, 0], [bx1, by1, 0], [bx1, by1, bz], [bx0, by1, bz]], '#E3E7F0');
    bat += poly([[bx1, by0, 0], [bx1, by1, 0], [bx1, by1, bz], [bx1, by0, bz]], '#B7BED0');
    bat += poly([[bx0, by0, bz], [bx1, by0, bz], [bx1, by1, bz], [bx0, by1, bz]], '#F3F5FA');
    for (let i = 0; i < 4; i++) bat += poly([[bx0 + 0.15, by1, 0.3 + i * 0.45], [bx1 - 0.15, by1, 0.3 + i * 0.45], [bx1 - 0.15, by1, 0.36 + i * 0.45], [bx0 + 0.15, by1, 0.36 + i * 0.45]], '#C9CFDD', `class="cell" data-i="${i}"`);
    bat += snowCap(bx0, bx1, by0, by1, bz);
    // Netzanschluss: Zählerkasten links vorne
    s += poly([[-1.0, D + 1.2, 0], [-0.3, D + 1.2, 0], [-0.3, D + 1.2, 1.4], [-1.0, D + 1.2, 1.4]], '#3A4260');
    s += poly([[-0.3, D + 0.7, 0], [-0.3, D + 1.2, 0], [-0.3, D + 1.2, 1.4], [-0.3, D + 0.7, 1.4]], '#2C3350');
    s += poly([[-1.0, D + 0.7, 1.4], [-0.3, D + 0.7, 1.4], [-0.3, D + 1.2, 1.4], [-1.0, D + 1.2, 1.4]], '#4A5374');
    s += snowCap(-1.0, -0.3, D + 0.7, D + 1.2, 1.4);
    // Flüsse: Dach -> Wechselrichter -> Haus, Batterie, Netz. Wie Kabel verlegt: auf Wand und Boden, im rechten Winkel
    // des Rasters, Ecken leicht gerundet. Die Punkte sind in Metern; die Projektion legt sie in die richtige Fläche.
    const P = (...p) => iso(...p).map((v) => v.toFixed(1)).join(' ');
    const cable = (...pp) => {
      const r = 0.3;
      let d = `M${P(...pp[0])}`;
      for (let i = 1; i < pp.length - 1; i++) {
        const a = pp[i - 1], c = pp[i], e = pp[i + 1];
        const la = Math.hypot(...c.map((v, k) => v - a[k])), le = Math.hypot(...e.map((v, k) => v - c[k]));
        d += ` L${P(...lerp(c, a, Math.min(r, la / 2) / la))} Q ${P(...c)} ${P(...lerp(c, e, Math.min(r, le / 2) / le))}`;
      }
      return `${d} L${P(...pp.at(-1))}`;
    };
    // Vom Wechselrichter hinunter und am Boden weiter: Haus (innen) zur Haustür, Netz (aussen) zum Zähler, Akku nach rechts
    const wy = D + 0.03, hy = D + 0.15, gy1 = D + 0.45, gy2 = D + 0.36, first = invX[0];
    const flows = {
      house: cable([first + 0.12, FY, IZ0], [first + 0.12, hy, 0.02], [1.55, hy, 0.02], [1.55, D + 0.01, 0.02], [1.55, D + 0.01, 0.6]),
      bat: cable([ix1 - 0.15, FY, IZ0], [ix1 - 0.15, gy2, 0.02], [bx0 + 0.5, gy2, 0.02], [bx0 + 0.5, by1, 0.02], [bx0 + 0.5, by1, 0.45]),
      grid: cable([first + 0.3, FY, IZ0], [first + 0.3, gy1, 0.02], [0.15, gy1, 0.02], [0.15, D + 0.95, 0.02], [-0.3, D + 0.95, 0.02], [-0.3, D + 0.95, 0.5]),
    };
    // Solar: kurz von der Dachkante senkrecht hinunter zum Wechselrichter
    invX.forEach((x0, i) => {
      const x = x0 + IW / 2;
      flows[i ? `pv${i + 1}` : 'pv'] = cable([x, wy, H - 0.25], [x, wy, IZ1]); // gerade an der Wand, direkt unter dem Dach
    });
    // Beschriftung mit Leitlinie vom Bauteil zum Text
    const tag = (key, anchor, tx, ty, align, label) => {
      const [ax, ay] = iso(...anchor);
      return `<path data-l="${key}" d="M${ax.toFixed(1)} ${ay.toFixed(1)} L${tx} ${ty + 4}" class="lead" style="stroke:rgb(var(--fg-rgb) / .2)" stroke-width="1" fill="none"/>
        <circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="2.2" style="fill:rgb(var(--fg-rgb) / .5)"/>
        <text data-t="${key}" x="${tx}" y="${ty}" text-anchor="${align}"><tspan class="tag-val" data-v="${key}">–</tspan><tspan class="tag-lbl" x="${tx}" dy="14">${label}</tspan><tspan class="tag-sub" data-s="${key}" x="${tx}" dy="14"></tspan></text>`;
    };
    s += `<g data-k="batTag">${bat}</g>`;
    s += Object.entries(flows).map(([k, d]) => `<path class="flowt" d="${d}"/><path class="flowp" data-f="${k}" d="${d}"/>`).join('');
    s += tag('pv', [2.0, 3.6, 4.2], 22, 34, 'start', 'SOLAR') + tag('house', [W, 1.2, 2.6], 360, 66, 'end', 'ZUHAUSE')
      + `<g data-k="batTagText">${tag('bat', [bx1, by1, 1.6], 378, 264, 'end', 'BATTERIE')}</g>` + tag('grid', [-0.65, D + 0.95, 1.4], 40, 286, 'start', 'NETZ');
    return s;
  }

  // ---------- Home-Widgets im iPhone-Stil ----------
  // Jedes Widget beantwortet eine Frage und kennt bis zu drei Grössen: s (1×1), m (2×1), l (2×2). ctx.size sagt welche.
  const MI = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
    bat: '<rect x="3" y="7" width="16" height="10" rx="2.5"/><path d="M21 10.5v3"/>',
    home: '<path d="M4 11.5 12 5l8 6.5M6 10v9h12v-9"/>',
    grid: '<path d="M12 3 7 21M12 3l5 18M8.6 9h6.8M7.6 14h8.8"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z"/>',
  };
  function miniBody(ctx, label, icon, color) {
    ctx.body.innerHTML = `<div class="mw"><p class="mw-k" style="--c:${color}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">${MI[icon]}</svg>${esc(label)}</p><div class="mw-c"></div></div>`;
    return ctx.body.querySelector('.mw-c');
  }
  // Aufteilung wie im Energiefluss: PV deckt zuerst das Haus, dann die Batterie, der Rest geht ins Netz
  function liveSplit(l) {
    const b = l.bat, chg = b ? b.charge : 0, dis = b ? b.discharge : 0;
    const self = Math.min(l.pv, l.cons), toBat = Math.min(chg, l.pv - self), feed = Math.max(l.pv - self - toBat, 0);
    const fromBat = Math.min(dis, l.cons - self), imp = Math.max(l.cons - self - fromBat, 0);
    return { chg, dis, self, toBat, feed, fromBat, imp };
  }
  // Tageskurve von heute für die kleinen Diagramme (15-Minuten-Werte), wird von allen Widgets geteilt
  let curve = null, curveAt = 0, curveReq = null;
  function todayCurve() {
    if (curve && Date.now() - curveAt < 4 * 60000) return Promise.resolve(curve);
    curveReq ||= api('/api/day').then((d) => {
      const c = { pv: new Array(96).fill(null), cons: new Array(96).fill(null), soc: new Array(96).fill(null) };
      for (const p of coarsen(d.points, 15)) { const i = p.m / 15; c.pv[i] = p.pv / 1000; c.cons[i] = p.cons / 1000; if (p.soc != null) c.soc[i] = p.soc; }
      curve = c; curveAt = Date.now(); return c;
    }).catch(() => curve).finally(() => { curveReq = null; });
    return curveReq;
  }
  // kleines Liniendiagramm über den ganzen Tag (96 Werte), optional gefüllt
  function sparkSVG(series, max) {
    const W = 192, H = 48, x = (i) => (i / 95 * W).toFixed(1), y = (v) => (H - 2 - Math.min(v, max) / max * (H - 4)).toFixed(1);
    let s = '';
    for (const { vals, color, fill } of series) {
      const segs = []; let cur = [];
      vals.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([i, v]); });
      if (cur.length) segs.push(cur);
      for (const g of segs) {
        const pts = g.map(([i, v]) => `${x(i)},${y(v)}`).join(' ');
        if (fill) s += `<polygon points="${x(g[0][0])},${H} ${pts} ${x(g.at(-1)[0])},${H}" fill="${color}" fill-opacity=".28"/>`;
        s += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      }
    }
    return `<svg class="mw-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${s}</svg>`;
  }
  const big = (v, u) => `<p class="mw-v">${v}<small>${u}</small></p>`;
  // bestes Zeitfenster mit Überschuss für ein Gerät: aus der Prognose (W je Stunde) minus Grundlast
  const DEVICES = [['Waschmaschine', 2], ['Geschirrspüler', 1.5], ['E-Auto', 4.1]];
  function bestWindow(fc, needKw, baseKw = 0.45) {
    const now = new Date(), nowH = now.getHours() + now.getMinutes() / 60;
    for (const [day, label] of [[fc?.today, 'Heute'], [fc?.tomorrow, 'Morgen']]) {
      const d = fc?.days?.[day]; if (!d) continue;
      const ok = d.hours.map((w, hh) => w / 1000 - baseKw >= needKw && (day !== fc.today || hh + 1 > nowH + 0.25));
      let best = null, cur = -1;
      ok.forEach((o, hh) => { if (o) { if (cur < 0) cur = hh; if (!best || hh - cur > best[1] - best[0]) best = [cur, hh]; } else cur = -1; });
      if (best) return { label, from: best[0], to: best[1] + 1, d, ok, isToday: day === fc.today };
    }
    return null;
  }

  const HOME_WIDGETS = {
    mode: {
      title: 'Aktueller Modus', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'day', type: 'day' },
      desc: 'Woher das Haus gerade seinen Strom bekommt.',
      mount(ctx) {
        const c = miniBody(ctx, 'Modus', 'bolt', 'var(--own)');
        ctx.update = () => {
          const l = state?.live; if (!l) return;
          const x = liveSplit(l);
          const mode = x.feed > 300 ? ['Überschuss', 'var(--feed)', 'Guter Moment für grosse Geräte'] : x.imp > 300 ? ['Netzbezug', 'var(--imp-bright)', 'Das Haus braucht mehr, als da ist']
            : x.fromBat > 15 ? ['Akku-Betrieb', 'var(--bat-bright)', 'Das Haus läuft mit dem Akku'] : x.toBat > 15 ? ['Akku lädt', 'var(--own)', 'Solarstrom geht in den Akku'] : ['Solarstrom', 'var(--own)', 'Das Haus läuft mit Sonne'];
          setHTML(c, `<p class="mw-mode"><i style="background:${mode[1]}"></i>${mode[0]}</p>`
            + (ctx.size === 'm' ? `<div class="mw-row mw-foot">${[['Solar', l.pv], ['Haus', l.cons], [x.feed > 15 ? 'Einspeisung' : 'Netz', x.feed > 15 ? x.feed : x.imp]].map(([k, w]) => `<div><p class="mw-s">${k}</p><p class="mw-v sm">${kW(w)}<small>kW</small></p></div>`).join('')}</div>` : ''));
        };
        ctx.update();
      },
    },
    soc: {
      title: 'Akku', mini: true, sizes: ['s', 'm', 'l'], size: 's', link: { tab: 'day', type: 'battery' },
      desc: 'Ladezustand, und wie lange er noch reicht.',
      mount(ctx) {
        const c = miniBody(ctx, 'Akku', 'bat', 'var(--own)');
        let cv = null;
        ctx.update = () => {
          const b = state?.live?.bat;
          if (!b) { setHTML(c, '<p class="mw-s">Kein Akku erkannt.</p>'); return; }
          const soc = Math.min(100, Math.max(0, b.soc)), cap = settings.batteryCapacity, n = Math.round(soc / 10);
          const hrs = (wh, w) => { const hh = wh / w; return hh >= 1 ? `${f0.format(Math.round(hh))} h` : `${f0.format(Math.max(5, Math.round(hh * 12) * 5))} min`; };
          const run = !cap ? '' : b.charge > 15 ? `Voll in ca. ${hrs(cap * (100 - soc) * 10, b.charge)}` : b.discharge > 15 ? `Reicht noch ca. ${hrs(cap * soc * 10, b.discharge)}` : '';
          const st = b.charge > 15 ? `Lädt mit ${power(b.charge)}` : b.discharge > 15 ? `Entlädt mit ${power(b.discharge)}` : 'Ruht';
          const segs = `<div class="segs">${Array.from({ length: 10 }, (_, i) => `<i class="${i < n ? (soc < 15 ? 'on low' : 'on') : ''}${b.charge > 15 && i === Math.min(9, n) ? ' now' : ''}"></i>`).join('')}</div>`;
          setHTML(c, big(f0.format(soc), cap ? `% · ${f1.format(cap * soc / 100)} kWh` : '%')
            + (ctx.size === 's' ? (run ? `<p class="mw-s">${run}</p>` : '') : `<p class="mw-s">${st}${run ? ` · ${run}` : ''}</p>`)
            + (ctx.size === 'l' && cv ? sparkSVG([{ vals: cv.soc, color: 'var(--bat)', fill: true }], 100) : '')
            + `<div class="mw-foot">${segs}</div>`);
        };
        ctx.refresh = async () => { if (ctx.size === 'l') { cv = await todayCurve(); ctx.update(); } };
        ctx.update(); ctx.refresh();
      },
    },
    solarNow: {
      title: 'Solar jetzt', mini: true, sizes: ['s', 'm', 'l'], size: 's', link: { tab: 'day', type: 'day' },
      desc: 'Aktuelle Produktion, im Verhältnis zur Anlagenleistung.',
      mount(ctx) {
        const c = miniBody(ctx, 'Solar', 'sun', 'var(--sun)');
        let cv = null;
        ctx.update = () => {
          const l = state?.live; if (!l) return;
          const share = state.kwp ? l.pv / (state.kwp * 1000) : null;
          const r = 15, C = 2 * Math.PI * r, ring = share == null ? '' : `<svg class="mw-ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="${r}" fill="none" style="stroke:rgb(var(--fg-rgb) / .1)" stroke-width="5"/><circle cx="20" cy="20" r="${r}" fill="none" stroke="var(--sun)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(C * Math.min(1, share)).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 20 20)"/></svg>`;
          const peak = cv ? Math.max(0, ...cv.pv.filter((v) => v != null)) : null;
          setHTML(c, `<div class="mw-split">${big(kW(l.pv), 'kW')}${ctx.size === 's' ? '' : ring}</div>`
            + `<p class="mw-s">${l.pv > 15 ? (share != null ? `${pct(share)} % der Leistung` : '') : 'Keine Produktion'}${ctx.size !== 's' && peak ? ` · Spitze heute ${f1.format(peak)} kW` : ''}</p>`
            + (ctx.size === 's' ? `<div class="mw-foot">${ring}</div>` : cv ? sparkSVG([{ vals: cv.pv, color: 'var(--sun)', fill: true }], Math.max(1, peak * 1.05)) : ''));
        };
        ctx.refresh = async () => { if (ctx.size !== 's') { cv = await todayCurve(); ctx.update(); } };
        ctx.update(); ctx.refresh();
      },
    },
    today: {
      title: 'Heute', mini: true, sizes: ['s', 'm', 'l'], size: 'm', link: { tab: 'day', type: 'day' },
      desc: 'Produziert, verbraucht, autark, und wie weit die Prognose erreicht ist.',
      mount(ctx) {
        const c = miniBody(ctx, 'Heute', 'sun', 'var(--sun)');
        let fc = null, cv = null;
        ctx.update = () => {
          const t = state?.today || {};
          const aut = t.coveredWh != null && t.consWh ? pct(t.coveredWh / t.consWh) : '–';
          const fd = fc?.days?.[fc.today];
          const bar = fd?.wh ? `<div class="mw-bar"><i style="width:${Math.min(100, (t.yieldWh || 0) / fd.wh * 100).toFixed(1)}%"></i></div><p class="mw-s">Prognose ca. ${kWhU(fd.wh)}</p>` : '';
          if (ctx.size === 's') { setHTML(c, big(kWh(t.yieldWh), 'kWh') + `<p class="mw-s">produziert · ${aut} % autark</p><div class="mw-foot">${bar}</div>`); return; }
          setHTML(c, `<div class="mw-row">${[[kWh(t.yieldWh), 'kWh', 'produziert'], [kWh(t.consWh), 'kWh', 'verbraucht'], [aut, '%', 'autark']].map(([v, u, k]) => `<div>${big(v, u).replace('mw-v', 'mw-v sm')}<p class="mw-s">${k}</p></div>`).join('')}</div>`
            + (ctx.size === 'l' && cv ? sparkSVG([{ vals: cv.pv, color: 'var(--sun)', fill: true }, { vals: cv.cons, color: 'var(--use)' }], Math.max(1, ...cv.pv.filter((v) => v != null), ...cv.cons.filter((v) => v != null))) : '')
            + `<div class="mw-foot">${bar}</div>`);
        };
        ctx.refresh = async () => { fc = await getForecast(); if (ctx.size === 'l') cv = await todayCurve(); ctx.update(); };
        ctx.update(); ctx.refresh();
      },
    },
    batEta: {
      title: 'Akku-Prognose', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'day', type: 'battery' },
      desc: 'Wann der Akku voll ist, oder nachts, wann er leer ist. Mit Wetterprognose und üblichem Verbrauch.',
      mount(ctx) {
        const c = miniBody(ctx, 'Akku', 'bat', 'var(--bat)'), k = ctx.body.querySelector('.mw-k');
        let fc = null, prof = null;
        ctx.update = () => {
          const l = state?.live;
          if (!l?.bat) { setHTML(c, '<p class="mw-s">Kein Akku erkannt.</p>'); return; }
          if (!prof) { setHTML(c, '<p class="mw-s">Wird berechnet…</p>'); return; }
          const r = batForecast(l, fc, prof);
          const est = r && !r.cap ? `<p class="mw-s mw-foot">Kapazität geschätzt: ca. ${f1.format(r.inPct * 0.095)} kWh</p>` : '';
          let head = 'Akku', html;
          if (!r) html = '<p class="mw-s">Noch zu wenig Messwerte für eine Prognose.</p>';
          else if (r.mode === 'full') { head = 'Akku'; html = big('Voll', '') + '<p class="mw-s">Der Akku ist geladen.</p>'; }
          else if (r.mode === 'idle') html = big(f0.format(l.bat.soc), '%') + '<p class="mw-s">Ruht gerade.</p>';
          else if (r.mode === 'charge' && r.full) { head = 'Akku voll'; html = big(`ca. ${clockIn(r.at)}`, 'Uhr') + `<p class="mw-s">in ${durText(r.at)}</p>`; }
          else if (r.mode === 'charge') { head = 'Akku heute'; html = big(`ca. ${f0.format(r.peak.soc)}`, '%') + `<p class="mw-s">wird nicht voll, höchstens um ${clockIn(r.peak.t)}</p>`; }
          else if (r.empty) { head = 'Akku leer'; html = big(`ca. ${clockIn(r.at)}`, 'Uhr') + `<p class="mw-s">in ${durText(r.at)}, bei ${r.low} %</p>`; }
          else if (r.mode === 'discharge' && !r.open) { head = 'Akku reicht'; html = big(`ca. ${clockIn(r.at)}`, 'Uhr') + `<p class="mw-s">bis die Sonne übernimmt, dann noch ca. ${f0.format(r.soc)} %</p>`; }
          else html = big(f0.format(l.bat.soc), '%') + '<p class="mw-s">Reicht länger als 36 h.</p>';
          if (k) k.lastChild.textContent = head;
          setHTML(c, html + (ctx.size === 'm' && r?.pts?.length > 2 ? socPathSVG(r.pts, 'var(--bat)') : '') + (ctx.size === 'm' ? est : ''));
        };
        ctx.refresh = async () => { [fc, prof] = await Promise.all([getForecast(), getProfile().catch(() => null)]); ctx.update(); };
        ctx.update(); ctx.refresh();
      },
    },
    tomorrow: {
      title: 'Morgen', mini: true, sizes: ['s', 'm', 'l'], size: 's', link: { tab: 'day', type: 'day' },
      desc: 'Ertragsprognose für morgen mit Wetter.',
      mount(ctx) {
        const c = miniBody(ctx, 'Morgen', 'cloud', 'var(--use)');
        let fc = null;
        const bars = (d, isToday) => {
          const hrs = d.hours.slice(6, 21), max = Math.max(1, ...hrs), nowH = new Date().getHours();
          return `<div class="mw-hours">${hrs.map((w, i) => `<i class="sun${isToday && i + 6 < nowH ? ' past' : ''}" style="height:${Math.max(4, w / max * 100).toFixed(0)}%"></i>`).join('')}</div>`;
        };
        ctx.update = () => {
          const m = fc?.days?.[fc.tomorrow], t = fc?.days?.[fc.today];
          if (!m) { setHTML(c, `<p class="mw-s">${fc?.enabled === false ? 'Standort in den Einstellungen eintragen.' : 'Keine Prognose.'}</p>`); return; }
          const sub = [m.weather, m.sunnyFrom != null ? `sonnig ab ${m.sunnyFrom} Uhr` : ''].filter(Boolean).join(', ');
          if (ctx.size === 'l' && t) {
            setHTML(c, `<div class="mw-two"><div><p class="mw-s">Heute</p>${big(`ca. ${kWh(t.wh)}`, 'kWh').replace('mw-v', 'mw-v sm')}${bars(t, true)}</div><div><p class="mw-s">Morgen</p>${big(`ca. ${kWh(m.wh)}`, 'kWh').replace('mw-v', 'mw-v sm')}${bars(m, false)}</div></div><p class="mw-s mw-foot">${esc(sub)}</p>`);
            return;
          }
          setHTML(c, big(`ca. ${kWh(m.wh)}`, 'kWh') + `<p class="mw-s">${esc(sub)}</p>` + (ctx.size === 'm' ? bars(m, false) : ''));
        };
        ctx.refresh = async () => { fc = await getForecast(); ctx.update(); };
        ctx.update(); ctx.refresh();
      },
    },
    month: {
      title: 'Monat', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'bal', type: 'target' },
      desc: 'Ertrag des laufenden Monats gegen das Soll.',
      mount(ctx) {
        const c = miniBody(ctx, 'Monat', 'cal', 'var(--sun)');
        ctx.update = () => {
          const p = state?.periods, tg = state?.yearTarget, day = state?.today?.day;
          if (!p?.month || !tg?.monthToDateWh) { setHTML(c, '<p class="mw-s">Soll-Werte fehlen noch.</p>'); return; }
          const diff = (p.month.yieldWh - tg.monthToDateWh) / tg.monthToDateWh;
          const name = MONTHS[Number(String(day || '').slice(5, 7)) - 1] || 'Monat';
          ctx.body.querySelector('.mw-k').lastChild.textContent = name;
          setHTML(c, big(kWh(p.month.yieldWh), 'kWh') + `<p class="mw-s"><span class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : '−'}${pct(Math.abs(diff))} %</span> zum Soll bis heute</p>`
            + (ctx.size === 'm' && tg.monthWh ? `<div class="mw-foot"><div class="mw-bar"><i style="width:${Math.min(100, p.month.yieldWh / tg.monthWh * 100).toFixed(1)}%"></i><b style="left:${Math.min(100, tg.monthToDateWh / tg.monthWh * 100).toFixed(1)}%"></b></div><p class="mw-s">von ${kWhU(tg.monthWh)} im ganzen Monat</p></div>` : ''));
        };
        ctx.update();
      },
    },
    gridNow: {
      title: 'Netz', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'day', type: 'day' },
      desc: 'Bezug oder Einspeisung jetzt, und die Summen von heute.',
      mount(ctx) {
        const c = miniBody(ctx, 'Netz', 'grid', 'var(--feed)');
        ctx.update = () => {
          const l = state?.live, t = state?.today || {}; if (!l) return;
          const x = liveSplit(l), feeding = x.feed > 15;
          setHTML(c, big(kW(feeding ? x.feed : x.imp), 'kW') + `<p class="mw-s" style="color:${feeding ? 'var(--feed)' : x.imp > 15 ? 'var(--imp-bright)' : 'var(--muted)'}">${feeding ? 'Einspeisung' : x.imp > 15 ? 'Bezug' : 'Kein Austausch'}</p>`
            + `<div class="mw-foot">${ctx.size === 'm' ? `<div class="mw-row two"><div><p class="mw-s">heute bezogen</p><p class="mw-v sm">${kWh(t.importWh)}<small>kWh</small></p></div><div><p class="mw-s">heute eingespeist</p><p class="mw-v sm">${kWh(t.feedWh)}<small>kWh</small></p></div></div>` : `<p class="mw-s">heute ${kWhU(t.feedWh)} eingespeist</p>`}</div>`);
        };
        ctx.update();
      },
    },
    window: {
      title: 'Bestes Zeitfenster', mini: true, sizes: ['s', 'm', 'l'], size: 'm', link: { tab: 'day', type: 'day' },
      desc: 'Wann der Überschuss für Waschmaschine, Geschirrspüler oder E-Auto reicht.',
      mount(ctx) {
        const c = miniBody(ctx, 'Bestes Zeitfenster', 'clock', 'var(--own)');
        let fc = null;
        ctx.update = () => {
          const dev = DEVICES.find(([n]) => n === ctx.opts.device) || DEVICES[0];
          const w = fc ? bestWindow(fc, dev[1]) : null;
          if (!fc) { setHTML(c, '<p class="mw-s">Prognose wird geladen…</p>'); return; }
          if (!fc.enabled) { setHTML(c, '<p class="mw-s">Standort in den Einstellungen eintragen.</p>'); return; }
          const head = w ? big(`${pad(w.from)}–${pad(w.to)}`, 'Uhr') + `<p class="mw-s">${w.label} · ${dev[0]} (${f1.format(dev[1])} kW)</p>` : big('–', '') + `<p class="mw-s">Heute und morgen reicht der Überschuss nicht für ${dev[0]}.</p>`;
          let bars = '';
          if (w && ctx.size !== 's') {
            const nowH = new Date().getHours();
            bars = `<div class="mw-hours">${w.d.hours.slice(6, 21).map((v, i) => { const hh = i + 6, max = Math.max(1, ...w.d.hours); return `<i class="${hh >= w.from && hh < w.to ? 'best' : w.ok[hh] ? 'ok' : ''}${w.isToday && hh < nowH ? ' past' : ''}" style="height:${Math.max(4, v / max * 100).toFixed(0)}%"></i>`; }).join('')}</div>`;
          }
          const seg = ctx.size === 'l' ? `<div class="mw-devs">${DEVICES.map(([n]) => `<button type="button" data-dev="${n}" aria-pressed="${n === dev[0]}">${n}</button>`).join('')}</div>` : '';
          setHTML(c, head + seg + `<div class="mw-foot">${bars}</div>`);
        };
        ctx.body.addEventListener('click', (e) => { const b = e.target.closest('[data-dev]'); if (!b) return; e.stopPropagation(); ctx.save({ device: b.dataset.dev }); ctx.update(); });
        ctx.refresh = async () => { fc = await getForecast(); ctx.update(); };
        ctx.update(); ctx.refresh();
      },
    },
    stack: {
      title: 'Stapel', mini: true, sizes: ['s', 'm', 'l'], size: 'm',
      desc: 'Mehrere Widgets an einem Platz, zum Durchwischen. Zeigt je nach Tageszeit das passende zuerst.',
      mount(ctx) {
        // was schon einzeln auf demselben Tab liegt, zeigt der Stapel nicht nochmals
        const onTab = ctx.item ? new Set(layout.filter((i) => i !== ctx.item && tabOf(i) === tabOf(ctx.item)).map((i) => i.type)) : new Set();
        const types = (ctx.opts.items || ['window', 'tomorrow', 'month', 'solarNow']).filter((t) => HOME_WIDGETS[t] && t !== 'stack' && HOME_WIDGETS[t].sizes.includes(ctx.size) && !onTab.has(t));
        if (!types.length) { ctx.body.innerHTML = '<div class="mw"><p class="mw-k">Stapel</p><p class="mw-s">Alle Widgets dieses Stapels liegen schon einzeln auf dem Tab. Im Bearbeiten-Modus unter „Inhalt“ andere wählen.</p></div>'; return; }
        ctx.body.innerHTML = '<div class="stk"><div class="stk-track"></div><div class="stk-dots" aria-hidden="true"></div></div>';
        const track = ctx.body.querySelector('.stk-track'), dots = ctx.body.querySelector('.stk-dots');
        const subs = types.map((t) => {
          const def = HOME_WIDGETS[t], slide = h('<div class="stk-slide"><div class="w-body fill"></div></div>');
          if (def.link) slide.dataset.link = `${def.link.tab}:${def.link.type}`;
          track.appendChild(slide);
          const sub = { el: slide, body: slide.firstChild, tools: document.createElement('div'), size: ctx.size, opts: { ...(ctx.opts[t] || {}) }, charts: ctx.charts,
            save(patch) { Object.assign(sub.opts, patch); ctx.save({ [t]: { ...sub.opts } }); }, chart: (cv, cfg) => ctx.chart(cv, cfg) };
          try { def.mount(sub); } catch (e) { console.error(e); }
          return sub;
        });
        dots.innerHTML = types.map(() => '<i></i>').join('');
        const mark = () => { const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i)); };
        track.addEventListener('scroll', mark, { passive: true });
        // Smart Stack: morgens das Zeitfenster, mittags die Produktion, abends die Tagesbilanz, nachts der Akku
        const hr = new Date().getHours(), pref = hr < 11 ? ['window', 'tomorrow'] : hr < 16 ? ['solarNow', 'window'] : hr < 22 ? ['today', 'tomorrow'] : ['soc', 'tomorrow'];
        const start = Math.max(0, types.findIndex((t) => pref.includes(t)));
        requestAnimationFrame(() => { track.scrollLeft = start * track.clientWidth; mark(); });
        // automatisch weiterblättern (alle 7 s, nach dem letzten wieder zum ersten). Pause: 15 s nach eigenem Wischen,
        // solange die Maus darauf liegt, im Bearbeiten-Modus, beim Haus im Fokus, wenn der Stapel nicht sichtbar ist
        if (types.length > 1) {
          let pauseUntil = 0, auto = false, visible = true;
          const hold = () => { pauseUntil = Math.max(pauseUntil, Date.now() + 15000); };
          ['pointerdown', 'wheel', 'touchstart'].forEach((ev) => track.addEventListener(ev, hold, { passive: true }));
          track.addEventListener('scroll', () => { if (!auto) hold(); }, { passive: true });
          ctx.el.addEventListener('mouseenter', () => { pauseUntil = Infinity; });
          ctx.el.addEventListener('mouseleave', () => { pauseUntil = Date.now() + 3000; });
          const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
          io.observe(ctx.el);
          const calm = matchMedia('(prefers-reduced-motion: reduce)');
          const timer = setInterval(() => {
            if (!visible || document.hidden || editing || Date.now() < pauseUntil || document.body.classList.contains('house-focus')) return;
            const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)), next = (i + 1) % types.length;
            auto = true;
            const from = track.scrollLeft, to = next * track.clientWidth;
            if (calm.matches) { track.scrollLeft = to; setTimeout(() => { auto = false; }, 100); return; }
            // eigene, ruhige Animation (die eingebaute ist zu schnell): ca. 1 s pro Karte, weich an- und auslaufend
            const dur = next === 0 ? 1600 : 1000, t0 = performance.now(), ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
            track.style.scrollSnapType = 'none'; // sonst rastet der Browser bei jedem Zwischenschritt ein
            const step = (now) => {
              const k = Math.min(1, (now - t0) / dur);
              track.scrollLeft = from + (to - from) * ease(k);
              if (k < 1) requestAnimationFrame(step);
              else { track.style.scrollSnapType = ''; setTimeout(() => { auto = false; }, 100); }
            };
            requestAnimationFrame(step);
          }, 7000);
          const prev = ctx.dispose;
          ctx.dispose = () => { prev?.(); clearInterval(timer); io.disconnect(); };
        }
        ctx.update = () => subs.forEach((s) => s.update?.());
        ctx.refresh = () => subs.forEach((s) => s.refresh?.());
      },
    },
  };

  // ---------- Kleine Widgets für Tag, Bilanz und Analyse ----------
  // Daten-Zwischenspeicher, damit mehrere Widgets dieselbe Abfrage teilen
  const dataCache = {};
  function cached(key, ms, fn) {
    const c = dataCache[key];
    if (c && Date.now() - c.t < ms) return c.p;
    const p = fn().catch(() => null);
    dataCache[key] = { t: Date.now(), p };
    return p;
  }
  const getDays = (n) => cached(`days${n}`, 10 * 60000, () => api(`/api/days?n=${n}`));
  const getProfile = () => cached('profile', 30 * 60000, () => api('/api/profile'));

  // Akku-Prognose: Ladezustand in 5-Minuten-Schritten vorausrechnen. Solar aus der Wetterprognose (Stundenwerte,
  // dazwischen weich), Verbrauch aus dem üblichen Tagesprofil; beides startet beim aktuellen Wert und geht innert
  // etwa einer Stunde ins Profil über. Überschuss lädt (höchstens mit der üblichen Ladeleistung), Fehlbetrag entlädt.
  // Energie pro Prozent: aus der eingestellten Kapazität, sonst aus der eigenen Messung.
  function batForecast(live, fc, prof) {
    const b = live?.bat;
    if (!b || !prof?.slots || !prof.bat) return null;
    const cap = settings.batteryCapacity;
    const inPct = cap ? cap * 10 / 0.95 : prof.bat.whPerPctIn, outPct = cap ? cap * 10 * 0.95 : prof.bat.whPerPctOut;
    if (!inPct || !outPct) return null;
    const chgMax = Math.max(500, prof.bat.chargeMax || 3000), disMax = Math.max(500, prof.bat.dischargeMax || 3000);
    const low = Math.max(0, Math.round(prof.bat.low ?? 5));
    const now = new Date(), m0 = now.getHours() * 60 + now.getMinutes();
    const fdays = [fc?.days?.[fc?.today], fc?.days?.[fc?.tomorrow]];
    const pvF = (min) => {
      const d = fdays[Math.floor(min / 1440)]; if (!d) return 0;
      const h = (min % 1440) / 60 - 0.5, i = Math.floor(h), f = h - i, v = (k) => d.hours[Math.max(0, Math.min(23, k))] || 0;
      return v(i) * (1 - f) + v(i + 1) * f;
    };
    const consF = (min) => prof.slots[Math.floor((min % 1440) / 15)] || prof.base || 300;
    const dPv = (live.pv || 0) - pvF(m0), dCons = (live.cons || 0) - consF(m0);
    const mode = b.charge > 15 ? 'charge' : b.discharge > 15 ? 'discharge' : b.soc >= 99 ? 'full' : 'idle';
    let soc = b.soc, peak = { soc, t: 0 };
    const pts = [[0, soc]];
    for (let t = 5; t <= 36 * 60; t += 5) {
      const mm = m0 + t, pv = Math.max(0, pvF(mm) + dPv * Math.exp(-t / 45)), cons = Math.max(80, consF(mm) + dCons * Math.exp(-t / 40));
      const net = pv - cons;
      if (net > 0 && soc < 100) soc = Math.min(100, soc + Math.min(net, chgMax) / 12 / inPct);
      else if (net < 0 && soc > low) soc = Math.max(low, soc - Math.min(-net, disMax) / 12 / outPct);
      pts.push([t, soc]);
      if (mode === 'charge') {
        if (soc >= 99.5) return { mode, full: true, at: t, pts, low, cap, inPct };
        if (soc > peak.soc) peak = { soc, t };
        if (soc < peak.soc - 2 && net < 0) return { mode, full: false, peak, pts: pts.slice(0, peak.t / 5 + 1), low, cap, inPct };
      } else if (mode === 'discharge') {
        if (soc <= low + 0.3) return { mode, empty: true, at: t, pts, low, cap, inPct };
        if (net > 150 && t > 20) return { mode, empty: false, at: t, soc, pts, low, cap, inPct }; // die Sonne übernimmt vorher
      }
    }
    return { mode, open: true, pts, low, cap, inPct };
  }
  const clockIn = (min) => { const d = new Date(Date.now() + min * 60e3); return `${String(d.getHours()).padStart(2, '0')}:${String(Math.round(d.getMinutes() / 5) * 5 % 60).padStart(2, '0')}`; };
  const durText = (min) => min >= 60 ? `${Math.floor(min / 60)} h${min % 60 >= 5 ? ` ${Math.round(min % 60 / 5) * 5} min` : ''}` : `${Math.max(5, Math.round(min / 5) * 5)} min`;
  // kleiner Verlauf des vorausgerechneten Ladezustands (0–100 %), Start links
  const socPathSVG = (pts, color) => {
    const T = pts.at(-1)[0] || 1, W = 192, H = 44;
    const xy = pts.map(([t, v]) => `${(t / T * W).toFixed(1)},${(H - 2 - v / 100 * (H - 4)).toFixed(1)}`);
    return `<svg class="mw-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${H} ${xy.join(' ')} ${W},${H}" fill="${color}" fill-opacity=".22"/>`
      + `<polyline points="${xy.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  };
  const getRange = (from, to) => cached(`range${from}${to}`, 30 * 60000, () => api(`/api/daysrange?from=${from}&to=${to}`));
  const getYears = () => cached('years', 30 * 60000, () => api('/api/years'));
  const sumOf = (arr, k) => arr.reduce((a, d) => a + (d?.[k] || 0), 0);
  const shortDate = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('de-CH', { day: 'numeric', month: 'short' });
  function ringSVG(v, color, label) {
    const r = 15, C = 2 * Math.PI * r, p = v == null || !isFinite(v) ? 0 : Math.max(0, Math.min(1, v));
    return `<div class="mw-rg"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="${r}" fill="none" style="stroke:rgb(var(--fg-rgb) / .1)" stroke-width="5"/><circle cx="20" cy="20" r="${r}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(C * p).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 20 20)"/><text x="20" y="23.6" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">${v == null || !isFinite(v) ? '–' : Math.round(p * 100)}</text></svg><span>${label}</span></div>`;
  }

  // Tagesbilanz als Sankey: links woher die Energie kam, rechts wohin sie ging, Bänder proportional zu den kWh.
  // Aus den Tagessummen: Einspeisung kommt vom Dach, der Akku lädt zuerst mit Solarstrom (den Rest aus dem Netz),
  // und was das Haus weder vom Dach noch vom Netz bekam, kam aus dem Akku.
  function sankeySVG(s, uid, W = 360, H = 220) {
    const v = (x) => Math.max(0, x || 0);
    const chg = v(s.chgWh), sToB = Math.min(chg, v(s.selfWh)), sToH = Math.max(0, v(s.selfWh) - sToB), gToB = chg - sToB;
    const gToH = Math.max(0, v(s.importWh) - gToB), bToH = Math.max(0, v(s.consWh) - sToH - gToH);
    const L = [['sun', 'Solar', 'var(--sun)'], ['bat', 'Aus Akku', 'var(--bat)'], ['grid', 'Vom Netz', 'var(--imp)']];
    const R = [['house', 'Haus', 'var(--use)'], ['bat', 'In Akku', 'var(--bat)'], ['grid', 'Ins Netz', 'var(--feed)']];
    const links = [['sun', 'house', sToH], ['sun', 'bat', sToB], ['sun', 'grid', v(s.feedWh)], ['bat', 'house', bToH], ['grid', 'house', gToH], ['grid', 'bat', gToB]]
      .filter((l) => l[2] >= 20);
    if (!links.length) return '';
    const nw = 7, gap = 16, pad = 6;
    // Knoten mit Summe, nur die mit Energie
    const side = (nodes, i) => nodes.map(([k, name, col]) => ({ k, name, col, sum: links.filter((l) => l[i] === k).reduce((a, l) => a + l[2], 0) })).filter((n) => n.sum >= 20);
    const left = side(L, 0), right = side(R, 1);
    // Platz für die Beschriftungen nach der längsten Beschriftung je Seite (geschätzt), der Rest gehört den Bändern;
    // auf breiten Bildschirmen etwas mehr Luft
    const lw = (ns) => Math.max(...ns.map((n) => Math.max(n.name.length * 6.3, kWh(n.sum).length * 8.6 + 26))) + 14;
    const xl = Math.min(150, Math.max(lw(left), W >= 560 ? W * 0.2 : 0)), xr = W - nw - Math.min(150, Math.max(lw(right), W >= 560 ? W * 0.2 : 0));
    const k = Math.min(...[left, right].map((ns) => (H - 2 * pad - gap * (ns.length - 1)) / ns.reduce((a, n) => a + n.sum, 0)));
    const place = (ns) => {
      const used = ns.reduce((a, n) => a + Math.max(1.5, n.sum * k), 0) + gap * (ns.length - 1);
      let y = (H - used) / 2;
      for (const n of ns) { n.y = y; n.h = Math.max(1.5, n.sum * k); n.o = 0; y += n.h + gap; }
    };
    place(left); place(right);
    const ln = (ns, key) => ns.find((n) => n.k === key);
    let defs = '', bands = '';
    links.forEach(([a, b, wh], i) => {
      const s0 = ln(left, a), t0 = ln(right, b), w = wh * k;
      const y1 = s0.y + s0.o, y2 = t0.y + t0.o; s0.o += w; t0.o += w;
      const x1 = xl + nw, x2 = xr, mx = (x1 + x2) / 2, id = `${uid}g${i}`;
      defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" x2="${x2}" y1="0" y2="0"><stop offset="0" stop-color="${s0.col}"/><stop offset="1" stop-color="${t0.col}"/></linearGradient>`;
      bands += `<path class="sk-band" fill="url(#${id})" d="M${x1} ${y1.toFixed(1)}C${mx} ${y1.toFixed(1)} ${mx} ${y2.toFixed(1)} ${x2} ${y2.toFixed(1)}V${(y2 + w).toFixed(1)}C${mx} ${(y2 + w).toFixed(1)} ${mx} ${(y1 + w).toFixed(1)} ${x1} ${(y1 + w).toFixed(1)}Z"><title>${s0.name} → ${t0.name}: ${kWhU(wh)}</title></path>`;
    });
    // Beschriftung neben dem Knoten, bei kleinen Knoten auseinanderschieben, damit nichts überlappt
    const labels = (ns, x, anchor) => {
      const ys = ns.map((n) => n.y + n.h / 2);
      for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + 34);
      const over = ys.length ? ys.at(-1) - (H - 16) : 0;
      if (over > 0) for (let i = ys.length - 1; i >= 0; i--) ys[i] = Math.min(ys[i] - (i === ys.length - 1 ? over : 0), i < ys.length - 1 ? ys[i + 1] - 34 : ys[i]);
      return ns.map((n, i) => `<text x="${x}" y="${(ys[i] - 2).toFixed(1)}" text-anchor="${anchor}" class="sk-name">${n.name}</text>`
        + `<text x="${x}" y="${(ys[i] + 13).toFixed(1)}" text-anchor="${anchor}" class="sk-val">${kWh(n.sum)}<tspan> kWh</tspan></text>`).join('');
    };
    const bars = (ns, x) => ns.map((n) => `<rect x="${x}" y="${n.y.toFixed(1)}" width="${nw}" height="${n.h.toFixed(1)}" rx="2.5" fill="${n.col}"/>`).join('');
    return `<svg class="sankey" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Tagesbilanz: woher der Strom kam und wohin er ging"><defs>${defs}</defs>`
      + `<g class="sk-bands">${bands}</g>${bars(left, xl)}${bars(right, xr)}${labels(left, xl - 8, 'end')}${labels(right, xr + nw + 8, 'start')}</svg>`;
  }

  // Tag-Widgets folgen dem Tag, der im Tagesverlauf gewählt ist (Ereignis "solar:day"); ohne Tagesverlauf zeigen sie heute
  let lastDay = null;
  function dayMount(label, icon, color, render) {
    return function mount(ctx) {
      const c = miniBody(ctx, label, icon, color), k = ctx.body.querySelector('.mw-k');
      const draw = (d) => {
        if (!d) return;
        k.lastChild.textContent = d.isToday ? label : `${label} · ${shortDate(d.day)}`;
        setHTML(c, d.summary ? render(d, ctx) : '<p class="mw-s">Für diesen Tag sind keine Werte gespeichert.</p>');
      };
      const on = (e) => draw(e.detail);
      document.addEventListener('solar:day', on);
      ctx.dispose = () => document.removeEventListener('solar:day', on);
      if (lastDay) draw(lastDay); else api('/api/day').then((d) => { lastDay ||= d; draw(lastDay); }).catch(() => {});
    };
  }
  const peakOf = (d) => d.points.reduce((m, p) => (p.pv > (m?.pv ?? -1) ? p : m), null);

  Object.assign(HOME_WIDGETS, {
    dayYield: {
      title: 'Produziert', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'day', type: 'day' },
      desc: 'Ertrag des gewählten Tages, gegen das Soll.',
      mount: dayMount('Produziert', 'sun', 'var(--sun)', (d, ctx) => {
        const s = d.summary, pk = peakOf(d), soll = d.targetWh ? s.yieldWh / d.targetWh : null;
        return big(kWh(s.yieldWh), 'kWh') + `<p class="mw-s">${soll != null ? `${pct(soll)} % vom Soll` : ''}</p>`
          + (ctx.size === 'm' ? `<div class="mw-foot">${soll != null ? `<div class="mw-bar"><i style="width:${Math.min(100, soll * 100).toFixed(1)}%"></i></div>` : ''}<p class="mw-s">${pk && pk.pv > 0 ? `Spitze ${power(pk.pv)} um ${hm(pk.m)}` : ''}${d.targetWh ? ` · Soll ${kWhU(d.targetWh)}` : ''}</p></div>` : '');
      }),
    },
    dayRatio: {
      title: 'Autarkie & Eigenverbrauch', mini: true, sizes: ['s', 'm'], size: 'm', link: { tab: 'day', type: 'day' },
      desc: 'Wie viel vom Verbrauch selbst gedeckt war, und wie viel vom Ertrag selbst genutzt.',
      mount: dayMount('Selbst versorgt', 'home', 'var(--own)', (d, ctx) => {
        const s = d.summary, aut = s.coveredWh != null && s.consWh ? s.coveredWh / s.consWh : null, self = s.selfWh != null && s.yieldWh ? s.selfWh / s.yieldWh : null;
        return `<div class="mw-rings">${ringSVG(aut, 'var(--own)', 'autark')}${ringSVG(self, 'var(--sun)', 'Eigen&shy;verbrauch')}</div>`
          + (ctx.size === 'm' ? `<p class="mw-s mw-foot">${s.importWh != null ? `${kWhU(s.importWh)} vom Netz` : ''}${s.feedWh != null ? ` · ${kWhU(s.feedWh)} eingespeist` : ''}</p>` : '');
      }),
    },
    daySun: {
      title: 'Sonne', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'day', type: 'day' },
      desc: 'Wann die Anlage produziert hat, mit Sonnenauf- und -untergang.',
      mount: dayMount('Sonne', 'sun', 'var(--sun)', (d, ctx) => {
        const on = d.points.filter((p) => p.pv > 50), fd = fcData?.days?.[d.day];
        const span = on.length ? `${hm(on[0].m)}–${hm(on.at(-1).m)}` : '–';
        return `<p class="mw-v sm">${span}</p><p class="mw-s">Produktion${fd?.sunHours != null ? ` · ca. ${f1.format(fd.sunHours)} h Sonne` : ''}</p>`
          + (ctx.size === 'm' && fd?.sunrise ? `<p class="mw-s mw-foot">Sonnenaufgang ${fd.sunrise} · Sonnenuntergang ${fd.sunset}</p>` : '');
      }),
    },
    dayBattery: {
      title: 'Akku am Tag', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'day', type: 'battery' },
      desc: 'Geladen und entladen am gewählten Tag.',
      mount: dayMount('Akku', 'bat', 'var(--bat)', (d, ctx) => {
        const s = d.summary, socs = d.points.map((p) => p.soc).filter((v) => v != null);
        if (s.disWh == null && s.chgWh == null) return '<p class="mw-s">Keine Akkuwerte für diesen Tag.</p>';
        return big(kWh(s.disWh), 'kWh') + `<p class="mw-s">aus dem Akku · ${kWhU(s.chgWh)} geladen</p>`
          + (ctx.size === 'm' && socs.length ? `<p class="mw-s mw-foot">Ladezustand zwischen ${f0.format(Math.min(...socs))} und ${f0.format(Math.max(...socs))} %</p>` : '');
      }),
    },
    dayGrid: {
      title: 'Netz am Tag', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'day', type: 'day' },
      desc: 'Eingespeist und bezogen am gewählten Tag, mit Wert in CHF.',
      mount: dayMount('Netz', 'grid', 'var(--feed)', (d, ctx) => {
        const s = d.summary;
        if (s.feedWh == null) return '<p class="mw-s">Keine Netzwerte für diesen Tag.</p>';
        return big(kWh(s.feedWh), 'kWh') + `<p class="mw-s">eingespeist · ${kWhU(s.importWh)} bezogen</p>`
          + (ctx.size === 'm' ? `<p class="mw-s mw-foot">Vergütung ${chf(s.feedWh / 1000 * settings.tariffFeed)} · Bezug ${chf((s.importWh || 0) / 1000 * impAt(d.day))}</p>` : '');
      }),
    },

    yearSoll: {
      title: 'Jahr', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'bal', type: 'target' },
      desc: 'Ertrag des laufenden Jahres gegen das Soll.',
      mount(ctx) {
        const c = miniBody(ctx, 'Jahr', 'cal', 'var(--sun)');
        ctx.update = () => {
          const p = state?.periods, tg = state?.yearTarget, y = String(state?.today?.day || '').slice(0, 4);
          if (!p?.year || !tg?.toDateWh) { setHTML(c, '<p class="mw-s">Soll-Werte fehlen noch.</p>'); return; }
          ctx.body.querySelector('.mw-k').lastChild.textContent = `Jahr ${y}`;
          const diff = (p.year.yieldWh - tg.toDateWh) / tg.toDateWh;
          setHTML(c, big(kWh(p.year.yieldWh), 'kWh') + `<p class="mw-s"><span class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : '−'}${pct(Math.abs(diff))} %</span> zum Soll bis heute</p>`
            + (ctx.size === 'm' ? `<div class="mw-foot"><div class="mw-bar"><i style="width:${Math.min(100, p.year.yieldWh / tg.fullWh * 100).toFixed(1)}%"></i><b style="left:${Math.min(100, tg.toDateWh / tg.fullWh * 100).toFixed(1)}%"></b></div><p class="mw-s">von ${kWhU(tg.fullWh)} im ganzen Jahr</p></div>` : ''));
        };
        ctx.update();
      },
    },
    total: {
      title: 'Seit Inbetriebnahme', mini: true, sizes: ['s', 'm'], size: 'm', link: { tab: 'bal', type: 'balance' },
      desc: 'Gesamtertrag mit dem nächsten Meilenstein.',
      mount(ctx) {
        const c = miniBody(ctx, ctx.size === 's' ? 'Gesamt' : 'Seit Inbetriebnahme', 'bolt', 'var(--sun)');
        ctx.update = () => {
          const t = state?.periods?.total?.yieldWh; if (t == null) return;
          const mwh = t / 1e6, next = Math.ceil((mwh + 0.001) / 50) * 50, prev = next - 50;
          const since = state.firstDay ? new Date(`${state.firstDay}T12:00:00`).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' }) : '';
          setHTML(c, big(f1.format(mwh), 'MWh') + `<p class="mw-s">${since ? `seit ${since}` : ''}</p>`
            + (ctx.size === 'm' ? `<div class="mw-foot"><div class="mw-bar"><i style="width:${((mwh - prev) / 50 * 100).toFixed(1)}%"></i></div><p class="mw-s">noch ${f1.format(next - mwh)} MWh bis ${next} MWh</p></div>` : ''));
        };
        ctx.update();
      },
    },
    money: {
      title: 'Wert', mini: true, sizes: ['s', 'm', 'l'], size: 'm', link: { tab: 'bal', type: 'balance' },
      desc: 'Ersparnis durch Eigenverbrauch plus Vergütung, in CHF.',
      mount(ctx) {
        const c = miniBody(ctx, 'Wert in CHF', 'cal', 'var(--own)');
        let days = null;
        const val = (arr) => { const m = arr.filter((d) => d.coveredWh != null); return { own: m.reduce((a, d) => a + d.coveredWh / 1000 * impAt(d.day), 0), feed: sumOf(m, 'feedWh') / 1000 * settings.tariffFeed }; };
        ctx.update = () => {
          if (!days) { setHTML(c, '<p class="mw-s">Wird berechnet…</p>'); return; }
          const today = state?.today?.day || '', mo = val(days.filter((d) => d.day.slice(0, 7) === today.slice(0, 7))), yr = val(days.filter((d) => d.day.slice(0, 4) === today.slice(0, 4)));
          const col = (lbl, v) => `<div><p class="mw-s">${lbl}</p><p class="mw-v sm">${f0.format(v.own + v.feed)}<small>CHF</small></p></div>`;
          if (ctx.size === 's') { setHTML(c, big(f0.format(mo.own + mo.feed), 'CHF') + `<p class="mw-s">diesen Monat gespart und vergütet</p>`); return; }
          setHTML(c, `<div class="mw-row two">${col(MONTHS[Number(today.slice(5, 7)) - 1] || 'Monat', mo)}${col(`Jahr ${today.slice(0, 4)}`, yr)}</div>`
            + (ctx.size === 'l' ? `<div class="mw-split-bars">${[['Eigenverbrauch', yr.own, 'var(--own)'], ['Vergütung', yr.feed, 'var(--feed)']].map(([l, v, col2]) => `<div><p class="mw-s">${l} ${new Date().getFullYear()}</p><div class="mw-bar"><i style="width:${(v / Math.max(1, yr.own + yr.feed) * 100).toFixed(1)}%;background:${col2}"></i></div><p class="mw-s">${chf(v)}</p></div>`).join('')}</div>` : '')
            + `<p class="mw-s mw-foot">Eigenverbrauch × ${f2.format(settings.tariffImport)} + Einspeisung × ${f2.format(settings.tariffFeed)} CHF/kWh</p>`);
        };
        ctx.refresh = async () => { days = await getDays(400); ctx.update(); };
        ctx.update(); ctx.refresh();
      },
    },
    ratioYear: {
      title: 'Selbst versorgt', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'ana', type: 'ratios' },
      desc: 'Autarkie und Eigenverbrauch heute, in 30 Tagen oder seit Jahresbeginn.',
      mount(ctx) {
        const c = miniBody(ctx, 'Selbst versorgt', 'home', 'var(--own)');
        let days = null;
        // Zeitraum wählen; Tippen auf die Auswahl öffnet auf Home nicht die Details
        const pick = h('<div class="mw-seg" role="group"></div>');
        c.before(pick);
        pick.addEventListener('click', (e) => {
          const b = e.target.closest('button'); if (!b) return;
          e.stopPropagation();
          // Höhe halten: wird der Inhalt kürzer, würde die Seite unten kürzer und der Bildschirm nach oben springen
          const wi = ctx.el.closest('.wi'); if (wi) wi.style.minHeight = `${wi.offsetHeight}px`;
          ctx.save({ range: b.dataset.v }); ctx.update();
        });
        ctx.update = () => {
          const range = ctx.opts.range || 'year', today = state?.today, y = (today?.day || '').slice(0, 4);
          setHTML(pick, [['today', 'Heute'], ['30', ctx.size === 's' ? '30 T.' : '30 Tage'], ['year', y || 'Jahr']]
            .map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === range}">${l}</button>`).join(''));
          if (range !== 'today' && !days) return;
          const from = range === '30' ? addDaysStr(today?.day, -29) : `${y}-01-01`;
          const sel = range === 'today' ? (today ? [today] : []) : days.filter((d) => d.day >= from && d.day <= (today?.day || '9'));
          const m = sel.filter((d) => d.coveredWh != null && d.consWh), sy = m.filter((d) => d.selfWh != null && d.yieldWh);
          const aut = m.length ? sumOf(m, 'coveredWh') / sumOf(m, 'consWh') : null, self = sy.length ? sumOf(sy, 'selfWh') / sumOf(sy, 'yieldWh') : null;
          const foot = range === 'today' ? `Heute: ${kWhU(today?.importWh)} vom Netz, ${kWhU(today?.feedWh)} eingespeist.`
            : `${kWhU(sumOf(m, 'importWh'))} vom Netz, ${kWhU(sumOf(m, 'feedWh'))} eingespeist${m.length < sel.length ? ` · ${m.length} Tage gemessen` : ''}.`;
          setHTML(c, `<div class="mw-rings">${ringSVG(aut, 'var(--own)', 'autark')}${ringSVG(self, 'var(--sun)', 'Eigen&shy;verbrauch')}</div>` + (ctx.size === 'm' ? `<p class="mw-s mw-foot">${foot}</p>` : ''));
        };
        ctx.refresh = async () => { days = await getDays(400); ctx.update(); };
        ctx.refresh();
      },
    },

    typical: {
      title: 'Typischer Tag', mini: true, sizes: ['m', 'l'], size: 'l', link: { tab: 'ana', type: 'ratios' },
      desc: 'Dein üblicher Verbrauch über den Tag: Grundlast, Tagessumme und Spitzen, die jeden Tag wiederkommen.',
      mount(ctx) {
        const c = miniBody(ctx, 'Typischer Tag', 'clock', 'var(--use)');
        let prof = null;
        const hm = (slot) => `${String(Math.floor(slot / 4) % 24).padStart(2, '0')}:${String(slot % 4 * 15).padStart(2, '0')}`;
        ctx.update = () => {
          if (!prof) { setHTML(c, '<p class="mw-s">Wird berechnet…</p>'); return; }
          if (!prof.slots) { setHTML(c, '<p class="mw-s">Noch zu wenig Messwerte (mindestens 3 vollständige Tage).</p>'); return; }
          const W = 300, H = ctx.size === 'l' ? 96 : 60, max = Math.max(1000, ...prof.slots) * 1.08;
          const x = (s) => (s / 96 * W).toFixed(1), y = (w) => (H - 14 - w / max * (H - 18)).toFixed(1);
          const pts = prof.slots.map((w, s) => `${x(s + 0.5)},${y(w)}`).join(' ');
          const now = new Date(), ns = (now.getHours() * 60 + now.getMinutes()) / 15;
          let svg = `<svg class="ty-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
            + `<line x1="0" x2="${W}" y1="${y(prof.base)}" y2="${y(prof.base)}" class="ty-base"/>`
            + `<polygon points="0,${H - 14} ${pts} ${W},${H - 14}" class="ty-area"/><polyline points="${pts}" class="ty-line"/>`
            + `<line x1="${x(ns)}" x2="${x(ns)}" y1="2" y2="${H - 14}" class="ty-now"/>`;
          prof.peaks.forEach((p) => { svg += `<circle cx="${x((p.from + p.to) / 2)}" cy="${y(p.maxW)}" r="2.6" class="ty-peak"/>`; });
          for (const hh of [0, 6, 12, 18]) svg += `<text x="${x(hh * 4)}" y="${H - 2}" class="ty-ax">${hh}</text>`;
          svg += '</svg>';
          const peaks = prof.peaks.map((p) => `<div class="ty-p"><b>${hm(p.from)}–${hm(p.to)}</b><span>bis ${f1.format(p.maxW / 1000)} kW · ${f1.format(p.wh / 1000)} kWh</span></div>`).join('');
          setHTML(c, `<div class="mw-row two"><div>${big(`ca. ${f0.format(prof.typicalWh / 1000)}`, 'kWh').replace('mw-v', 'mw-v sm')}<p class="mw-s">pro Tag</p></div>`
            + `<div>${big(f1.format(prof.base / 1000), 'kW').replace('mw-v', 'mw-v sm')}<p class="mw-s">Grundlast</p></div></div>`
            + svg + (ctx.size === 'l' ? (peaks ? `<p class="mw-s">Spitzen, die fast jeden Tag kommen</p><div class="ty-peaks">${peaks}</div>` : '<p class="mw-s">Keine Spitzen, die jeden Tag wiederkommen.</p>') : '')
            + `<p class="mw-s mw-foot">Median aus ${prof.days} Tagen</p>`);
        };
        ctx.refresh = async () => { prof = await getProfile().catch(() => null); ctx.update(); };
        ctx.update(); ctx.refresh();
      },
    },

    invCompare: {
      title: 'Wechselrichter', mini: true, sizes: ['s', 'm'], size: 'm', link: { tab: 'ana', type: 'inverters' },
      desc: 'Anteil der Wechselrichter heute, gegen ihr übliches Verhältnis.',
      mount(ctx) {
        const c = miniBody(ctx, 'Wechselrichter', 'bolt', 'var(--sun)');
        let days = null;
        ctx.update = () => {
          const inv = state?.today?.inv, names = settings.inverterNames || [];
          if (!inv?.length || inv.length < 2) { setHTML(c, '<p class="mw-s">Keine Werte pro Wechselrichter.</p>'); return; }
          const tot = inv[0] + inv[1], share = tot > 0 ? inv[0] / tot : null;
          const past = (days || []).filter((d) => d.inv?.length >= 2 && d.inv[0] + d.inv[1] > 2000);
          const usual = past.length ? sumOf(past.map((d) => ({ v: d.inv[0] })), 'v') / sumOf(past.map((d) => ({ v: d.inv[0] + d.inv[1] })), 'v') : null;
          const off = share != null && usual != null && tot > 2000 ? Math.abs(share - usual) : null;
          const n1 = esc(names[0] || 'WR 1'), n2 = esc(names[1] || 'WR 2');
          if (ctx.size === 's') { // klein: nur das Verhältnis
            setHTML(c, `<p class="mw-v sm">${share == null ? '–' : `${pct(share)} : ${pct(1 - share)}`}</p><p class="mw-s">${off == null ? 'heute' : off > 0.08 ? '<span class="neg">ungewöhnlich</span>' : `üblich ${pct(usual)} : ${pct(1 - usual)}`}</p>`
              + (share != null ? `<div class="mw-share mw-foot"><i style="width:${(share * 100).toFixed(1)}%"></i>${usual != null ? `<b style="left:${(usual * 100).toFixed(1)}%"></b>` : ''}</div>` : ''));
            return;
          }
          setHTML(c, `<div class="mw-two"><div><p class="mw-s">${n1}</p><p class="mw-v sm">${kWh(inv[0])}<small>kWh</small></p></div><div><p class="mw-s">${n2}</p><p class="mw-v sm">${kWh(inv[1])}<small>kWh</small></p></div></div>`
            + (share != null ? `<div class="mw-share"><i style="width:${(share * 100).toFixed(1)}%"></i>${usual != null ? `<b style="left:${(usual * 100).toFixed(1)}%"></b>` : ''}</div>` : '')
            + `<p class="mw-s mw-foot">${off == null ? 'Heute noch zu wenig Ertrag für einen Vergleich.' : off > 0.08 ? `<span class="neg">Ungewöhnlich: ${pct(share)} % statt üblich ${pct(usual)} % beim ersten.</span>` : `Im üblichen Verhältnis (${pct(usual)} : ${pct(1 - usual)}).`}</p>`);
        };
        ctx.refresh = async () => { days = await getDays(30); ctx.update(); };
        ctx.update(); ctx.refresh();
      },
    },
    record: {
      title: 'Rekordtag', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'ana', type: 'heatmap' },
      desc: 'Der Tag mit dem höchsten Ertrag seit Inbetriebnahme, dazu der beste Monat.',
      mount(ctx) {
        const c = miniBody(ctx, 'Rekordtag', 'sun', 'var(--sun)');
        let best = null, bestMonth = null;
        ctx.update = () => {
          if (!best) { setHTML(c, '<p class="mw-s">Wird gesucht…</p>'); return; }
          setHTML(c, big(kWh(best.yieldWh), 'kWh') + `<p class="mw-s">${dateLong(best.day)}</p>`
            + (ctx.size === 'm' && bestMonth ? `<p class="mw-s mw-foot">Bester Monat: ${MONTHS[bestMonth.m]} ${bestMonth.y} mit ${kWhU(bestMonth.wh)}</p>` : ''));
        };
        ctx.refresh = async () => {
          const first = state?.firstDay, today = state?.today?.day; if (!first || !today) return;
          const [all, years] = await Promise.all([getRange(first, today), getYears()]);
          best = (all || []).reduce((m, d) => ((d.yieldWh || 0) > (m?.yieldWh || 0) ? d : m), null);
          for (const [y, arr] of Object.entries(years || {})) arr.forEach((wh, m) => { if (wh != null && (!bestMonth || wh > bestMonth.wh)) bestMonth = { y, m, wh }; });
          ctx.update();
        };
        ctx.update(); ctx.refresh();
      },
    },
    yoy: {
      title: 'Vorjahr', mini: true, sizes: ['s', 'm'], size: 's', link: { tab: 'ana', type: 'yearCompare' },
      desc: 'Ertrag seit Jahresbeginn gegen denselben Zeitraum im Vorjahr.',
      mount(ctx) {
        const c = miniBody(ctx, 'Zum Vorjahr', 'cal', 'var(--use)');
        let cur = null, prev = null;
        ctx.update = () => {
          if (cur == null || !prev) { setHTML(c, '<p class="mw-s">Wird verglichen…</p>'); return; }
          const diff = (cur - prev) / prev;
          setHTML(c, `<p class="mw-v"><span class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : '−'}${pct(Math.abs(diff))}</span><small>%</small></p><p class="mw-s">Ertrag bis heute gegen das Vorjahr</p>`
            + (ctx.size === 'm' ? `<div class="mw-row two mw-foot"><div><p class="mw-s">dieses Jahr</p><p class="mw-v sm">${kWh(cur)}<small>kWh</small></p></div><div><p class="mw-s">Vorjahr</p><p class="mw-v sm">${kWh(prev)}<small>kWh</small></p></div></div>` : ''));
        };
        ctx.refresh = async () => {
          const today = state?.today?.day; if (!today) return;
          const y = Number(today.slice(0, 4)), ly = `${y - 1}${today.slice(4)}`;
          const r = await getRange(`${y - 1}-01-01`, ly);
          cur = state.periods?.year?.yieldWh ?? null; prev = r?.length ? sumOf(r, 'yieldWh') : null;
          ctx.update();
        };
        ctx.update(); ctx.refresh();
      },
    },
    avg30: {
      title: '30 Tage', mini: true, sizes: ['s', 'm', 'l'], size: 'm', link: { tab: 'ana', type: 'ratios' },
      desc: 'Durchschnitt der letzten 30 Tage, mit einem Balken pro Tag.',
      mount(ctx) {
        const c = miniBody(ctx, 'Letzte 30 Tage', 'cal', 'var(--sun)');
        let days = null;
        ctx.update = () => {
          if (!days?.length) return;
          const avg = sumOf(days, 'yieldWh') / days.length, max = Math.max(1, ...days.map((d) => d.yieldWh || 0));
          const m = days.filter((d) => d.coveredWh != null && d.consWh), aut = m.length ? sumOf(m, 'coveredWh') / sumOf(m, 'consWh') : null;
          const today = state?.today?.day;
          setHTML(c, big(kWh(avg), 'kWh pro Tag') + `<p class="mw-s">${aut != null ? `${pct(aut)} % autark` : ''}</p>`
            + (ctx.size !== 's' ? `<div class="mw-hours">${days.map((d) => `<i class="${d.day === today ? 'best' : 'sun'}" style="height:${Math.max(3, (d.yieldWh || 0) / max * 100).toFixed(0)}%;opacity:${d.day === today ? 1 : 0.55}" title="${shortDate(d.day)}: ${kWhU(d.yieldWh)}"></i>`).join('')}</div>` : ''));
        };
        ctx.refresh = async () => { days = await getDays(30); ctx.update(); };
        ctx.refresh();
      },
    },
  });

  // ---------- Widget-Definitionen ----------
  // Fokus aufs Haus: Antippen vergrössert die Animation weich und dimmt den Rest der Seite. Beim Weiterscrollen wird sie
  // fliessend wieder kleiner, gekoppelt an den Scrollweg (nach 160 px wieder normal); ein zweites Tippen beendet den Fokus
  // ebenfalls. Nicht im Bearbeiten-Modus.
  function houseFocus(ctx) {
    const svg = ctx.body.querySelector('svg.house'), grid = ctx.body.querySelector('.house-grid');
    if (!svg || !grid) return;
    document.body.classList.remove('house-focus');
    const wrap = () => ctx.el.closest('.wi');
    const isOn = () => !!wrap()?.classList.contains('focus');
    let baseY = 0, settleUntil = 0, scrubT = 0;
    const DIST = 160, root = document.body;
    const set = (on) => {
      const w = wrap(); if (!w || (on && editing)) return;
      if (on) {
        // Platz für das grössere Haus schaffen, damit es nichts darunter überdeckt
        const sc = isWide() ? 1.08 : 1.1; // mehr schneidet auf dem Handy die Beschriftungen am Rand ab
        w.style.setProperty('--fscale', sc);
        w.style.setProperty('--fgrow', `${Math.round(grid.offsetHeight * (sc - 1))}px`);
        const top = w.getBoundingClientRect().top;
        settleUntil = Date.now() + 700;
        if (top < 0 || top > innerHeight * 0.3) scrollTo({ top: Math.max(0, scrollY + top - 8), behavior: 'smooth' });
      }
      root.style.setProperty('--fp', '0');
      // beim Verlassen darf das schrumpfende Haus noch über den Rahmen ragen, bis die Animation fertig ist
      if (!on && w.classList.contains('focus')) { w.classList.add('leaving'); clearTimeout(w.__leave); w.__leave = setTimeout(() => w.classList.remove('leaving'), 900); }
      w.classList.toggle('focus', on);
      root.classList.toggle('house-focus', on);
      baseY = scrollY;
    };
    const onTap = (e) => {
      if (editing || Date.now() < suppressUntil || !wrap()) return;
      e.stopPropagation();
      set(!isOn());
    };
    const onScroll = () => {
      if (!isOn()) return;
      if (Date.now() < settleUntil) { baseY = scrollY; return; } // eigenes Hinscrollen abwarten
      // Fortschritt 0 (gross) bis 1 (normal) folgt direkt dem Finger, ohne Übergangszeit
      const fp = Math.max(0, Math.min(1, (scrollY - baseY) / DIST));
      root.classList.add('house-scrub');
      root.style.setProperty('--fp', fp.toFixed(3));
      clearTimeout(scrubT);
      scrubT = setTimeout(() => root.classList.remove('house-scrub'), 160);
      if (fp >= 1) set(false); // bei 1 sieht alles schon normal aus: Fokus endet ohne Sprung
    };
    // Tippen daneben beendet nur den Fokus: der Klick erreicht kein Widget (die Tab-Leiste bleibt bedienbar)
    const onOutside = (e) => {
      if (!isOn() || wrap()?.contains(e.target) || e.target.closest?.('.tabbar')) return;
      e.stopPropagation(); e.preventDefault();
      set(false);
    };
    svg.addEventListener('click', onTap);
    addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', onOutside, true);
    const prev = ctx.dispose;
    ctx.dispose = () => {
      prev?.(); removeEventListener('scroll', onScroll); document.removeEventListener('click', onOutside, true);
      document.body.classList.remove('house-focus');
    };
  }

  // Leichte Parallaxe am Haus: Beim Scrollen bleiben Sonne und Sterne ganz hinten am meisten zurück, Wolken und Regen etwas
  // weniger, das Haus ist der Bezug und die Beschriftungen vorne laufen ein paar Pixel voraus. Höchstens etwa 5 px im Alltag.
  // Aus bei "Bewegung reduzieren" und im Bearbeiten-Modus. Gerechnet wird nur, solange gescrollt wird und das Haus sichtbar ist.
  // Zum Vergleichen: ?parallaxe=stark verstärkt den Effekt und reagiert auf dem Mac zusätzlich auf die Maus.
  function houseParallax(ctx, sky, strong) {
    const calm = matchMedia('(prefers-reduced-motion: reduce)');
    const k = strong ? 2.6 : 1;
    const far = sky.querySelectorAll('.sky-sun, .sky-stars'), mid = sky.querySelectorAll('.sky-clouds, .sky-fx, .sky-flash');
    const cur = { x: 0, y: 0 }, goal = { x: 0, y: 0 }, mouse = { x: 0, y: 0 };
    let raf = 0, visible = true;
    const off = () => calm.matches || editing || !!ctx.el.closest('.gal');
    const target = () => {
      if (off()) { goal.x = 0; goal.y = 0; return; }
      const r = ctx.el.getBoundingClientRect(), vh = innerHeight || 1;
      goal.x = mouse.x; goal.y = Math.max(-1, Math.min(1, (r.top + r.height / 2 - vh / 2) / vh)) + mouse.y; // -1 oben, 1 unten
    };
    const frame = () => {
      raf = 0;
      cur.x += (goal.x - cur.x) * 0.18; cur.y += (goal.y - cur.y) * 0.18; // weich nachziehen
      const mx = (f) => cur.x * f * k, my = (f) => cur.y * f * k;
      far.forEach((e) => { e.style.translate = `${mx(8).toFixed(2)}px ${my(-12).toFixed(2)}px`; });
      mid.forEach((e) => { e.style.translate = `${mx(5).toFixed(2)}px ${my(-7).toFixed(2)}px`; });
      // vorne: der Text verschiebt sich, die Leitlinie endet weiter am Text, der Punkt bleibt am Bauteil
      const fx = mx(-4), fy = my(5);
      ctx.body.querySelectorAll('text[data-t], .fog-veil').forEach((t) => { t.style.transform = `translate(${fx.toFixed(2)}px, ${fy.toFixed(2)}px)`; });
      ctx.body.querySelectorAll('path[data-l]').forEach((ln) => {
        const d = ln.getAttribute('d');
        if (ln.__set !== d) ln.__base = d; // von der Leitlinien-Anpassung neu gesetzt: das ist die Basis
        const m = /^M([\d.-]+) ([\d.-]+) L([\d.-]+) ([\d.-]+)/.exec(ln.__base || ''); if (!m) return;
        ln.__set = `M${m[1]} ${m[2]} L${(+m[3] + fx).toFixed(1)} ${(+m[4] + fy).toFixed(1)}`;
        ln.setAttribute('d', ln.__set);
      });
      if (Math.abs(goal.x - cur.x) + Math.abs(goal.y - cur.y) > 0.002) raf = requestAnimationFrame(frame);
    };
    const kick = () => { if (!visible && !off()) return; target(); if (!raf) raf = requestAnimationFrame(frame); };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); });
    io.observe(ctx.el);
    addEventListener('scroll', kick, { passive: true }); addEventListener('resize', kick);
    calm.addEventListener?.('change', kick);
    let onMove = null, onLeave = null;
    if (strong) {
      onMove = (e) => {
        if (e.pointerType !== 'mouse') return;
        const r = ctx.el.getBoundingClientRect();
        mouse.x = ((e.clientX - r.left) / r.width - 0.5) * 2; mouse.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
        kick();
      };
      onLeave = () => { mouse.x = 0; mouse.y = 0; kick(); };
      ctx.el.addEventListener('pointermove', onMove); ctx.el.addEventListener('pointerleave', onLeave);
    }
    const prev = ctx.dispose;
    ctx.dispose = () => {
      prev?.(); io.disconnect(); cancelAnimationFrame(raf);
      removeEventListener('scroll', kick); removeEventListener('resize', kick); calm.removeEventListener?.('change', kick);
    };
    kick();
  }

  const WIDGETS = {

    // Energiefluss als 3D-Haus: Werte direkt an Dach, Haus, Batterie und Netz, daneben (breit) die grosse Anzeige
    flow: {
      title: 'Energiefluss jetzt', size: { w: 12, h: 10, minW: 4, minH: 7 }, panel: true,
      mount(ctx) {
        ctx.body.innerHTML = `<div class="house-grid">
            <svg class="house" viewBox="0 0 400 330" role="img" aria-label="Haus mit Solaranlage, Batterie und Netzanschluss">${houseSVG()}</svg>
            <div class="now">
              <p class="now-label">Produktion jetzt</p>
              <p class="now-value"><span data-k="pv">–</span><span class="unit">kW</span></p>
              <p class="now-sub" data-k="sub"></p>
              <dl class="now-list">
                <div><dt>Verbrauch</dt><dd data-k="cons">–</dd></div>
                <div><dt data-k="gridLbl">Netz</dt><dd data-k="grid">–</dd></div>
                <div data-k="batBox" hidden><dt data-k="batLbl">Batterie</dt><dd data-k="bat">–</dd></div>
              </dl>
            </div>
          </div>`;
        const q = (s) => ctx.body.querySelector(s), qa = (s) => ctx.body.querySelectorAll(s);
        // Linien sind vom Wechselrichter weg gezeichnet; fliesst Energie zu ihm hin (Netzbezug, Entladen), läuft die Animation rückwärts
        const setFlow = (k, w, color, toward = false) => {
          const el = q(`[data-f="${k}"]`); if (!el) return;
          el.classList.toggle('on', w > 15);
          el.classList.toggle('rev', toward);
          el.setAttribute('stroke', color);
          el.style.setProperty('--dur', `${Math.max(0.8, 3.6 - Math.log10(Math.max(w, 10)) * 0.7).toFixed(2)}s`);
        };
        const setTag = (k, val, sub, color) => {
          q(`[data-v="${k}"]`).textContent = val;
          const s = q(`[data-s="${k}"]`); s.textContent = sub || ''; s.setAttribute('fill', color || 'var(--muted)');
        };
        // Zum Ausprobieren: ?fluss zeigt erfundene Mittagswerte, bei denen alle Leitungen aktiv sind
        // (Solar → Wechselrichter → Haus, Akku laden, Einspeisen)
        // ?fluss=nacht: erfundene Nachtwerte, nur der Akku versorgt das Haus
        const fq = new URLSearchParams(location.search).get('fluss');
        const flowTest = fq === 'nacht' ? { pv: 0, cons: 420, bat: { soc: 58, charge: 0, discharge: 420 }, inv: [0, 0] }
          : fq != null ? { pv: 7200, cons: 1600, bat: { soc: 64, charge: 2100, discharge: 0 }, inv: [3600, 3600] } : null;
        // Licht in den Fenstern nach Uhrzeit: aus den Sonnenzeiten der Prognose, sonst 7 und 19 Uhr; ?tag / ?nacht erzwingen es
        const lightsOn = () => {
          const sq = new URLSearchParams(location.search);
          if (sq.has('nacht')) return true;
          if (sq.has('tag')) return false;
          const fd = fcData?.days?.[fcData.today], n = new Date(), m = n.getHours() * 60 + n.getMinutes();
          const t = (x, d) => { const r = /^(\d{2}):(\d{2})/.exec(x || ''); return r ? Number(r[1]) * 60 + Number(r[2]) : d; };
          return m < t(fd?.sunrise, 7 * 60) + 30 || m > t(fd?.sunset, 19 * 60) - 30;
        };
        ctx.update = () => {
          const l = flowTest || state?.live; if (!l) return;
          const pv = l.pv, cons = l.cons, b = l.bat;
          const chg = b ? b.charge : 0, dis = b ? b.discharge : 0;
          // Aufteilung: PV deckt zuerst das Haus, dann die Batterie, der Rest geht ins Netz
          const self = Math.min(pv, cons), toBat = Math.min(chg, pv - self), feed = Math.max(pv - self - toBat, 0);
          const fromBat = Math.min(dis, cons - self), imp = Math.max(cons - self - fromBat, 0);
          const share = state.kwp ? pv / (state.kwp * 1000) : null;

          setTag('pv', kW(pv) + ' kW', pv > 15 ? (share != null ? `${pct(share)} % Leistung` : '') : 'keine Produktion', 'var(--sun-ink)');
          setTag('house', kW(cons) + ' kW', '', '');
          setTag('bat', b ? `${kW(chg > 15 ? chg : dis)} kW` : '–', b ? (chg > 15 ? 'Laden' : dis > 15 ? 'Entladen' : 'Ruht') : '', chg > 15 ? 'var(--own)' : dis > 15 ? 'var(--bat-bright)' : 'var(--muted)');
          setTag('grid', kW(feed > 15 ? feed : imp) + ' kW', feed > 15 ? 'Einspeisung' : imp > 15 ? 'Bezug' : '', feed > 15 ? 'var(--feed)' : 'var(--imp-bright)');
          // Leitlinien enden am Rand des Textblocks (nächster Punkt zum Bauteil, mit etwas Abstand), nicht im Text
          qa('path[data-l]').forEach((ln) => {
            const t = q(`text[data-t="${ln.dataset.l}"]`); if (!t) return;
            let bb; try { bb = t.getBBox(); } catch { return; }
            if (!bb.width) return;
            const m = (ln.dataset.a ||= ln.getAttribute('d').match(/^M([\d.-]+) ([\d.-]+)/).slice(1).join(' ')).split(' ').map(Number);
            const pad = 9, x0 = bb.x - pad, x1 = bb.x + bb.width + pad, y0 = bb.y - pad, y1 = bb.y + bb.height + pad;
            const ex = Math.min(x1, Math.max(x0, m[0])), ey = Math.min(y1, Math.max(y0, m[1]));
            ln.setAttribute('d', `M${m[0]} ${m[1]} L${ex.toFixed(1)} ${ey.toFixed(1)}`);
          });
          q('[data-k="batTag"]').style.display = b ? '' : 'none';
          q('[data-k="batTagText"]').style.display = b ? '' : 'none';
          if (q('[data-f="pv2"]')) { const inv = l.inv || []; setFlow('pv', inv[0] ?? pv / 2, 'var(--sun)'); setFlow('pv2', inv[1] ?? pv / 2, 'var(--sun)'); }
          else setFlow('pv', pv, 'var(--sun)');
          // ins Haus fliesst der ganze Verbrauch, gefärbt nach der grössten Quelle
          const main = Math.max(self, fromBat, imp);
          setFlow('house', cons, main === imp && imp > 15 ? 'var(--imp-bright)' : main === fromBat && fromBat > 15 ? 'var(--bat-bright)' : 'var(--sun)');
          setFlow('bat', chg > 15 ? toBat : fromBat, chg > 15 ? 'var(--own)' : 'var(--bat-bright)', chg <= 15);
          setFlow('grid', feed > 15 ? feed : imp, feed > 15 ? 'var(--feed)' : 'var(--imp-bright)', feed <= 15);
          // Module leuchten mit der Produktion, Fenster nach Uhrzeit (Licht ab 30 min vor Sonnenuntergang bis 30 min nach
          // Sonnenaufgang), Batteriezellen nach Ladezustand
          const glow = share != null ? Math.min(1, share) : 0;
          qa('.panel').forEach((p) => { p.setAttribute('fill', glow > 0.02 ? `color-mix(in srgb, #FFC23D ${Math.round(18 + glow * 60)}%, #1D2E5C)` : '#1D2E5C'); p.setAttribute('filter', glow > 0.15 ? 'url(#hglow)' : ''); });
          const lights = lightsOn();
          ctx.body.classList.toggle('lights', lights);
          qa('.cell').forEach((c) => c.setAttribute('fill', b && b.soc > Number(c.dataset.i) * 25 ? '#3CC495' : '#C9CFDD'));

          // grosse Anzeige (nur bei breitem Widget sichtbar)
          q('[data-k="pv"]').textContent = kW(pv);
          q('[data-k="sub"]').textContent = pv === 0 ? 'Die Anlage produziert gerade nicht.' : share != null ? `${pct(share)} % der installierten Leistung` : '';
          setHTML(q('[data-k="cons"]'), `${kW(cons)}<small>kW</small>`);
          q('[data-k="gridLbl"]').textContent = feed > 0 ? 'Einspeisung' : 'Netzbezug';
          setHTML(q('[data-k="grid"]'), `${kW(feed > 0 ? feed : imp)}<small>kW</small>`);
          q('[data-k="batBox"]').hidden = !b;
          if (b) {
            q('[data-k="batLbl"]').textContent = chg > 15 ? 'Batterie lädt' : dis > 15 ? 'Batterie entlädt' : 'Batterie';
            setHTML(q('[data-k="bat"]'), `${kW(chg > 15 ? chg : dis > 15 ? dis : 0)}<small>kW</small>`);
          }
        };
        // Wetter hinter dem Haus: Szene nach aktuellem Wetter und Tageszeit, Temperatur oben links.
        // Nur der Hintergrund ändert sich, die Farben der Werte bleiben gleich (sie tragen Bedeutung).
        const sky = h('<div class="sky" aria-hidden="true"><i class="sky-sun"></i><i class="sky-stars"></i><i class="sky-clouds"></i><i class="sky-clouds b"></i><canvas class="sky-fx"></canvas><i class="sky-flash"></i></div>');
        const wx = h('<div class="wx"></div>');
        ctx.body.prepend(sky, wx);
        // Nebel liegt als Schleier vor dem Haus (vorderste Ebene), nicht nur im Hintergrund
        const veil = h('<div class="fog-veil" aria-hidden="true"></div>');
        ctx.body.querySelector('.house-grid')?.appendChild(veil);
        const calmMotion = matchMedia('(prefers-reduced-motion: reduce)');
        // Blitz: Fassade und Dach hellen im selben Moment kurz auf
        const fx = weatherFx(sky.querySelector('.sky-fx'), () => {
          if (calmMotion.matches) return;
          ctx.body.querySelector('.hx-flash')?.animate([{ opacity: 0 }, { opacity: 0.34 }, { opacity: 0.05 }, { opacity: 0.24 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
        });
        // Schnee: liegt Schnee am Standort, deckt er das Dach zu, bis die Anlage wieder richtig produziert.
        // Erwartet die Prognose jetzt Leistung und kommt kaum etwas, steht beim Solarwert "Module verschneit?".
        let wxKind = null, snowDepth = 0, fcNow = null;
        const snowCheck = () => {
          const fd = fcNow?.days?.[fcNow.today], exp = fd?.hours?.[new Date().getHours()] ?? 0, pv = state?.live?.pv ?? 0;
          const lying = snowDepth >= 0.02, force = sp.has('verschneit');
          ctx.body.classList.toggle('snowy', force || wxKind === 'snow' || (lying && !(exp > 300 && pv > exp * 0.3)));
          if (force || (lying && exp >= 500 && pv < exp * 0.2)) {
            const sub = ctx.body.querySelector('[data-s="pv"]');
            if (sub) { sub.textContent = 'Module verschneit?'; sub.style.fill = 'var(--feed)'; }
          }
        };
        ctx.resize = () => fx.resize();
        // Zum Ausprobieren: ?wetter=nieselregen|regen|starkregen|gewitter|schnee|nebel|wolken|klar erzwingt eine Szene, &tag oder &nacht die Tageszeit
        // (beides auch einzeln, z. B. ?nacht mit dem echten Wetter)
        const sp = new URLSearchParams(location.search);
        const test = { nieselregen: 53, regen: 63, starkregen: 65, gewitter: 95, schnee: 71, nebel: 45, wolken: 3, klar: 0 }[sp.get('wetter')];
        const forceDay = sp.has('nacht') ? false : sp.has('tag') ? true : null;
        async function loadSky() {
          const real = (await getForecast())?.current;
          let c = test == null ? real : { temp: real?.temp ?? 12, cloud: test === 3 ? 90 : 10, code: test, isDay: true, text: `Test: ${sp.get('wetter')}` };
          if (c && forceDay != null) c = { ...c, isDay: forceDay };
          if (!c) { sky.className = 'sky'; wx.innerHTML = ''; fx.set(null); return; }
          const scene = weatherScene(c), kind = scene.split(' ')[0];
          sky.className = `sky ${scene}`;
          ctx.body.dataset.wx = kind; wxKind = kind; fcNow = await getForecast().catch(() => null);
          snowDepth = test === 71 ? 0.1 : test != null ? 0 : c.snow ?? 0;
          snowCheck();
          // Stärke aus dem WMO-Code: 51–57 Niesel, 61/80 leicht, 63/81 mässig, 65/82 stark, 95+ Gewitter
          const strength = c.code >= 95 ? 1.9 : [65, 67, 82, 75, 86].includes(c.code) ? 1.6 : [63, 81, 73, 85].includes(c.code) ? 1.2 : c.code >= 51 && c.code <= 57 ? 0.4 : 0.8;
          fx.set(kind === 'rain' || kind === 'storm' || kind === 'snow' ? kind : null, strength);
          setHTML(wx, `${WX_ICON[scene.replace(' ', '-')] || WX_ICON[scene.split(' ')[0]] || ''}<span><b>${f0.format(c.temp)} °C</b><small>${esc(c.text || '')}</small></span>`);
        }
        ctx.refresh = loadSky;
        ctx.update(); loadSky();

        const baseUpdate = ctx.update;
        ctx.update = () => { baseUpdate(); snowCheck(); };
        houseParallax(ctx, sky, sp.get('parallaxe') === 'stark');
        houseFocus(ctx);
        // Prototyp (nur mit ?leitungen): Leitungen ohne Fluss blenden ganz aus, nur aktive bleiben sichtbar
        if (sp.has('leitungen')) ctx.body.classList.add('flow-only');
      },
    },

    // Überblick für Home: Modus, Akku, Heute, Morgen und der laufende Monat, jede Zahl genau einmal. Systemmeldungen nur bei Problemen.
    status: {
      title: 'Überblick', size: { w: 12, h: 9, minW: 4, minH: 6 }, panel: true, // ohne äusseren Rahmen, die Karten stehen für sich
      mount(ctx) {
        ctx.body.innerHTML = `<div class="hl-alert" data-k="alert" hidden></div>
          <div class="hl-grid">
            <div class="st-card"><p class="k">Aktueller Modus</p><p class="v st-mode" data-k="mode">–</p><p class="s" data-k="modeS"></p></div>
            <div class="st-card" data-k="batCard"><p class="k">Akku</p><p class="v" data-k="soc">–</p><div class="segs">${'<i></i>'.repeat(10)}</div>
              <p class="s" data-k="socS"></p></div>
            <div class="st-card hl-today"><p class="k">Heute</p>
              <div class="hl-three">
                <div><p class="v" data-k="y">–</p><p class="s">produziert</p></div>
                <div><p class="v" data-k="c">–</p><p class="s">verbraucht</p></div>
                <div><p class="v" data-k="a">–</p><p class="s">autark</p></div>
              </div>
              <div class="hl-bar" data-k="bar" hidden><i></i></div><p class="s" data-k="yS"></p>
            </div>
            <div class="st-card"><p class="k">Morgen</p><p class="v" data-k="fc">–</p><p class="s" data-k="fcS"></p><div class="fc-bars mini" data-k="fcB" aria-hidden="true"></div></div>
            <div class="st-card"><p class="k" data-k="mL">Monat</p><p class="v" data-k="m">–</p><p class="s" data-k="mS"></p></div>
          </div>`;
        const q = (s) => ctx.body.querySelector(s);
        let fc = null;
        ctx.update = () => {
          const l = state?.live, t = state?.today || {}, p = state?.periods, tg = state?.yearTarget;
          if (l) {
            // Modus: woher das Haus gerade seinen Strom bekommt (gleiche Aufteilung wie im Energiefluss)
            const b = l.bat, chg = b ? b.charge : 0, dis = b ? b.discharge : 0;
            const self = Math.min(l.pv, l.cons), toBat = Math.min(chg, l.pv - self), feed = Math.max(l.pv - self - toBat, 0);
            const fromBat = Math.min(dis, l.cons - self), imp = Math.max(l.cons - self - fromBat, 0);
            const mode = feed > 300 ? ['Überschuss', 'var(--feed)', 'Guter Moment für Waschmaschine & Co.'] : imp > 300 ? ['Netzbezug', 'var(--imp-bright)', 'Das Haus braucht mehr, als gerade da ist']
              : fromBat > 15 ? ['Batteriebetrieb', 'var(--bat-bright)', 'Das Haus läuft mit dem Akku'] : toBat > 15 ? ['Akku lädt', 'var(--own)', 'Solarstrom geht in den Akku'] : ['Eigenverbrauch', 'var(--own)', 'Das Haus läuft mit Solarstrom'];
            setHTML(q('[data-k="mode"]'), `<i style="background:${mode[1]}"></i>${mode[0]}`);
            q('[data-k="modeS"]').textContent = mode[2];
            // Akku: Stand, Segmente, Leistung und (mit Kapazität) wie lange es noch reicht bzw. bis er voll ist
            q('[data-k="batCard"]').hidden = !b;
            if (b) {
              const soc = Math.min(100, Math.max(0, b.soc)), cap = settings.batteryCapacity, n = Math.round(soc / 10);
              setHTML(q('[data-k="soc"]'), cap ? `${f0.format(soc)}<small>% · ${f1.format(cap * soc / 100)} kWh</small>` : `${f0.format(soc)}<small>%</small>`);
              [...q('.segs').children].forEach((s, i) => { s.className = i < n ? (soc < 15 ? 'on low' : 'on') : ''; if (chg > 15 && i === Math.min(9, n)) s.classList.add('now'); });
              const hrs = (wh, w) => { const h = wh / w; return h >= 1 ? `${f0.format(Math.round(h))} h` : `${f0.format(Math.max(5, Math.round(h * 12) * 5))} min`; };
              // Leistung steht schon im Energiefluss; hier nur, was neu ist: wie lange es noch reicht bzw. bis er voll ist (braucht die Kapazität)
              q('[data-k="socS"]').textContent = !cap ? '' : chg > 15 ? `Voll in ca. ${hrs(cap * (100 - soc) * 10, chg)}` : dis > 15 ? `Reicht noch ca. ${hrs(cap * soc * 10, dis)}` : '';
            }
          }
          setHTML(q('[data-k="y"]'), `${kWh(t.yieldWh)}<small>kWh</small>`);
          setHTML(q('[data-k="c"]'), `${kWh(t.consWh)}<small>kWh</small>`);
          setHTML(q('[data-k="a"]'), t.coveredWh != null && t.consWh ? `${pct(t.coveredWh / t.consWh)}<small>%</small>` : '–');
          // Fortschritt zur Tagesprognose
          const fd = fc?.days?.[fc.today];
          q('[data-k="bar"]').hidden = !fd?.wh;
          if (fd?.wh) {
            const now = new Date(), nowH = now.getHours() + now.getMinutes() / 60;
            const rest = fd.hours.reduce((a, w, hh) => a + w * Math.min(1, Math.max(0, hh + 1 - nowH)), 0);
            q('[data-k="bar"] i').style.width = `${Math.min(100, (t.yieldWh || 0) / fd.wh * 100).toFixed(1)}%`;
            q('[data-k="yS"]').textContent = rest >= 50 ? `Prognose ca. ${kWhU(fd.wh)}, noch ca. ${kWhU(rest)} erwartet` : `Prognose für heute war ca. ${kWhU(fd.wh)}`;
          } else q('[data-k="yS"]').textContent = '';
          // laufender Monat gegen das Soll bis heute
          if (p?.month && tg?.monthToDateWh) {
            const diff = (p.month.yieldWh - tg.monthToDateWh) / tg.monthToDateWh;
            q('[data-k="mL"]').textContent = MONTHS[Number(String(t.day || '').slice(5, 7)) - 1] || 'Monat';
            setHTML(q('[data-k="m"]'), `${kWh(p.month.yieldWh)}<small>kWh</small>`);
            setHTML(q('[data-k="mS"]'), `<span class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : '−'}${pct(Math.abs(diff))} %</span> zum Soll bis heute`);
          }
          // Meldungen nur, wenn etwas nicht stimmt: keine Verbindung, oder ein Wechselrichter liefert nichts, während die Anlage produziert
          const stale = !state?.lastOk || (state.now ?? Date.now()) - state.lastOk > 60e3;
          const names = settings.inverterNames || [];
          const msgs = [];
          if (stale || state?.error) msgs.push(`Keine Verbindung zum Solar-Log${state?.lastOk ? ` seit ${new Date(state.lastOk).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })} Uhr` : ''}`);
          else if (l && l.pv > 500) (l.inv || []).forEach((w, i) => { if (w <= 15) msgs.push(`${names[i] || `Wechselrichter ${i + 1}`} liefert gerade nichts`); });
          q('[data-k="alert"]').hidden = !msgs.length;
          setHTML(q('[data-k="alert"]'), msgs.map((m) => `<span><i></i>${esc(m)}</span>`).join(''));
        };
        async function load() {
          fc = await getForecast();
          const m = fc?.days?.[fc.tomorrow];
          setHTML(q('[data-k="fc"]'), m ? `ca. ${kWh(m.wh)}<small>kWh</small>` : '–');
          q('[data-k="fcS"]').textContent = m ? [m.weather, m.sunnyFrom != null ? `sonnig ab ${m.sunnyFrom} Uhr` : ''].filter(Boolean).join(', ') : fc?.enabled === false ? 'Standort in den Einstellungen eintragen' : '';
          const max = Math.max(1, ...(m?.hours.slice(6, 21) || []));
          setHTML(q('[data-k="fcB"]'), m ? m.hours.slice(6, 21).map((w) => `<i style="height:${(w / max * 100).toFixed(1)}%"></i>`).join('') : '');
          ctx.update();
        }
        ctx.refresh = load;
        ctx.update(); load();
      },
    },

    // Batterie
    battery: {
      title: 'Batterie', size: { w: 12, h: 9, minW: 4, minH: 7 },
      mount(ctx) {
        let day = null;
        const nav = navigator_((dir) => { const today = state.today?.day; const d = addDays(day || today, dir); day = d >= today ? null : d; load(); }, (d) => { day = d >= state.today?.day ? null : d; load(); });
        const todayBtn = h(`<button class="btn" type="button">Heute</button>`);
        todayBtn.onclick = () => { day = null; load(); };
        ctx.tools.append(nav.el, todayBtn);
        ctx.body.innerHTML = `<div class="bat-grid">
          <div class="bat-now">
            <p class="bat-label">Jetzt</p>
            <p class="bat-state" data-k="state"></p>
            <p class="bat-cap-info" data-k="cap"></p>
            <dl class="bat-list">
              <div><dt data-k="chgLbl">Geladen heute</dt><dd data-k="chg">–</dd></div>
              <div><dt data-k="disLbl">Entladen heute</dt><dd data-k="dis">–</dd></div>
            </dl>
          </div>
          <div class="cv"><canvas></canvas></div>
        </div>`;
        const q = (sel) => ctx.body.querySelector(sel), canvas = q('canvas');
        // Das Tag-Widget "Akku" auf demselben Tab zeigt Laden/Entladen schon: dann nur das Diagramm, über die ganze Breite
        const twin = ctx.item && layout.some((i) => i.type === 'dayBattery' && tabOf(i) === tabOf(ctx.item));
        if (twin) { q('.bat-grid').classList.add('solo'); q('.bat-now').hidden = true; }
        const zoom = dayZoom(ctx, canvas);
        let summary = null;
        ctx.update = () => {
          if (twin) return;
          const b = state?.live?.bat;
          if (!b) { q('.bat-now').innerHTML = '<p class="empty">Keine Batteriedaten vom Solar-Log.</p>'; return; }
          const soc = Math.min(100, Math.max(0, b.soc));
          // Ladezustand in Prozent steht oben in der Kopfzeile, hier Leistung und Energieinhalt
          const cap = settings.batteryCapacity;
          q('[data-k="state"]').textContent = b.charge > 15 ? `Lädt mit ${power(b.charge)}` : b.discharge > 15 ? `Entlädt mit ${power(b.discharge)}` : 'Ruht';
          q('[data-k="cap"]').textContent = cap ? `Rund ${f1.format(cap * soc / 100)} von ${f1.format(cap)} kWh gespeichert` : '';
          const s = day ? summary : state.today;
          q('[data-k="chgLbl"]').textContent = day ? 'Geladen' : 'Geladen heute';
          q('[data-k="disLbl"]').textContent = day ? 'Entladen' : 'Entladen heute';
          setHTML(q('[data-k="chg"]'), `${kWh(s?.chgWh)}<small>kWh</small>`);
          setHTML(q('[data-k="dis"]'), `${kWh(s?.disWh)}<small>kWh</small>`);
        };
        async function load() {
          const d = await api(`/api/day${day ? `?date=${day}` : ''}`);
          summary = d.summary;
          nav.set(d.isToday ? 'Heute' : dateNav(d.day), d.day > (state.firstDay || ''), !d.isToday, d.day);
          todayBtn.style.visibility = d.isToday ? 'hidden' : ''; // Platz behalten, sonst springen die Pfeile
          const res = chartRes(), slots = 1440 / res, labels = Array.from({ length: slots }, (_, i) => hm(i * res));
          const soc = new Array(slots).fill(null), chg = new Array(slots).fill(null), dis = new Array(slots).fill(null);
          for (const p of coarsen(d.points, res)) {
            if (p.soc == null && p.bat == null) continue; // Historie aus dem Solar-Log: Laden/Entladen ohne Ladezustand
            const i = p.m / res; soc[i] = p.soc;
            chg[i] = p.bat > 0 ? p.bat / 1000 : 0; dis[i] = p.bat < 0 ? -p.bat / 1000 : 0;
          }
          // Mit Ladezustand nur die %-Fläche (Leistung im Tooltip); vergangene Tage aus dem Solar-Log haben keinen
          // Ladezustand, dort Laden und Entladen als zwei Flächen nach oben
          const hasSoc = soc.some((v) => v != null);
          const line = { pointRadius: 0, pointHoverRadius: 4, tension: 0.25, spanGaps: 2 };
          const xAxis = zoom.axis(res);
          const state_ = (i) => chg[i] > 0.015 ? `Lädt mit ${power(chg[i] * 1000)}` : dis[i] > 0.015 ? `Entlädt mit ${power(dis[i] * 1000)}` : 'Ruht';
          ctx.chart(canvas, hasSoc ? {
            type: 'line',
            data: { labels, datasets: [{ ...line, label: 'Ladezustand', data: soc, borderColor: C.bat, backgroundColor: rgba(C.bat, 0.28), borderWidth: 2, fill: 'origin' }] },
            options: {
              maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
              scales: { x: xAxis, y: { min: 0, max: 100, ticks: { stepSize: 25, callback: (v) => `${v} %` } } },
              plugins: {
                legend: { display: false },
                tooltip: { ...tooltipBase(), callbacks: { title: (it) => `${it[0].label} Uhr`, label: (c) => `Ladezustand: ${f0.format(c.parsed.y)} %`, afterLabel: (c) => state_(c.dataIndex) } },
              },
            },
          } : {
            type: 'line',
            data: { labels, datasets: [
              { ...line, label: 'Laden', data: chg, borderColor: C.bat, backgroundColor: rgba(C.bat, 0.35), borderWidth: 1.5, fill: 'origin' },
              { ...line, label: 'Entladen', data: dis, borderColor: C.sun, backgroundColor: rgba(C.sun, 0.3), borderWidth: 1.5, fill: 'origin' },
            ] },
            options: {
              maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
              scales: { x: xAxis, y: { beginAtZero: true, ticks: { callback: (v) => `${(Number.isInteger(v) ? f0 : f1).format(v)} kW` } } },
              plugins: {
                legend: legendBase(),
                tooltip: { ...tooltipBase(), callbacks: { title: (it) => `${it[0].label} Uhr`, label: (c) => c.parsed.y ? `${c.dataset.label}: ${power(c.parsed.y * 1000)}` : null } },
              },
            },
          });
          if (!d.points.some((p) => p.soc != null || p.bat != null)) canvas.parentElement.insertAdjacentHTML('beforeend', '<p class="empty" style="position:absolute;inset:35% 0 auto">Für diesen Tag sind keine Batteriewerte gespeichert.</p>');
          else canvas.parentElement.querySelector('.empty')?.remove();
          ctx.update();
        }
        ctx.refresh = () => { if (!day) return load(); };
        ctx.update(); load();
      },
    },

    // Tagesverlauf mit Datumsnavigation
    day: {
      title: 'Tagesverlauf', size: { w: 12, h: 14, minW: 4, minH: 10 }, // Legende, Sonnenzeiten und Summen brauchen Platz, das Diagramm soll trotzdem hoch bleiben
      mount(ctx) {
        let day = null; // null = heute
        const o = ctx.opts;
        const nav = navigator_((dir) => { const today = state.today?.day; const d = addDays(day || today, dir); day = d >= today ? null : d; load(); }, (d) => { day = d >= state.today?.day ? null : d; load(); });
        const todayBtn = h(`<button class="btn" type="button">Heute</button>`);
        todayBtn.onclick = () => { day = null; load(); };
        const modeSeg = segmented([['total', 'Gesamt'], ['inv', 'Pro Wechselrichter']], o.mode || 'total', (v) => { ctx.save({ mode: v }); load(); });
        ctx.tools.append(nav.el, todayBtn, modeSeg);
        // hinter Gesamt/Pro Wechselrichter: diese Zeile ändert sich nie (anders als die Datumszeile mit Heute)
        getForecast().then((f) => { if (f?.enabled) modeSeg.after(checkbox('Prognose', o.forecast !== false, (v) => { ctx.save({ forecast: v }); showLine(canvas, 'Prognose', v); })); });
        ctx.body.innerHTML = `<div class="cl-legend"></div><div class="cv tall"><canvas></canvas></div><div class="w-foot"></div>`;
        const canvas = ctx.body.querySelector('canvas'), foot = ctx.body.querySelector('.w-foot');
        const legendEl = ctx.body.querySelector('.cl-legend');
        const zoom = dayZoom(ctx, canvas);

        async function load() {
          const d = await api(`/api/day${day ? `?date=${day}` : ''}`);
          lastDay = d; document.dispatchEvent(new CustomEvent('solar:day', { detail: d })); // kleine Tag-Widgets folgen dem gewählten Tag
          const today = state.today?.day;
          nav.set(d.isToday ? 'Heute' : dateNav(d.day), d.day > (state.firstDay || ''), !d.isToday, d.day);
          todayBtn.style.visibility = d.isToday ? 'hidden' : ''; // Platz behalten, sonst springen die Pfeile
          const res = chartRes(), slots = 1440 / res, labels = Array.from({ length: slots }, (_, i) => hm(i * res));
          const arr = () => new Array(slots).fill(null);
          // Aufteilung wie im Energiefluss: PV deckt zuerst das Haus, dann die Batterie, der Rest geht ins Netz.
          // Eigenversorgt = Verbrauch aus Solar oder Batterie, Netzbezug = der Rest des Verbrauchs.
          // Netz und Batterie mit Vorzeichen aus Sicht des Hauses: + versorgt das Haus (Bezug, Entladen), − nimmt auf (Einspeisung, Laden)
          const S = { pv: arr(), cons: arr(), cov: arr(), imp: arr(), feed: arr(), grid: arr(), batt: arr() };
          let hasBat = false;
          const n = settings.inverterCount;
          const inv = Array.from({ length: n }, arr);
          let hasInv = false;
          for (const p of coarsen(d.points, res)) {
            const i = p.m / res, chg = Math.max(p.bat || 0, 0), dis = Math.max(-(p.bat || 0), 0);
            const self = Math.min(p.pv, p.cons), toBat = Math.min(chg, p.pv - self), fromBat = Math.min(dis, p.cons - self);
            S.pv[i] = p.pv / 1000; S.cons[i] = p.cons / 1000;
            S.cov[i] = (self + fromBat) / 1000; S.imp[i] = Math.max(p.cons - self - fromBat, 0) / 1000;
            S.feed[i] = Math.max(p.pv - self - toBat, 0) / 1000;
            S.grid[i] = S.imp[i] - S.feed[i];
            if (p.bat != null) { S.batt[i] = -p.bat / 1000; hasBat = true; }
            // alle Wechselrichter 0 bei laufender Produktion = falsch gelesen (vor der Erkennung der Geräteliste), weglassen
            if (p.inv && (p.inv.some((w) => w > 0) || p.pv < 200)) { hasInv = true; p.inv.slice(0, n).forEach((w, k) => { inv[k][i] = w / 1000; }); }
          }
          const mode = (ctx.opts.mode === 'inv' && hasInv) ? 'inv' : 'total';
          const line = { pointRadius: 0, pointHoverRadius: 4, tension: 0.25, borderWidth: 2, spanGaps: 2 };
          // Tagessummen: Zählerwerte nur, wenn der Tag vollständig aufgezeichnet ist, sonst passen sie nicht
          // zu Netzbezug und Einspeisung (die zählt das Dashboard selbst). Dann alles aus den 5-Minuten-Werten.
          const wh = (a) => a.reduce((x, v) => x + (v || 0), 0) * 1000 * res / 60;
          const expected = d.isToday ? Math.floor(d.nowMinute / 5) + 1 : 288;
          const partial = d.points.length > 0 && d.points.length < expected * 0.95;
          const P = { yieldWh: wh(S.pv), consWh: wh(S.cons), coveredWh: wh(S.cov), importWh: wh(S.imp), feedWh: wh(S.feed) };
          P.selfWh = P.yieldWh - P.feedWh;
          const T = !d.summary ? null : partial ? { ...P, peakW: d.summary.peakW }
            : Object.fromEntries(Object.entries({ ...P, ...d.summary }).map(([k, v]) => [k, v ?? P[k]]));
          const total = (k) => T ? T[k] : P[k];
          let datasets;
          if (mode === 'inv') {
            datasets = inv.map((data, k) => ({ ...line, name: settings.inverterNames[k] || `Wechselrichter ${k + 1}`, data, stack: 'inv', fill: k === 0 ? 'origin' : '-1', borderColor: C.inv[k], backgroundColor: rgba(C.inv[k], 0.35), borderWidth: 1.5 }));
            datasets.forEach((x) => { x.label = x.name; });
            datasets.push({ ...line, name: 'Verbrauch', label: 'Verbrauch', data: S.cons, borderColor: C.use, backgroundColor: C.use, fill: false, stack: 'cons' });
          } else {
            // Produktion als gelbe Fläche dahinter, davor der Verbrauch aufgeteilt nach Herkunft: eigener Strom
            // (Solar direkt oder aus der Batterie, grün) und Strom vom Netz (rot). Gelb über dem Verbrauch = Überschuss.
            // Keine negativen Werte: Laden und Einspeisen stehen im Tooltip und in den Tagessummen.
            const soft = { ...line, tension: 0.4, borderWidth: 2.2, spanGaps: false }; // Lücken nicht überbrücken: geglättete Kurven würden sonst Werte erfinden
            const area = { ...soft, borderWidth: 0, borderColor: 'transparent', area: true, order: 2 };
            datasets = [
              // nachts (0 W) keine gelbe Linie am Boden; der Wert bleibt im Tooltip
              { ...soft, name: 'Solar', label: 'Solar', data: S.pv, stack: 'pv', borderColor: C.sun, backgroundColor: rgba(C.sun, 0.2), fill: 'origin', order: 3,
                segment: { borderColor: (c) => (c.p0.parsed.y < 0.005 && c.p1.parsed.y < 0.005 ? 'transparent' : C.sun) } },
              { ...area, name: 'Eigener Strom', label: 'Eigener Strom', hint: hasBat ? 'Solar + Batterie' : null, data: S.cov, stack: 'c', fill: 'origin', legend: C.own, backgroundColor: rgba(C.own, 0.7) },
              { ...area, name: 'Vom Netz', label: 'Vom Netz', data: S.imp, stack: 'c', fill: '-1', legend: GRID_RED, backgroundColor: rgba(GRID_RED, 0.85) },
            ];
          }
          // Tooltip: Verbrauch gesamt, Anteil der Batterie am eigenen Strom und wohin ein Überschuss geht
          const batPart = (i) => (S.cov[i] ?? 0) - Math.min(S.pv[i] ?? 0, S.cons[i] ?? 0);
          const flowFooter = (it) => {
            const i = it[0]?.dataIndex, pv = S.pv[i], cons = S.cons[i];
            if (mode !== 'total' || cons == null) return [];
            const out = [`Verbrauch ${power(cons * 1000)}`];
            if (pv != null && pv - cons >= 0.01) {
              const b = S.batt[i] ?? 0, g = S.grid[i] ?? 0;
              const to = [['Batterie', Math.max(-b, 0)], ['Netz', Math.max(-g, 0)]].filter(([, v]) => v >= 0.01).map(([l, v]) => `${l} ${power(v * 1000)}`).join(' · ');
              out.push(`Überschuss ${power((pv - cons) * 1000)}${to ? ` → ${to}` : ''}`);
            }
            return out;
          };
          // erwartete Produktion: Stundenmittel (h bis h+1 Uhr) auf die Zeitschritte des Diagramms verteilt
          // "jetzt" = letzter gemessener Zeitschritt von heute; dort setzt die gestrichelte Prognose an
          const nowIdx = d.isToday ? S.pv.reduce((last, v, i) => (v != null ? i : last), null) : null;
          const fd = (await getForecast())?.days?.[d.day];
          if (fd) {
            const fcs = Array.from({ length: slots }, (_, i) => {
              const x = (i * res + res / 2) / 60 - 0.5, h0 = Math.floor(x), fr = x - h0;
              const a = fd.hours[Math.max(0, h0)] || 0, b = fd.hours[Math.min(23, h0 + 1)] || 0;
              const v = (a + (b - a) * fr) / 1000;
              return v > 0.005 ? v : null;
            });
            datasets.push({ ...line, tension: 0.4, name: 'Prognose', label: 'Prognose', data: fcs, stack: 'fc', fill: false, borderColor: rgba(C.ink, 0.7), borderDash: [5, 5], borderWidth: 2,
              // neutral statt gelb, damit sie nicht mit der Produktion verwechselt wird; vor "jetzt" blass, danach kräftig
              segment: { borderColor: (c) => (nowIdx != null && c.p1DataIndex <= nowIdx ? rgba(C.ink, 0.35) : rgba(C.ink, 0.75)) }, order: -2, noDot: true, hidden: ctx.opts.forecast === false });
          }
          ctx.chart(canvas, {
            type: 'line', data: { labels, datasets }, plugins: [nowMarker, sunMarks],
            options: {
              maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
              scales: {
                x: zoom.axis(res),
                y: { stacked: true, beginAtZero: true, grid: { color: (c) => (c.tick.value === 0 ? (isLight() ? 'rgba(20,28,48,.22)' : 'rgba(255,255,255,.22)') : C.line) },
                  ticks: { callback: (v) => `${(Number.isInteger(v) ? f0 : f1).format(v)} kW` } }, // Achse passt sich dem Tageshöchstwert an
              },
              plugins: {
                legend: { display: false },
                nowMarker: { index: nowIdx },
                sunMarks: { rise: fd?.sunrise, set: fd?.sunset, res },
                tooltip: { ...tooltipBase(),
                  filter: (c) => c.raw != null && (Math.abs(c.raw) >= 0.005 || c.dataset.name === 'Solar'),
                  callbacks: {
                    title: (it) => `${it[0].label} Uhr`,
                    label: (c) => {
                      const bp = c.dataset.name === 'Eigener Strom' ? batPart(c.dataIndex) : 0;
                      return `${c.dataset.name}: ${power(c.raw * 1000)}${bp >= 0.01 ? ` (davon Batterie ${power(bp * 1000)})` : ''}`;
                    },
                    footer: flowFooter,
                  } },
              },
            },
          });
          // Legende oben mit Punkten, Linienart für Ist und Prognose
          legendEl.innerHTML = datasets.filter((x) => x.name !== 'Prognose').map((x) => `<span><i${x.area ? ' class="area"' : ''} style="background:${x.legend || x.borderColor}"></i>${esc(x.name)}${x.hint ? `<small>${esc(x.hint)}</small>` : ''}</span>`).join('')
            + (fd && ctx.opts.forecast !== false ? '<span class="cl-kind"><b></b>Ist <b class="dash"></b>Prognose</span>' : '');
          // Tagessummen: einzige Stelle für Tageswerte. Ergänzende Werte stehen zusammen (Autarkie + vom Netz,
          // Eigenverbrauch + eingespeist), statt zweimal dasselbe als Prozent und als kWh zu zeigen.
          const tile = (lbl, val, sub) => `<div><span>${lbl}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
          foot.classList.add('dfoot');
          // Die kleinen Tag-Widgets zeigen dieselben Summen: dann den Fuss weglassen
          foot.hidden = mounted.some((m) => m.item.type === 'dayYield' || m.item.type === 'dayRatio');
          foot.innerHTML = T ? [
            tile('Produziert', kWhU(T.yieldWh), [d.targetWh ? `Soll ${kWhU(d.targetWh)}` : '', T.peakW ? `Spitze ${power(T.peakW)}` : ''].filter(Boolean).join('<br>')),
            tile('Verbraucht', kWhU(T.consWh), ''),
            T.coveredWh != null && T.consWh ? tile('Autarkie', `${pct(T.coveredWh / T.consWh)} %`, T.importWh != null ? `${kWhU(T.importWh)} vom Netz` : '') : '',
            T.selfWh != null && T.yieldWh ? tile('Eigenverbrauch', `${pct(T.selfWh / T.yieldWh)} %`, T.feedWh != null ? `${kWhU(T.feedWh)} eingespeist` : '') : '',
          ].filter(Boolean).join('') : '<span>Für diesen Tag sind keine Messwerte gespeichert.</span>';
        }
        ctx.refresh = () => { if (!day) return load(); };
        load();
      },
    },

    // Ertragsprognose heute und morgen
    forecast: {
      title: 'Prognose', size: { w: 12, h: 6, minW: 4, minH: 5 },
      mount(ctx) {
        async function load() {
          const f = await getForecast(true);
          if (!f?.enabled) { ctx.body.innerHTML = '<p class="empty">Für die Ertragsprognose in den Einstellungen den Standort der Anlage eintragen.</p>'; return; }
          if (!f.days) { ctx.body.innerHTML = `<p class="empty">${esc(f.error)}</p>`; return; }
          const t = f.days[f.today], m = f.days[f.tomorrow];
          const max = Math.max(1, ...[t, m].flatMap((d) => d?.hours.slice(5, 22) || []));
          const now = new Date(), nowH = now.getHours() + now.getMinutes() / 60;
          const rest = t ? t.hours.reduce((a, w, hh) => a + w * Math.min(1, Math.max(0, hh + 1 - nowH)), 0) : 0;
          const bars = (d, isToday) => `<div class="fc-bars" aria-hidden="true">${d.hours.slice(5, 22).map((w, i) =>
            `<i style="height:${(w / max * 100).toFixed(1)}%"${isToday && i + 6 <= nowH ? ' class="past"' : ''} title="${pad(i + 5)}–${pad(i + 6)} Uhr: ${power(w)}"></i>`).join('')}</div>
            <div class="fc-axis"><span>5 Uhr</span><span>13 Uhr</span><span>22 Uhr</span></div>`;
          const card = (lbl, d, sub, isToday) => d ? `<div class="fc-day"><p class="fc-lbl">${lbl}</p>
            <p class="fc-val">ca. ${kWh(d.wh)}<small>kWh</small></p><p class="fc-sub">${sub}</p>${bars(d, isToday)}</div>` : '';
          const sky = (d) => [d.weather, d.sunHours >= 0.5 ? `ca. ${f0.format(Math.max(1, d.sunHours))} h Sonne` : '', d.sunnyFrom != null ? `sonnig ab ${d.sunnyFrom} Uhr` : ''].filter(Boolean).join(', ');
          const done = state.today?.yieldWh;
          ctx.body.innerHTML = `<div class="fc-grid">
            ${card('Heute', t, [rest >= 50 ? `noch ca. ${kWhU(rest)}` : 'kaum noch Ertrag', done != null ? `bisher ${kWhU(done)}` : ''].filter(Boolean).join(' · '), true)}
            ${card('Morgen', m, m ? sky(m) : '', false)}
          </div>`;
        }
        ctx.refresh = load;
        load();
      },
    },

    // Kennzahlen heute
    figures: {
      title: 'Kennzahlen heute', size: { w: 12, h: 5, minW: 3, minH: 4 },
      mount(ctx) {
        ctx.update = () => {
          const d = state?.today, y = state?.yesterday;
          if (!d) { setHTML(ctx.body, '<p class="empty">Noch keine Tageswerte vorhanden.</p>'); return; }
          const vs = (a, b) => (a == null || !b) ? '' : `${a >= b ? '+' : '−'}${pct(Math.abs(a - b) / b)} % zu gestern`;
          const items = [
            ['Produziert', kWh(d.yieldWh), 'kWh', vs(d.yieldWh, y?.yieldWh)],
            ['Verbraucht', kWh(d.consWh), 'kWh', vs(d.consWh, y?.consWh)],
            ['Selbst genutzt', kWh(d.selfWh), 'kWh', d.selfWh != null && d.yieldWh ? `${pct(d.selfWh / d.yieldWh)} % der Produktion` : ''],
            ['Autarkie', pct(d.coveredWh != null && d.consWh ? d.coveredWh / d.consWh : null), '%', 'Verbrauch aus eigener Erzeugung'],
            ['Eingespeist', kWh(d.feedWh), 'kWh', d.peakW ? `Spitzenleistung ${power(d.peakW)}` : ''],
            ['Bezogen', kWh(d.importWh), 'kWh', d.importWh != null && d.consWh ? `${pct(d.importWh / d.consWh)} % des Verbrauchs` : ''],
          ];
          setHTML(ctx.body, `<dl class="figs">${items.map(([k, v, u, s]) => `<div><dt>${k}</dt><dd>${v}<small>${u}</small></dd>${s ? `<div class="sub">${s}</div>` : ''}</div>`).join('')}</dl>`);
        };
        ctx.update();
      },
    },

    // Bilanz-Balken (Monat / Jahr / Gesamt) mit Soll-Linie
    balance: {
      title: 'Bilanz', size: { w: 12, h: 10, minW: 4, minH: 6 },
      mount(ctx) {
        const o = ctx.opts;
        let period = o.period || 'month', ref = currentRef(period);
        const nav = navigator_((dir) => { const r = shiftRef(period, ref, dir); if (r && r <= currentRef(period)) { ref = r; load(); } });
        // Reihenfolge so, dass es auf dem Handy in zwei Zeilen passt: Zeitraum + Soll, dann Periode + Darstellung
        ctx.tools.append(
          nav.el,
          checkbox('Soll', o.target !== false, (v) => { ctx.save({ target: v }); showLine(canvas, 'Soll', v); }),
          segmented([['month', 'Monat'], ['year', 'Jahr'], ['total', 'Gesamt']], period, (v) => { period = v; ref = currentRef(v); ctx.save({ period: v }); load(); }),
          selectEl([['pc', 'Produktion & Verbrauch'], ['split', 'Woher und wohin'], ['inv', 'Pro Wechselrichter']], o.mode || 'split', (v) => { ctx.save({ mode: v }); load(); }, 'Darstellung'),
        );
        ctx.body.innerHTML = `<div class="cv"><canvas></canvas></div><div class="w-foot"></div>`;
        const canvas = ctx.body.querySelector('canvas'), foot = ctx.body.querySelector('.w-foot');

        async function load() {
          const s = await api(`/api/series?period=${period}${ref ? `&ref=${ref}` : ''}`);
          nav.el.hidden = period === 'total';
          if (period !== 'total') nav.set(refLabel(period, ref), true, ref < currentRef(period));
          const b = s.buckets;
          const labels = b.map((x) => period === 'year' ? MON[Number(x.label) - 1] : x.label);
          const k = (v) => v == null ? null : v / 1000;
          const bar = { borderRadius: 3, borderSkipped: 'start', maxBarThickness: 34, categoryPercentage: 0.78, barPercentage: 0.9 };
          const mode = ctx.opts.mode || 'split';
          let ds = [];
          if (mode === 'pc') {
            ds = [
              { ...bar, label: 'Produktion', data: b.map((x) => k(x.yieldWh)), backgroundColor: C.sun },
              { ...bar, label: 'Verbrauch', data: b.map((x) => k(x.consWh)), backgroundColor: C.use },
            ];
          } else if (mode === 'split') {
            const has = (x) => x.selfWh != null;
            ds = [
              { ...bar, label: 'Produktion: selbst genutzt', stack: 'p', data: b.map((x) => has(x) ? k(x.selfWh) : null), backgroundColor: C.sun },
              { ...bar, label: 'Produktion: eingespeist', stack: 'p', data: b.map((x) => has(x) ? k(x.feedWh) : null), backgroundColor: C.feed },
              { ...bar, label: 'Produktion: Aufteilung unbekannt', stack: 'p', data: b.map((x) => !has(x) ? k(x.yieldWh) : null), backgroundColor: rgba(C.sun, 0.45) },
              { ...bar, label: 'Verbrauch: aus eigener Erzeugung', stack: 'c', data: b.map((x) => x.coveredWh != null ? k(x.coveredWh) : null), backgroundColor: C.own },
              { ...bar, label: 'Verbrauch: vom Netz', stack: 'c', data: b.map((x) => x.coveredWh != null ? k(x.importWh) : null), backgroundColor: C.imp },
              { ...bar, label: 'Verbrauch: Aufteilung unbekannt', stack: 'c', data: b.map((x) => x.coveredWh == null ? k(x.consWh) : null), backgroundColor: rgba(C.grid, 0.45) },
            ].filter((d) => d.data.some((v) => v != null && v > 0));
          } else {
            const n = settings.inverterCount;
            ds = Array.from({ length: n }, (_, i) => ({ ...bar, label: settings.inverterNames[i] || `Wechselrichter ${i + 1}`, stack: 'p', data: b.map((x) => x.inv ? k(x.inv[i]) : null), backgroundColor: C.inv[i] }));
            ds.push({ ...bar, label: 'Wechselrichter unbekannt', stack: 'p', data: b.map((x) => !x.inv ? k(x.yieldWh) : null), backgroundColor: rgba(C.sun, 0.45) });
            ds = ds.filter((d) => d.data.some((v) => v != null && v > 0));
          }
          if (b.some((x) => x.targetWh)) {
            ds.push({ type: 'line', name: 'Soll', label: 'Soll', hidden: ctx.opts.target === false, data: b.map((x) => k(x.targetWh)), borderColor: C.ink, borderDash: [5, 4], borderWidth: 1.5, pointRadius: period === 'month' ? 0 : 3, pointBackgroundColor: C.ink, stepped: period === 'month' ? false : false, order: -1 });
          }
          ctx.chart(canvas, {
            type: 'bar', data: { labels, datasets: ds },
            options: {
              maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
              scales: { x: { stacked: mode !== 'pc', grid: { display: false } }, y: { stacked: mode !== 'pc', beginAtZero: true, ticks: { callback: (v) => `${f0.format(v)} kWh` } } },
              plugins: {
                legend: legendBase(),
                tooltip: { ...tooltipBase(), filter: (c) => c.parsed.y != null && c.parsed.y !== 0,
                  callbacks: { title: (it) => period === 'month' ? dateLong(b[it[0].dataIndex].key) : period === 'year' ? `${MONTHS[it[0].dataIndex]} ${ref}` : it[0].label,
                               label: (c) => `${c.dataset.label}: ${kWhU(c.parsed.y * 1000)}` } },
              },
            },
          });
          const sum = (key) => b.reduce((a, x) => a + (x[key] || 0), 0);
          const y = sum('yieldWh'), c = sum('consWh'), self = b.every((x) => x.selfWh != null || !x.yieldWh) ? sum('selfWh') : null;
          const covered = b.every((x) => x.coveredWh != null || !x.consWh) ? sum('coveredWh') : null;
          const tgt = b.reduce((a, x) => a + (x.targetWh || 0), 0);
          foot.innerHTML = [
            `Produktion <b>${kWhU(y)}</b>${tgt && period !== 'total' ? ` (${pct(y / tgt)} % des Solls)` : ''}`,
            c ? `Verbrauch <b>${kWhU(c)}</b>` : '',
            covered != null && c ? `Autarkie <b>${pct(covered / c)} %</b>` : '',
            self != null && y ? `Eigenverbrauch <b>${pct(self / y)} %</b>` : '',
          ].filter(Boolean).map((x) => `<span>${x}</span>`).join('')
            + (period !== 'total' ? `<button class="foot-link" type="button" data-a="review">Rückblick ${period === 'month' ? MONTHS[Number(ref.slice(5)) - 1] : ref} ansehen ›</button>` : '');
        }
        foot.addEventListener('click', (e) => { if (e.target.closest('[data-a="review"]')) openReview(period, ref); });
        ctx.refresh = load;
        load();
      },
    },

    // Soll/Ist
    target: {
      title: 'Soll und Ist', size: { w: 6, h: 12, minW: 3, minH: 5 },
      mount(ctx) {
        ctx.body.innerHTML = `<div data-k="prog"></div><div class="cv sm"><canvas></canvas></div>`;
        const prog = ctx.body.querySelector('[data-k="prog"]'), canvas = ctx.body.querySelector('canvas');
        ctx.update = () => {
          const t = state?.yearTarget, p = state?.periods;
          // Monat und Jahr stehen schon in eigenen Widgets auf diesem Tab: dann nur die Jahreskurve
          const twin = ctx.item && ['month', 'yearSoll'].every((ty) => layout.some((i) => i.type === ty && tabOf(i) === tabOf(ctx.item)));
          prog.hidden = twin;
          if (twin) return;
          if (!t || !p) { setHTML(prog, '<p class="empty">Soll-Werte erscheinen, sobald die Anlagenleistung bekannt ist.</p>'); return; }
          const block = (title, ist, toDate, full) => {
            const diff = (ist - toDate) / toDate;
            return `<div class="prog">
              <div class="prog-top"><span>${title}</span><span class="d ${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : '−'}${pct(Math.abs(diff))} % zum Soll bis heute</span></div>
              <div class="prog-top"><span class="v">${kWh(ist)}<small> kWh von ${kWh(full)} kWh</small></span></div>
              <div class="bar"><i style="width:${Math.min(100, ist / full * 100).toFixed(1)}%"></i><b style="left:${Math.min(100, toDate / full * 100).toFixed(1)}%" title="Soll bis heute"></b></div>
              <p>Bis heute erwartet: ${kWhU(toDate)}</p></div>`;
          };
          const now = new Date(state.today?.day + 'T12:00:00');
          setHTML(prog, block(`${MONTHS[now.getMonth()]}`, p.month.yieldWh, t.monthToDateWh, t.monthWh) + block(`Jahr ${now.getFullYear()}`, p.year.yieldWh, t.toDateWh, t.fullWh));
        };
        async function load() {
          const s = await api('/api/series?period=year');
          let ci = 0, ct = 0;
          const cur = currentRef('month');
          const ist = s.buckets.map((x) => { if (x.key > cur) return null; ci += x.yieldWh || 0; return ci / 1000; });
          const soll = s.buckets.map((x) => { ct += x.targetWh || 0; return ct / 1000; });
          ctx.chart(canvas, {
            type: 'line',
            data: { labels: MON, datasets: [
              { label: 'Ist kumuliert', data: ist, borderColor: C.sun, backgroundColor: rgba(C.sun, 0.15), fill: 'origin', pointRadius: 2.5, tension: 0.2, borderWidth: 2 },
              { label: 'Soll kumuliert', data: soll, borderColor: C.ink, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, fill: false },
            ] },
            options: {
              maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
              scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => `${f0.format(v)}` }, title: { display: true, text: 'kWh' } } },
              plugins: { legend: legendBase(), tooltip: { ...tooltipBase(), callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? '–' : kWhU(c.parsed.y * 1000)}` } } },
            },
          });
        }
        ctx.refresh = load;
        ctx.update(); load();
      },
    },

    // Wechselrichter-Vergleich
    inverters: {
      title: 'Wechselrichter', size: { w: 6, h: 12, minW: 3, minH: 5 },
      mount(ctx) {
        let period = ctx.opts.period || 'month', ref = currentRef(period);
        const nav = navigator_((dir) => { const r = shiftRef(period, ref, dir); if (r && r <= currentRef(period)) { ref = r; load(); } });
        ctx.tools.append(segmented([['month', 'Monat'], ['year', 'Jahr']], period, (v) => { period = v; ref = currentRef(v); ctx.save({ period: v }); load(); }), nav.el);
        ctx.body.innerHTML = `<div class="inv-list"></div><div class="cv sm"><canvas></canvas></div>`;
        const list = ctx.body.querySelector('.inv-list'), canvas = ctx.body.querySelector('canvas');
        ctx.update = () => {
          const inv = state?.live?.inv || [];
          if (!inv.length) { setHTML(list, '<p class="empty">Der Solar-Log liefert keine Werte pro Wechselrichter.</p>'); return; }
          const total = inv.reduce((a, b) => a + b, 0) || 1, max = Math.max(...inv, 1);
          const todayInv = state.today?.inv || [];
          setHTML(list, inv.map((w, i) => `<div class="inv-row">
            <span class="nm">${esc(settings.inverterNames[i] || `Wechselrichter ${i + 1}`)}</span>
            <span class="meter"><i style="width:${(w / max * 100).toFixed(1)}%;background:${C.inv[i]}"></i></span>
            <span class="num">${power(w)}<small>${pct(w / total)} % · heute ${kWhU(todayInv[i])}</small></span></div>`).join(''));
        };
        async function load() {
          const s = await api(`/api/series?period=${period}&ref=${ref}`);
          nav.set(refLabel(period, ref), true, ref < currentRef(period));
          const n = settings.inverterCount;
          const labels = s.buckets.map((x) => period === 'year' ? MON[Number(x.label) - 1] : x.label);
          ctx.chart(canvas, {
            type: 'bar',
            data: { labels, datasets: Array.from({ length: n }, (_, i) => ({ label: settings.inverterNames[i] || `Wechselrichter ${i + 1}`, data: s.buckets.map((x) => x.inv ? x.inv[i] / 1000 : null), backgroundColor: C.inv[i], borderRadius: 3, maxBarThickness: 18 })) },
            options: {
              maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
              scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => `${f0.format(v)}` }, title: { display: true, text: 'kWh' } } },
              plugins: { legend: legendBase(), tooltip: { ...tooltipBase(), callbacks: { label: (c) => `${c.dataset.label}: ${kWhU(c.parsed.y * 1000)}` } } },
            },
          });
        }
        ctx.refresh = load;
        ctx.update(); load();
      },
    },

    // Heatmap Stunde x Tag
    heatmap: {
      title: 'Produktion nach Stunde', size: { w: 12, h: 9, minW: 4, minH: 5 },
      mount(ctx) {
        ctx.tools.append(selectEl([[30, '30 Tage'], [90, '90 Tage'], [180, '180 Tage'], [365, '365 Tage']], ctx.opts.days || 90, (v) => { ctx.save({ days: Number(v) }); load(); }, 'Zeitraum'));
        ctx.body.innerHTML = `<div class="hm"><canvas></canvas><div class="tip"></div></div>
          <div class="hm-legend"><span>0</span><span class="g"></span><span data-k="max"></span></div>`;
        const box = ctx.body.querySelector('.hm'), cv = box.querySelector('canvas'), tip = box.querySelector('.tip');
        let data = null;
        const H0 = 5, H1 = 21; // angezeigte Stunden
        function draw() {
          if (!data) return;
          const W = box.clientWidth, rows = H1 - H0 + 1, Lp = 42, Bp = 22;
          const Hh = Math.max(120, box.clientHeight);
          if (!W || !Hh) return;
          const dpr = window.devicePixelRatio || 1;
          cv.width = W * dpr; cv.height = Hh * dpr; cv.style.height = `${Hh}px`; cv.style.width = `${W}px`;
          const g = cv.getContext('2d'); g.scale(dpr, dpr);
          const n = data.days.length, cw = (W - Lp) / n, ch = (Hh - Bp) / rows;
          let max = 0; for (const r of data.values) for (let hh = H0; hh <= H1; hh++) max = Math.max(max, r[hh] || 0);
          max = max || 1;
          ctx.body.querySelector('[data-k="max"]').textContent = `${kWh(max)} kWh pro Stunde`;
          ctx.body.querySelector('.hm-legend .g').style.background = `linear-gradient(90deg, ${rgba(C.sun, 0.06)}, ${C.sun})`;
          data.values.forEach((r, di) => {
            for (let hh = H0; hh <= H1; hh++) {
              const v = r[hh];
              g.fillStyle = v == null ? rgba(C.line, 0.35) : rgba(C.sun, 0.06 + 0.94 * Math.pow(v / max, 0.8));
              g.fillRect(Lp + di * cw, (hh - H0) * ch, Math.max(cw - (cw > 4 ? 1 : 0), 1), ch - 1);
            }
          });
          g.fillStyle = C.muted; g.font = `12px ${Chart.defaults.font.family}`; g.textBaseline = 'middle'; g.textAlign = 'right';
          for (let hh = H0; hh <= H1; hh += 2) g.fillText(`${pad(hh)}:00`, Lp - 6, (hh - H0 + 0.5) * ch);
          g.textAlign = 'left'; g.textBaseline = 'alphabetic';
          let lastX = -100;
          data.days.forEach((d, di) => {
            const first = d.endsWith('-01') || (n <= 31 && di % 7 === 0);
            const x = Lp + di * cw;
            if (first && x - lastX > 44) { g.fillText(n <= 31 ? `${Number(d.slice(8))}.${Number(d.slice(5, 7))}.` : MON[Number(d.slice(5, 7)) - 1], x, Hh - 6); lastX = x; }
          });
          cv.onpointermove = (e) => {
            const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
            const di = Math.floor((x - Lp) / cw), hh = H0 + Math.floor(y / ch);
            if (di < 0 || di >= n || hh > H1) { tip.classList.remove('show'); return; }
            const v = data.values[di][hh];
            tip.innerHTML = `<b>${dateLong(data.days[di])}</b><br>${pad(hh)}:00–${pad(hh + 1)}:00 Uhr: ${v == null ? 'keine Daten' : kWhU(v)}`;
            tip.style.left = `${Math.min(Math.max(x, 120), W - 120)}px`; tip.style.top = `${y}px`; tip.classList.toggle('below', y < 60); tip.classList.add('show'); // oben im Feld unter dem Zeiger, sonst abgeschnitten
          };
          cv.onpointerleave = () => tip.classList.remove('show');
        }
        async function load() { data = await api(`/api/heatmap?days=${ctx.opts.days || 90}`); draw(); }
        ctx.resize = draw;
        ctx.refresh = load;
        load();
      },
    },

    // Autarkie & Eigenverbrauchsquote
    // Polarkalender: das ganze Jahr als Kreis, Januar oben, im Uhrzeigersinn. Jeder Tag ein Strahl, Länge = Ertrag,
    // Farbe = wie sonnig der Tag war (Ertrag gegen den besten Tag in ±10 Tagen, ohne externe Wetterdaten).
    // Gestrichelt das Soll pro Tag. Antippen zeigt den Tag in der Mitte.
    polar: {
      title: 'Jahr im Kreis',
      mount(ctx) {
        const nowY = Number((state?.today?.day || new Date().toISOString()).slice(0, 4));
        let year = nowY, days = [], sel = null;
        const nav = h('<div class="pol-nav"><button type="button" data-d="-1" aria-label="Jahr zurück">‹</button><b></b><button type="button" data-d="1" aria-label="Jahr vor">›</button></div>');
        ctx.tools.append(nav);
        ctx.body.innerHTML = '<div class="pol-wrap"></div>';
        const box = ctx.body.firstElementChild;
        nav.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.disabled) return; year += Number(b.dataset.d); sel = null; load(); });
        const CX = 180, CY = 180, R0 = 58, R1 = 146;
        const pol = (a, r) => [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
        const P = (a, r) => pol(a, r).map((v) => v.toFixed(1)).join(' ');
        const mix = (c1, c2, t) => `rgb(${c1.map((v, i) => Math.round(v + (c2[i] - v) * t)).join(' ')})`;
        function draw() {
          const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0, N = leap ? 366 : 365;
          const doy = (d) => Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8)) - Date.UTC(year, 0, 1)) / 864e5);
          const val = new Array(N).fill(null);
          for (const d of days) if (d.yieldWh != null) val[doy(d.day)] = d.yieldWh;
          const max = Math.max(1, ...val.filter((v) => v != null)), top = Math.ceil(max / 1000 / 20) * 20 * 1000; // Skala auf 20 kWh gerundet
          const rad = (wh) => R0 + (R1 - R0) * Math.min(1, wh / top);
          const ang = (i) => -Math.PI / 2 + (i / N) * Math.PI * 2, step = (Math.PI * 2) / N;
          const sunny = isLight() ? [240, 168, 0] : [255, 194, 61], dull = isLight() ? [150, 160, 185] : [92, 106, 145];
          let s = '';
          // Ringe für die Skala
          for (let k = 1; k <= 4; k++) s += `<circle cx="${CX}" cy="${CY}" r="${(R0 + (R1 - R0) * k / 4).toFixed(1)}" class="pol-ring"/>`;
          // Monatsgrenzen und Namen
          for (let m = 0; m < 12; m++) {
            const i = doy(`${year}-${String(m + 1).padStart(2, '0')}-01`), a = ang(i), am = ang(i + 15);
            s += `<path d="M${P(a, R0 - 4)} L${P(a, R1 + 4)}" class="pol-sep"/>`;
            const [tx, ty] = pol(am, R1 + 15);
            s += `<text x="${tx.toFixed(1)}" y="${(ty + 3.5).toFixed(1)}" text-anchor="middle" class="pol-m">${MON[m]}</text>`;
          }
          // ein Strahl pro Tag
          val.forEach((v, i) => {
            if (v == null) return;
            let ref = 0; for (let j = Math.max(0, i - 10); j <= Math.min(N - 1, i + 10); j++) ref = Math.max(ref, val[j] || 0);
            const q = ref ? Math.max(0, Math.min(1, (v / ref - 0.15) / 0.7)) : 0;
            const a0 = ang(i) - step * 0.04, a1 = ang(i + 1) + step * 0.04, r = Math.max(R0 + 1.2, rad(v)); // lückenlos, leicht überlappend: keine Moiré-Muster
            s += `<path d="M${P(a0, R0)} L${P(a0, r)} L${P(a1, r)} L${P(a1, R0)} Z" fill="${mix(dull, sunny, q)}"${sel === i ? ' class="pol-sel"' : ''}/>`;
          });
          // Soll pro Tag (gestrichelt, pro Monat eine Stufe), über den Strahlen
          if (state?.kwp) {
            let d = '';
            for (let m = 0; m < 12; m++) {
              const dim = new Date(year, m + 1, 0).getDate(), t = state.kwp * settings.specificTarget * settings.monthDist[m] / 100 / dim * 1000;
              const i0 = doy(`${year}-${String(m + 1).padStart(2, '0')}-01`), r = rad(t);
              d += `${d ? 'L' : 'M'}${P(ang(i0), r)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${P(ang(i0 + dim), r)} `;
            }
            s += `<path d="${d}" class="pol-soll"/>`;
          }
          // heute
          if (year === nowY) { const i = doy(state?.today?.day || ''); if (i >= 0) s += `<circle cx="${pol(ang(i + 0.5), R1 + 5)[0].toFixed(1)}" cy="${pol(ang(i + 0.5), R1 + 5)[1].toFixed(1)}" r="2.6" class="pol-now"/>`; }
          // Mitte: Jahressumme oder der angetippte Tag
          const tot = val.reduce((a, v) => a + (v || 0), 0);
          const mid = sel != null && val[sel] != null
            ? `<text x="${CX}" y="${CY - 8}" class="pol-c1">${kWh(val[sel])}<tspan class="pol-u"> kWh</tspan></text><text x="${CX}" y="${CY + 12}" class="pol-c2">${dateLong(new Date(Date.UTC(year, 0, 1 + sel)).toISOString().slice(0, 10))}</text>`
            : `<text x="${CX}" y="${CY - 6}" class="pol-c1">${f1.format(tot / 1e6)}<tspan class="pol-u"> MWh</tspan></text><text x="${CX}" y="${CY + 13}" class="pol-c2">${year === nowY ? 'bisher' : `im Jahr ${year}`}</text>`;
          s += mid + `<text x="${CX + 4}" y="${(CY - R1 + 11).toFixed(1)}" class="pol-scale" text-anchor="start">${f0.format(top / 1000)} kWh</text>`;
          setHTML(box, `<svg class="polar" viewBox="0 0 360 360" shape-rendering="geometricPrecision" role="img" aria-label="Ertrag pro Tag im Jahr ${year} als Kreis">${s}</svg>`);
          nav.querySelector('b').textContent = year;
          nav.querySelector('[data-d="1"]').disabled = year >= nowY;
          nav.querySelector('[data-d="-1"]').disabled = year <= 2021;
        }
        // Antippen oder Zeigen: Tag aus dem Winkel bestimmen
        const pick = (e) => {
          const svg = box.querySelector('svg'); if (!svg) return;
          const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 360 - CX, y = (e.clientY - r.top) / r.height * 360 - CY;
          const dist = Math.hypot(x, y), N = days.length ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365) : 365;
          const i = dist < R0 - 6 || dist > R1 + 20 ? null : Math.floor((((Math.atan2(y, x) + Math.PI / 2) / (Math.PI * 2)) + 1) % 1 * N);
          if (i !== sel) { sel = i; draw(); }
        };
        box.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') pick(e); });
        box.addEventListener('pointerdown', pick);
        box.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && sel != null) { sel = null; draw(); } });
        async function load() {
          days = await api(`/api/daysrange?from=${year}-01-01&to=${year}-12-31`).catch(() => []);
          draw();
        }
        ctx.refresh = () => { if (year === nowY) load(); };
        load();
      },
    },

    sankey: {
      title: 'Tagesbilanz',
      mount(ctx) {
        const uid = `sk${Math.random().toString(36).slice(2, 7)}`, h2 = ctx.el.querySelector('.w-head h2');
        ctx.body.innerHTML = '<div class="sk-wrap"></div>';
        const box = ctx.body.firstElementChild;
        const draw = (d) => {
          if (!d) return;
          if (h2) h2.textContent = d.isToday ? 'Tagesbilanz' : `Tagesbilanz · ${shortDate(d.day)}`;
          // in echten Pixeln zeichnen: Schrift bleibt klein, das Diagramm füllt die Fläche (auf breiten Bildschirmen höchstens 720 breit)
          const W = Math.round(Math.min(720, Math.max(300, box.clientWidth || 360))), H = Math.round(Math.min(320, Math.max(200, box.clientHeight || 220)));
          const svg = d.summary && d.summary.consWh != null ? sankeySVG(d.summary, uid, W, H) : '';
          setHTML(box, svg || '<p class="empty">Für diesen Tag gibt es keine Werte zu Verbrauch und Netz.</p>');
        };
        let shown = null;
        const on = (e) => { shown = e.detail; draw(shown); };
        document.addEventListener('solar:day', on);
        ctx.dispose = () => document.removeEventListener('solar:day', on);
        ctx.resize = () => draw(shown);
        if (lastDay) on({ detail: lastDay }); else api('/api/day').then((d) => { lastDay ||= d; on({ detail: lastDay }); }).catch(() => {});
        // ohne Tagesverlauf auf dem Tab: heute neu laden
        ctx.refresh = async () => { if (!lastDay || lastDay.isToday) { lastDay = await api('/api/day').catch(() => lastDay); on({ detail: lastDay }); } };
      },
    },

    ratios: {
      title: 'Autarkie und Eigenverbrauch', size: { w: 6, h: 9, minW: 3, minH: 5 },
      mount(ctx) {
        ctx.tools.append(selectEl([[30, '30 Tage'], [90, '90 Tage'], [365, '365 Tage']], ctx.opts.days || 30, (v) => { ctx.save({ days: Number(v) }); load(); }, 'Zeitraum'));
        ctx.body.innerHTML = `<div class="cv sm"><canvas></canvas></div><div class="w-foot"></div>`;
        const canvas = ctx.body.querySelector('canvas'), foot = ctx.body.querySelector('.w-foot');
        async function load() {
          const days = (await api(`/api/days?n=${ctx.opts.days || 30}`)).filter((d) => d.selfWh != null && d.coveredWh != null && d.consWh && d.yieldWh);
          if (!days.length) { foot.innerHTML = '<span>Kennzahlen erscheinen ab dem ersten vollständig aufgezeichneten Tag.</span>'; return; }
          const aut = days.map((d) => d.coveredWh / d.consWh * 100), own = days.map((d) => d.selfWh / d.yieldWh * 100);
          ctx.chart(canvas, {
            type: 'line',
            data: { labels: days.map((d) => `${Number(d.day.slice(8))}.${Number(d.day.slice(5, 7))}.`), datasets: [
              { label: 'Autarkie', data: aut, borderColor: C.own, backgroundColor: C.own, pointRadius: days.length > 60 ? 0 : 2, tension: 0.25, borderWidth: 2 },
              { label: 'Eigenverbrauchsquote', data: own, borderColor: C.sun, backgroundColor: C.sun, pointRadius: days.length > 60 ? 0 : 2, tension: 0.25, borderWidth: 2 },
            ] },
            options: {
              maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
              scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { min: 0, max: 100, ticks: { callback: (v) => `${v} %` } } },
              plugins: { legend: legendBase(), tooltip: { ...tooltipBase(), callbacks: { title: (it) => dateLong(days[it[0].dataIndex].day), label: (c) => `${c.dataset.label}: ${pct(c.parsed.y / 100)} %` } } },
            },
          });
          const S = (k) => days.reduce((a, d) => a + d[k], 0);
          foot.innerHTML = `<span>Durchschnitt Autarkie <b>${pct(S('coveredWh') / S('consWh'))} %</b></span><span>Eigenverbrauch <b>${pct(S('selfWh') / S('yieldWh'))} %</b></span>`;
        }
        ctx.refresh = load;
        load();
      },
    },

    // Jahresvergleich
    yearCompare: {
      title: 'Jahresvergleich', size: { w: 6, h: 9, minW: 3, minH: 5 },
      mount(ctx) {
        ctx.tools.append(segmented([['m', 'Monatlich'], ['c', 'Kumuliert']], ctx.opts.cumulative ? 'c' : 'm', (v) => { ctx.save({ cumulative: v === 'c' }); load(); }));
        ctx.body.innerHTML = `<div class="cv sm"><canvas></canvas></div>`;
        const canvas = ctx.body.querySelector('canvas');
        async function load() {
          const ys = await api('/api/years');
          const years = Object.keys(ys).sort().slice(-6);
          const cur = currentRef('year'), curMonth = Number(currentRef('month').slice(5));
          const cum = !!ctx.opts.cumulative;
          const ds = years.map((y, i) => {
            let acc = 0;
            const data = ys[y].map((v, m) => {
              if (y === cur && m + 1 > curMonth) return null;
              if (v == null) return cum ? (acc ? acc / 1000 : null) : null;
              acc += v; return (cum ? acc : v) / 1000;
            });
            const isCur = y === cur, age = years.length - 1 - i;
            const col = isCur ? C.sun : rgba(C.grid, Math.max(0.3, 0.9 - age * 0.18));
            return { label: y, data, borderColor: col, backgroundColor: col, borderWidth: isCur ? 2.5 : 1.5, pointRadius: isCur ? 3 : 0, tension: 0.25 };
          });
          if (state?.kwp) {
            let acc = 0;
            ds.push({ label: 'Soll', data: settings.monthDist.map((p) => { const v = state.kwp * settings.specificTarget * p / 100; acc += v; return cum ? acc : v; }), borderColor: C.ink, borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 });
          }
          ctx.chart(canvas, {
            type: 'line', data: { labels: MON, datasets: ds },
            options: {
              maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
              scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => f0.format(v) }, title: { display: true, text: 'kWh' } } },
              plugins: { legend: legendBase(), tooltip: { ...tooltipBase(), callbacks: { title: (it) => MONTHS[it[0].dataIndex], label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? '–' : kWhU(c.parsed.y * 1000)}` } } },
            },
          });
        }
        ctx.refresh = load;
        load();
      },
    },

    // Gesamtbilanz & Wert
    totals: {
      title: 'Gesamtbilanz', size: { w: 12, h: 7, minW: 4, minH: 5 },
      mount(ctx) {
        let days30 = [];
        ctx.update = () => {
          const p = state?.periods; if (!p) return;
          const kwp = state.kwp, t = settings;
          const now = new Date(state.today?.day + 'T12:00:00');
          const spec = (wh) => kwp ? f0.format(wh / 1000 / kwp) : '–';
          const rows = [[MONTHS[now.getMonth()], p.month], [String(now.getFullYear()), p.year], ['Seit Inbetriebnahme', p.total]];
          const val = (d) => d && d.coveredWh != null ? (d.coveredWh * impAt(d.day) + d.feedWh * t.tariffFeed) / 1000 : 0;
          setHTML(ctx.body, `<div class="totals-grid">
            <table class="bal"><thead><tr><th></th><th>Produktion</th><th>Verbrauch</th><th>kWh/kWp</th></tr></thead>
            <tbody>${rows.map(([k, r]) => `<tr><td>${esc(k)}</td><td class="y">${kWhU(r.yieldWh)}</td><td>${kWhU(r.consWh)}</td><td>${spec(r.yieldWh)}</td></tr>`).join('')}</tbody></table>
            <div class="money">
              <p>Wert des Solarstroms heute</p><div class="big">${state.today?.coveredWh != null ? chf(val(state.today)) : '–'}</div>
              <p>Letzte 30 Tage</p><div class="big">${days30.length ? chf(days30.reduce((a, d) => a + val(d), 0)) : '–'}</div>
              <p>Jede selbst genutzte kWh spart ${f2.format(t.tariffImport)} CHF Netzstrom, jede eingespeiste bringt ${f2.format(t.tariffFeed)} CHF Vergütung.</p>
            </div></div>`);
        };
        async function load() { days30 = await api('/api/days?n=30'); ctx.update(); }
        ctx.refresh = load;
        load();
      },
    },
  };

  // Home-Widgets dazu; Detail-Widgets (Diagramme) gibt es gross (2×2) oder ganz breit
  Object.assign(WIDGETS, HOME_WIDGETS);
  const DETAIL_DESC = {
    flow: 'Das Haus mit den Energieflüssen, live.', day: 'Produktion und Verbrauch über den Tag, mit Prognose.', battery: 'Ladezustand und Laden/Entladen über den Tag.',
    balance: 'Produktion und Verbrauch pro Monat, Jahr oder gesamt.', target: 'Monat und Jahr gegen das Soll.', totals: 'Summen für Monat, Jahr und seit Inbetriebnahme.',
    inverters: 'Die Wechselrichter im Vergleich.', heatmap: 'Produktion nach Stunde und Tag.', ratios: 'Autarkie und Eigenverbrauch im Verlauf.',
    yearCompare: 'Jahre im Vergleich.', polar: 'Das ganze Jahr als Kreis: jeder Tag ein Strahl, gefärbt nach Sonne.', sankey: 'Woher der Strom am Tag kam und wohin er ging, als Fluss.', forecast: 'Prognose heute und morgen mit Stundenbalken.', figures: 'Die wichtigsten Zahlen von heute.', status: 'Der frühere Überblick als ein Block.',
  };
  const HALF = ['target', 'inverters', 'ratios', 'yearCompare', 'forecast', 'figures', 'sankey', 'polar'];
  for (const [k, d] of Object.entries(WIDGETS)) if (!d.sizes) { d.sizes = ['l', 'xl']; d.size = HALF.includes(k) ? 'l' : 'xl'; d.desc ||= DETAIL_DESC[k]; }
  WIDGETS.stack.defaultOpts = { items: ['window', 'batEta', 'tomorrow', 'month'] };

  // ---------- Tabs ----------
  // Jeder Widget-Typ hat einen Standard-Tab; pro Widget lässt er sich im Bearbeiten-Modus ändern (item.mtab).
  const TABS = [
    ['now', 'Home', '<path d="M3.5 11.5 12 4.5l8.5 7"/><path d="M5.8 9.8V20h12.4V9.8"/><path d="M10 20v-5.5h4V20"/>'],
    ['day', 'Tag', '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>'],
    ['bal', 'Bilanz', '<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>'],
    ['ana', 'Analyse', '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'],
  ];
  const DEFAULT_TAB = { day: 'day', battery: 'day', sankey: 'day', polar: 'ana', balance: 'bal', target: 'bal', totals: 'bal', inverters: 'ana', heatmap: 'ana', ratios: 'ana', yearCompare: 'ana',
    dayYield: 'day', dayRatio: 'day', daySun: 'day', dayBattery: 'day', dayGrid: 'day', yearSoll: 'bal', total: 'bal', money: 'bal', ratioYear: 'bal',
    invCompare: 'ana', record: 'ana', typical: 'ana', yoy: 'ana', avg30: 'ana' };
  const defaultTab = (type) => DEFAULT_TAB[type] || 'now';
  const tabOf = (item) => item.mtab || defaultTab(item.type);
  let activeTab = (() => { try { return localStorage.getItem('solar.tab'); } catch { return null; } })();
  function setTab(k) {
    if (k === activeTab) return;
    activeTab = k;
    try { localStorage.setItem('solar.tab', k); } catch { /* egal */ }
    renderBoard();
    window.scrollTo(0, 0);
  }
  function renderTabbar(tabs) {
    const bar = $('tabbar');
    bar.hidden = tabs.length < 2;
    document.body.classList.toggle('tabs', !bar.hidden);
    bar.innerHTML = tabs.map(([k, l, ico]) => `<button type="button" data-tab="${k}" aria-current="${k === activeTab ? 'page' : 'false'}">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${ico}</svg><span>${l}</span></button>`).join('');
  }
  const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.2"/>';
  $('tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab);
  });
  // Wischen nach links/rechts wechselt den Tab, ausser über Diagrammen, Stapeln und beim Bearbeiten
  let touch0 = null;
  $('board').addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touch0 = !editing && e.touches.length === 1 && t.clientX > 24 && t.clientX < window.innerWidth - 24 && !e.target.closest('canvas, .hm, .stk-track') ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  $('board').addEventListener('touchend', (e) => {
    if (!touch0 || isWide() || $('tabbar').hidden || drag) return;
    const t = e.changedTouches[0], dx = t.clientX - touch0.x, dy = t.clientY - touch0.y;
    touch0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    const keys = [...$('tabbar').querySelectorAll('[data-tab]')].map((b) => b.dataset.tab);
    const next = keys[keys.indexOf(activeTab) + (dx < 0 ? 1 : -1)];
    if (next) setTab(next);
  }, { passive: true });

  // ---------- Raster im iPhone-Stil ----------
  // Feste Grössen: s = 1×1, m = 2×1, l = 2×2 Zellen, xl = ganze Breite (Höhe nach Inhalt).
  // Spalten: 2 auf dem Handy, 4 auf dem Tablet, 6 am Computer; Zellen sind quadratisch (--cell aus der Breite).
  const CELL = 40; // Mindesthöhe für alte Widgets in Rasterzeilen (nur noch für Diagramm-Höhen gebraucht)
  const SIZE_LABEL = { s: 'S', m: 'M', l: 'L', xl: 'XL' };
  const isWide = () => window.innerWidth >= 820;
  let editing = false, selected = null; // im Bearbeiten-Modus angetipptes Widget

  // Leiste unten im Bearbeiten-Modus: Grösse, Tab und (beim Stapel) Inhalt des angetippten Widgets
  function renderSelBar() {
    const bar = $('editSel'); if (!bar) return;
    if (!editing || !selected || !layout.includes(selected)) { selected = null; bar.innerHTML = '<span class="hint">Widget antippen für Grösse und Tab, ziehen zum Verschieben</span>'; return; }
    const def = WIDGETS[selected.type], cur = def.sizes.includes(selected.size) ? selected.size : def.size;
    bar.innerHTML = `<b>${esc(def.title)}</b>
      ${def.sizes.length > 1 ? `<div class="seg" role="group" aria-label="Grösse">${def.sizes.map((x) => `<button type="button" data-size="${x}" aria-pressed="${x === cur}">${SIZE_LABEL[x]}</button>`).join('')}</div>` : ''}
      <select class="sel" aria-label="Tab">${TABS.map(([k, l]) => `<option value="${k}" ${k === tabOf(selected) ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${selected.type === 'stack' ? '<button type="button" class="btn" data-stack>Inhalt</button>' : ''}`;
    bar.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => { selected.size = b.dataset.size; saveLayout(); renderBoard(); }));
    bar.querySelector('[data-stack]')?.addEventListener('click', () => openStackPicker(selected));
    bar.querySelector('select').addEventListener('change', (e) => {
      if (e.target.value === defaultTab(selected.type)) delete selected.mtab; else selected.mtab = e.target.value;
      saveLayout(); renderBoard();
    });
  }

  function mountWidget(item, shown) {
    const def = WIDGETS[item.type];
    if (!def.sizes.includes(item.size)) item.size = def.size;
    const size = shown || item.size; // angezeigte Grösse (ein einzelnes kleines Widget wird auf dem Handy breit gezeigt)
    const wrap = document.createElement('div');
    wrap.className = `wi sz-${size}${!def.mini && !def.panel ? ' detail' : ''}${def.panel ? ' panel' : ''}`;
    if (def.link && tabOf(item) === 'now') wrap.dataset.link = `${def.link.tab}:${def.link.type}`; // nur auf Home: Tippen öffnet die Details
    const bare = def.panel || def.mini;
    const content = h(`<article class="w${def.panel ? ' flow' : ''}${def.mini ? ' mini' : ''}">
      ${bare ? '' : `<header class="w-head"><h2>${esc(def.title)}</h2><div class="w-tools"></div></header>`}
      <div class="w-body${bare ? ' fill' : ''}"></div></article>`);
    wrap.appendChild(content);
    // Bearbeiten: am Widget nur das Minus; Grösse, Tab und Inhalt stehen unten in der Leiste, wenn es angetippt ist
    const ed = h(`<div class="wi-edit"><button type="button" class="wi-del" aria-label="${esc(def.title)} entfernen">−</button></div>`);
    wrap.appendChild(ed);
    if (item === selected) wrap.classList.add('sel');
    wrap.__item = item;
    const ctx = {
      el: content, body: content.querySelector('.w-body'), tools: content.querySelector('.w-tools') || document.createElement('div'),
      size, item, opts: { ...(item.opts || {}) }, charts: [],
      save(patch) { Object.assign(ctx.opts, patch); item.opts = { ...ctx.opts }; saveLayout(); },
      chart(canvas, cfg) { const old = Chart.getChart(canvas); if (old) old.destroy(); const c = new Chart(canvas, iosify(cfg)); ctx.charts.push(c); return c; },
    };
    ed.querySelector('.wi-del').addEventListener('click', () => { if (selected === item) selected = null; layout.splice(layout.indexOf(item), 1); saveLayout(); renderBoard(); });
    return { wrap, ctx, def, item };
  }

  function startWidget(m) {
    let rt;
    m.ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => m.ctx.resize?.(), 80); });
    m.ro.observe(m.ctx.body);
    mounted.push(m);
    try { m.def.mount(m.ctx); } catch (err) { console.error(err); m.ctx.body.innerHTML = '<p class="empty">Dieses Widget konnte nicht geladen werden.</p>'; }
  }

  // Zellgrösse aus der Breite: quadratische Zellen wie auf dem iPhone-Homescreen
  const boardRO = new ResizeObserver(() => sizeCells());
  let lastCols = 0;
  function sizeCells() {
    const b = $('board'), cs = getComputedStyle(b), cols = Number(cs.getPropertyValue('--cols')) || 2, gap = parseFloat(cs.columnGap) || 12;
    b.style.setProperty('--cell', `${Math.floor((b.clientWidth - gap * (cols - 1)) / cols)}px`);
    if (cols !== lastCols) { lastCols = cols; fillRows(); }
  }
  // Breite Bildschirme (4 oder 6 Spalten): Widgets der Reihe nach in Zeilen packen. Bleibt in einer Zeile Platz,
  // bekommen ihn zuerst die Diagramme (die lassen sich gut strecken), kleine Widgets höchstens zwei Spalten.
  // Kleine Widgets neben einem hohen Diagramm bleiben so hoch wie ihr Inhalt. Beim Bearbeiten gelten die echten Grössen.
  function fillRows() {
    const board = $('board'), cols = Number(getComputedStyle(board).getPropertyValue('--cols')) || 2;
    const wraps = [...board.children].filter((w) => w.classList.contains('wi'));
    wraps.forEach((w) => { w.style.gridColumn = ''; w.style.gridRow = ''; w.style.alignSelf = ''; });
    if (editing || cols <= 2 || !wraps.length) return;
    const base = (w) => {
      const sz = w.className.match(/sz-(\w+)/)?.[1] || 's', det = w.classList.contains('detail') || w.classList.contains('panel');
      return { w, det, mini: !det, wd: sz === 'xl' ? cols : sz === 'l' && det ? Math.max(2, Math.floor(cols / 2)) : sz === 's' ? 1 : 2 };
    };
    // eine Zeile setzen: freie Spalten zuerst an grosse Widgets, kleine höchstens auf 2, Rest gleichmässig
    const spread = (line, width, c0, row) => {
      let extra = width - line.reduce((a, x) => a + x.wd, 0);
      const dets = line.filter((x) => x.det);
      while (extra > 0 && dets.length) for (const x of dets) { if (extra <= 0) break; x.wd++; extra--; }
      for (const x of line) while (extra > 0 && x.mini && x.wd < 2) { x.wd++; extra--; }
      for (let i = 0; extra > 0; i = (i + 1) % line.length) { line[i].wd++; extra--; } // Rest gleichmässig verteilen
      let c = c0;
      for (const x of line) {
        x.w.style.gridColumn = `${c} / span ${x.wd}`; x.w.style.gridRow = `${row}`;
        if (dets.length && x.mini) x.w.style.alignSelf = 'start';
        c += x.wd;
      }
    };
    const items = wraps.map(base);
    let row = 1;
    for (let i = 0; i < items.length;) {
      const it = items[i];
      // grosses Widget (halbe Breite) vorne: die folgenden kleinen Widgets füllen daneben bis zu zwei Zeilen
      if (it.det && it.wd < cols && items[i + 1]?.mini) {
        const side = cols - it.wd, subs = [];
        let j = i + 1;
        for (let k = 0; k < 2 && items[j]?.mini; k++) {
          const sub = [];
          while (items[j]?.mini && sub.reduce((a, x) => a + x.wd, 0) + items[j].wd <= side) sub.push(items[j++]);
          if (!sub.length) break;
          subs.push(sub);
        }
        if (subs.length) {
          it.w.style.gridColumn = `1 / span ${it.wd}`; it.w.style.gridRow = `${row} / span ${subs.length}`;
          subs.forEach((sub, k) => spread(sub, side, it.wd + 1, row + k));
          row += subs.length; i = j; continue;
        }
      }
      const line = [];
      while (i < items.length && line.reduce((a, x) => a + x.wd, 0) + items[i].wd <= cols) {
        // ein grosses Widget mit kleinen dahinter beginnt eine eigene Zeile (siehe oben)
        if (line.length && items[i].det && items[i].wd < cols && items[i + 1]?.mini) break;
        line.push(items[i++]);
      }
      if (!line.length) line.push(items[i++]);
      spread(line, cols, 1, row++);
    }
  }
  boardRO.observe($('board'));

  function renderBoard() {
    for (const m of mounted) { m.ctx.charts.forEach((c) => c.destroy()); m.ro?.disconnect(); m.ctx.dispose?.(); }
    mounted.length = 0;
    const board = $('board');
    board.innerHTML = '';
    board.className = `board ios${isWide() ? '' : ' list'}`;
    const visible = layout.filter((i) => tabOf(i) !== 'hide' && WIDGETS[i.type]);
    let tabs = TABS.filter(([k]) => visible.some((i) => tabOf(i) === k));
    if (editing) tabs = TABS; // beim Bearbeiten alle Tabs, damit man Widgets überall hinlegen kann
    if (!tabs.some(([k]) => k === activeTab)) activeTab = (tabs[0] || TABS[0])[0];
    renderTabbar(tabs.length ? tabs : [TABS[0]]);
    const items = visible.filter((i) => tabOf(i) === activeTab);
    if (!items.length) board.innerHTML = `<p class="empty">${editing ? 'Dieser Tab ist leer. Mit „+ Widget“ oben fügst du eines hinzu.' : 'Keine Widgets. Halte den Bildschirm gedrückt oder öffne das Menü, um Widgets hinzuzufügen.'}</p>`;
    // Handy (2 Spalten): bleibt ein kleines Widget allein in seiner Zeile, zeigen wir es breit statt neben einer Lücke
    const shown = new Map();
    // Alles ausser S belegt dort ganze Zeilen und das Raster füllt Lücken auf: bei ungerader Anzahl bleibt das letzte S allein
    if (!editing && window.innerWidth < 620) {
      const small = items.filter((it) => (WIDGETS[it.type].sizes.includes(it.size) ? it.size : WIDGETS[it.type].size) === 's');
      const last = small.at(-1);
      if (small.length % 2 && WIDGETS[last.type].sizes.includes('m')) shown.set(last, 'm');
    }
    for (const item of items) { const m = mountWidget(item, shown.get(item)); board.appendChild(m.wrap); startWidget(m); }
    sizeCells();
    fillRows();
    updateTopBat();
    renderSelBar();
  }

  let saveTimer;
  function saveLayout() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout }) }).catch(() => {}), 400);
  }

  // Tippen auf ein Widget öffnet seine Detailansicht (wie ein iPhone-Widget die App)
  let suppressUntil = 0; // nach langem Drücken oder Ziehen den folgenden Klick schlucken
  function openDetail(tab, type) {
    const target = layout.find((i) => i.type === type && tabOf(i) !== 'hide') || null;
    const goTab = target ? tabOf(target) : tab;
    if (goTab !== activeTab) setTab(goTab);
    requestAnimationFrame(() => {
      const m = target && mounted.find((x) => x.item === target);
      if (!m) return;
      m.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      m.wrap.classList.add('flash'); setTimeout(() => m.wrap.classList.remove('flash'), 1300);
    });
  }
  $('board').addEventListener('click', (e) => {
    if (Date.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); return; }
    if (editing) {
      if (e.target.closest('.wi-del')) return;
      const w = e.target.closest('.wi'); if (!w) return;
      selected = selected === w.__item ? null : w.__item;
      document.querySelectorAll('.wi.sel').forEach((x) => x.classList.remove('sel'));
      if (selected) w.classList.add('sel');
      renderSelBar(); return;
    }
    if (activeTab !== 'now' || e.target.closest('button, select, input, a, canvas, label, .seg, .nav, .chip, .hm')) return;
    const el = e.target.closest('[data-link]'); if (!el) return;
    const [tab, type] = el.dataset.link.split(':');
    openDetail(tab, type);
  }, true);

  // ---------- Bearbeiten wie auf dem iPhone: lange drücken, wackeln, ziehen, entfernen, Galerie ----------
  function setEditing(on) {
    if (editing === on) return;
    editing = on; selected = null;
    document.body.classList.toggle('editing', on);
    $('editBar').hidden = !on;
    closeMenu();
    renderBoard();
  }
  // langes Drücken (0,55 s) auf ein Widget startet das Bearbeiten
  let lp = null;
  $('board').addEventListener('pointerdown', (e) => {
    if (editing || e.button > 0 || !e.target.closest('.wi') || e.target.closest('button, select, input, canvas')) return;
    const x = e.clientX, y = e.clientY;
    lp = { x, y, t: setTimeout(() => { lp = null; suppressUntil = Date.now() + 400; window.getSelection?.()?.removeAllRanges(); navigator.vibrate?.(12); setEditing(true); }, 550) };
  });
  const cancelLp = () => { if (lp) { clearTimeout(lp.t); lp = null; } };
  window.addEventListener('pointermove', (e) => { if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLp(); }, { passive: true });
  window.addEventListener('pointerup', cancelLp); window.addEventListener('pointercancel', cancelLp);
  $('board').addEventListener('contextmenu', (e) => { if (e.target.closest('.wi') && !e.target.closest('canvas')) e.preventDefault(); });

  // Ziehen zum Umsortieren: Maus sofort, Finger nach kurzem Halten (sonst scrollt die Seite)
  let drag = null;
  $('board').addEventListener('pointerdown', (e) => {
    if (!editing || e.button > 0 || e.target.closest('.wi-edit button, .wi-edit select')) return;
    const el = e.target.closest('.wi'); if (!el) return;
    drag = { el, sx: e.clientX, sy: e.clientY, on: false, touch: e.pointerType === 'touch', t: 0, last: 0 };
    if (drag.touch) drag.t = setTimeout(() => { if (drag && !drag.on) beginDrag(); }, 220);
  });
  function beginDrag() {
    const r = drag.el.getBoundingClientRect();
    drag.on = true; drag.gx = drag.sx - r.left; drag.gy = drag.sy - r.top;
    drag.el.classList.add('dragging');
    navigator.vibrate?.(8);
  }
  function moveDrag(px, py) {
    const el = drag.el, board = $('board');
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    el.style.transform = `translate(${px - drag.gx - r.left}px, ${py - drag.gy - r.top}px)`;
    if (py < 70) window.scrollBy(0, -14); else if (py > window.innerHeight - 110) window.scrollBy(0, 14);
    // Ziel über die Rechtecke suchen: das Haus-Widget zeichnet seinen Himmel über den eigenen Rand hinaus
    const t = [...board.children].find((w) => w !== el && w.classList.contains('wi') && (({ left, right, top, bottom }) => px >= left && px <= right && py >= top && py <= bottom)(w.getBoundingClientRect()));
    if (!t || Date.now() - drag.last < 180) return;
    const kids = [...board.children];
    board.insertBefore(el, kids.indexOf(el) < kids.indexOf(t) ? t.nextSibling : t);
    drag.last = Date.now();
  }
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 8) return;
      if (drag.touch) { clearTimeout(drag.t); drag = null; return; } // Finger bewegt sich sofort: scrollen
      beginDrag();
    }
    moveDrag(e.clientX, e.clientY);
  });
  document.addEventListener('touchmove', (e) => { if (drag?.on) e.preventDefault(); }, { passive: false });
  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.t);
    if (drag.on) {
      drag.el.classList.remove('dragging'); drag.el.style.transform = '';
      const order = [...$('board').children].map((w) => w.__item).filter(Boolean);
      layout = layout.filter((i) => !order.includes(i)).concat(order);
      saveLayout(); suppressUntil = Date.now() + 200;
    }
    drag = null;
  }
  window.addEventListener('pointerup', endDrag); window.addEventListener('pointercancel', endDrag);

  // Galerie: alle Widgets mit Vorschau, Grösse wählen und auf den aktuellen Tab legen
  function openGallery() {
    const g = $('galGrid');
    g.innerHTML = '';
    const tabName = TABS.find(([k]) => k === activeTab)?.[1] || 'Home';
    $('galHint').textContent = `Wird auf „${tabName}“ hinzugefügt. Grösse antippen: S klein, M breit, L gross, XL ganze Breite.`;
    const entries = Object.entries(WIDGETS).filter(([k]) => k !== 'status').sort(([, a], [, b]) => (b.mini ? 1 : 0) - (a.mini ? 1 : 0));
    for (const [type, def] of entries) {
      const it = h(`<div class="gal-it"><div class="gal-prev${def.mini ? '' : ' ph'}"></div><b>${esc(def.title)}</b><p>${esc(def.desc || '')}</p>
        <div class="gal-sz">${def.sizes.map((s) => `<button type="button" class="btn" data-size="${s}">${SIZE_LABEL[s]}</button>`).join('')}</div></div>`);
      const prev = it.querySelector('.gal-prev');
      if (def.mini && type !== 'stack') {
        const art = h('<article class="w mini"><div class="w-body fill"></div></article>');
        prev.appendChild(art);
        const pctx = { el: art, body: art.firstChild, tools: document.createElement('div'), size: def.sizes.includes('s') ? 's' : def.sizes[0], opts: {}, charts: [], save() {}, chart() {} };
        try { def.mount(pctx); } catch (e) { console.error(e); }
      } else prev.innerHTML = `<span>${def.mini ? 'Mehrere Widgets zum Wischen. Inhalt im Bearbeiten-Modus wählen.' : 'Diagramm'}</span>`;
      it.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
        const item = { type, size: b.dataset.size, opts: def.defaultOpts ? { ...def.defaultOpts } : undefined };
        if (activeTab !== defaultTab(type)) item.mtab = activeTab;
        layout.push(item); saveLayout();
        $('gal').close(); renderBoard();
        requestAnimationFrame(() => mounted.find((m) => m.item === item)?.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }));
      g.appendChild(it);
    }
    $('gal').showModal();
  }
  $('galClose').onclick = () => $('gal').close();

  // Inhalt eines Stapels wählen: alle kleinen Widgets, die in seiner Grösse gehen, Reihenfolge = Reihenfolge im Stapel
  function openStackPicker(item) {
    const cur = item.opts?.items || WIDGETS.stack.defaultOpts.items;
    const size = item.size || 'm';
    const all = Object.entries(HOME_WIDGETS).filter(([k, d]) => k !== 'stack' && d.sizes.includes(size)).map(([k]) => k);
    const order = [...cur.filter((k) => all.includes(k)), ...all.filter((k) => !cur.includes(k))];
    $('stkList').innerHTML = order.map((k) => `<label class="ios-row"><span>${esc(WIDGETS[k].title)}</span><input type="checkbox" value="${k}" ${cur.includes(k) ? 'checked' : ''}></label>`).join('');
    $('stkSave').onclick = () => {
      const items = [...$('stkList').querySelectorAll('input:checked')].map((x) => x.value);
      item.opts = { ...(item.opts || {}), items };
      saveLayout(); $('stkDlg').close(); renderBoard();
    };
    $('stkDlg').showModal();
  }
  $('stkCancel').onclick = () => $('stkDlg').close();

  // ---------- Kopfzeile & Status ----------
  // Akkustand in der Kopfzeile nur, wenn der Energiefluss nicht sichtbar ist (der zeigt ihn am Akku)
  function updateTopBat() {
    $('topBat').hidden = !state?.live?.bat || mounted.some((m) => m.item.type === 'flow' || m.item.type === 'soc');
  }
  function renderHeader() {
    const s = state;
    $('plantName').textContent = settings.plantName;
    document.title = settings.plantName;
    $('kwp').textContent = s.kwp ? `${f1.format(s.kwp)} kWp` : '';
    const b = s.live?.bat;
    updateTopBat();
    if (b) {
      const soc = Math.min(100, Math.max(0, b.soc));
      const st = b.charge > 15 ? `lädt mit ${power(b.charge)}` : b.discharge > 15 ? `entlädt mit ${power(b.discharge)}` : 'ruht';
      $('topBatFill').setAttribute('width', (20 * soc / 100).toFixed(1));
      $('topBat').classList.toggle('low', soc < 15);
      $('topBat').classList.toggle('chg', b.charge > 15);
      $('topBatPct').textContent = `${f0.format(soc)} %`;
      $('topBat').title = `Batterie ${f0.format(soc)} %, ${st}`;
      $('topBat').setAttribute('aria-label', $('topBat').title);
    }
    // Serverzeit statt Handy-Uhr vergleichen, sonst flackert die Anzeige bei abweichender Uhr
    const stale = !s.lastOk || (s.now ?? Date.now()) - s.lastOk > Math.max(s.pollSeconds * 3, 30) * 1000;
    // Statuszeile nur bei Problemen anzeigen
    $('status').className = 'status err';
    $('status').hidden = !(s.error || stale);
    const t = s.lastOk ? new Date(s.lastOk).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
    $('statusText').textContent = s.error ? (t ? `Keine Verbindung seit ${t}` : 'Keine Verbindung') : t ? `Keine neuen Daten seit ${t}` : 'Noch keine Daten';
    const al = $('alert');
    al.hidden = !s.error;
    if (s.error) al.textContent = `${s.error}. Prüfe, ob der Solar-Log unter ${s.source} erreichbar ist.${t ? ` Angezeigt werden die Daten von ${t}.` : ''}`;
    $('footer').textContent = s.demo ? 'Demo-Modus: Die angezeigten Daten sind simuliert.' : '';
    $('footer').hidden = !s.demo;
  }

  async function loadState() {
    try {
      state = await api('/api/state');
      settings = state.settings;
      renderHeader();
      for (const m of mounted) { try { m.ctx.update?.(); } catch (e) { console.error(e); } }
    } catch {
      $('status').className = 'status err';
      $('status').hidden = false;
      $('statusText').textContent = 'Dashboard-Server nicht erreichbar';
    }
  }

  // ---------- Menü ----------
  function closeMenu() { $('fabMenu').hidden = true; $('fabBtn').setAttribute('aria-expanded', 'false'); }
  $('fabBtn').onclick = () => setEditing(true); // Einstellungen gibt es nur im Bearbeiten-Modus (Zahnrad in der Leiste)
  $('fabMenu').addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'edit') setEditing(true);
    if (a === 'settings') { closeMenu(); openSettings(); }
  });
  document.addEventListener('click', (e) => { if (!$('fab').contains(e.target)) closeMenu(); });
  $('btnDone').onclick = () => setEditing(false);
  $('btnAdd').onclick = () => openGallery();
  $('btnSettings').onclick = () => openSettings();
  $('btnReset').onclick = async () => {
    const r = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resetLayout: true }) });
    layout = r.layout; renderBoard();
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, dialog')) return;
    if (e.key === 'Escape') { setEditing(false); closeMenu(); }
    if (e.key === 'e' && !e.metaKey && !e.ctrlKey) setEditing(!editing);
  });

  // Menü-Knopf blendet sich aus, wenn niemand die Maus bewegt (z. B. Wanddisplay)
  let idleTimer;
  const wake = () => { document.body.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => { if ($('fabMenu').hidden) document.body.classList.add('idle'); }, 3000); };
  ['pointermove', 'pointerdown', 'keydown', 'scroll'].forEach((ev) => window.addEventListener(ev, wake, { passive: true }));
  wake();

  // ---------- Einstellungen ----------
  const form = $('settingsForm');
  function fillInvNames(n, names) {
    $('invNames').innerHTML = Array.from({ length: n }, (_, i) => `<label class="ios-row"><span>Nr. ${i + 1}</span><input data-inv="${i}" maxlength="40" value="${esc(names[i] || `Wechselrichter ${i + 1}`)}"></label>`).join('');
  }
  function openSettings() {
    const s = settings;
    for (const k of ['plantName', 'inverterCount', 'tariffImport', 'tariffFeed', 'specificTarget', 'batteryCapacity']) form.elements[k].value = s[k] ?? 0;
    form.elements.location.value = s.location || '';
    form.elements.tariffAuto.value = s.tariffAuto === false ? '0' : '1';
    form.elements.tariffCategory.value = s.tariffCategory || 'H5';
    tariffForm();
    form.elements.pvTilt.value = s.pvTilt ?? 30;
    form.elements.pvOrientation.value = s.pvOrientation || '180';
    $('fcHint').textContent = (s.lat != null ? `Gefunden: ${s.placeLabel} (${f2.format(s.lat)}, ${f2.format(s.lon)}). ` : '')
      + 'Mehrere Dachflächen bei der Ausrichtung mit Komma trennen (gleich gross angenommen). Für die Prognose gehen nur Standort, Neigung und Ausrichtung an open-meteo.com. Standort leer lassen schaltet sie aus.';
    fillInvNames(s.inverterCount, s.inverterNames);
    $('monthDist').innerHTML = s.monthDist.map((v, i) => `<label>${MON[i]}<input data-md="${i}" type="text" inputmode="decimal" value="${v}"></label>`).join('');
    form.elements.theme.value = themePref();
    $('dlg').showModal();
  }
  // Netzbezug: automatisch aus den ElCom-Preisen der Gemeinde (Feld nur zur Anzeige) oder von Hand
  function tariffForm() {
    const s = settings, auto = form.elements.tariffAuto.value === '1', i = s.tariffInfo, rp = (x) => `${f1.format(x * 100)} Rp.`;
    const changed = auto !== (s.tariffAuto !== false) || form.elements.tariffCategory.value !== (s.tariffCategory || 'H5');
    form.elements.tariffImport.readOnly = auto;
    $('rowTariffCat').hidden = !auto;
    $('tariffHint').textContent = !auto ? 'Den Preis pro kWh von der Stromrechnung eintragen (Energie, Netz und Abgaben, ohne Grundgebühr).'
      : s.lat == null ? 'Dafür oben bei der Ertragsprognose den Standort eintragen.'
      : changed ? 'Der Preis wird beim Sichern geladen.'
      : i?.gemeinde ? `${i.operator ? `${i.operator}, ` : ''}Gemeinde ${i.gemeinde}, ${i.year}: ${rp(s.tariffImport)} pro kWh laut ElCom, ohne Grundgebühr (die fällt beim Eigenverbrauch nicht weg).`
        + (i.next != null ? ` ${Number(i.year) + 1}: ${rp(i.next)}` : '') + ' Frühere Jahre rechnet das Dashboard mit dem damaligen Preis.'
        + (i.error ? ` Letzte Aktualisierung fehlgeschlagen: ${i.error}` : '')
      : i?.error || 'Der Preis wird geladen.';
  }
  form.elements.tariffAuto.addEventListener('change', tariffForm);
  form.elements.tariffCategory.addEventListener('change', tariffForm);
  form.elements.inverterCount.addEventListener('input', (e) => {
    const n = Math.min(10, Math.max(1, Number(e.target.value) || 1));
    const cur = [...form.querySelectorAll('[data-inv]')].map((x) => x.value);
    fillInvNames(n, cur);
  });
  // Zahl aus einem Textfeld, Komma oder Punkt; leer = undefined, dann behält der Server den bisherigen Wert
  const num = (el) => { const v = String(el.value).trim().replace(',', '.'); return v === '' ? undefined : Number(v); };
  $('btnCancel').onclick = () => $('dlg').close();
  // Erscheinungsbild wirkt sofort und gilt nur für dieses Gerät
  form.elements.theme.addEventListener('change', (e) => {
    try { localStorage.setItem('solar.theme', e.target.value); } catch { /* egal */ }
    applyTheme(); readColors(); renderBoard();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btnSave');
    if (btn.disabled) return;
    const body = {
      plantName: form.elements.plantName.value,
      inverterCount: num(form.elements.inverterCount),
      tariffImport: num(form.elements.tariffImport),
      tariffAuto: form.elements.tariffAuto.value === '1',
      tariffCategory: form.elements.tariffCategory.value,
      tariffFeed: num(form.elements.tariffFeed),
      specificTarget: num(form.elements.specificTarget),
      batteryCapacity: num(form.elements.batteryCapacity),
      location: form.elements.location.value,
      pvTilt: num(form.elements.pvTilt),
      pvOrientation: form.elements.pvOrientation.value,
      inverterNames: [...form.querySelectorAll('[data-inv]')].map((x) => x.value),
      monthDist: [...form.querySelectorAll('[data-md]')].map((x) => num(x) ?? 0),
    };
    // Ortssuche und Prognose brauchen ein, zwei Sekunden, deshalb sichtbar warten
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Speichert…';
    try {
      const r = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: body }) });
      settings = r.settings;
      $('dlg').close();
      if (r.warning) alert(r.warning);
      fcData = null;
      await loadState();
      renderBoard();
    } catch {
      alert('Speichern hat nicht geklappt. Ist der Dashboard-Server erreichbar?');
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });

  // ---------- Solar-Rückblick ----------
  // Texte aus Regeln: Pro Karte werden mögliche Aussagen berechnet und nach Auffälligkeit bewertet (score),
  // nur die stärksten erscheinen. Die Formulierung wählt ein Hash aus Zeitraum und Aussage, damit sie beim
  // erneuten Öffnen gleich bleibt, sich aber von Monat zu Monat unterscheidet.
  const RV = { amber: ['#412402', '#FAEEDA'], copper: ['#633806', '#FAEEDA'], green: ['#27500A', '#EAF3DE'], teal: ['#085041', '#E1F5EE'],
    purple: ['#26215C', '#EEEDFE'], blue: ['#0C447C', '#E6F1FB'], forest: ['#173404', '#EAF3DE'] };
  const seedHash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const pickText = (seed, list) => list[seedHash(seed) % list.length];
  const strongest = (facts, n = 1) => facts.filter((f) => f && f.score > 0.5).sort((a, b) => b.score - a.score).slice(0, n).map((f) => f.text);
  const sumK = (arr, k) => arr.reduce((a, b) => a + (b[k] || 0), 0);
  const kWhBig = (wh) => nf(0).format(wh / 1000);
  const chf0 = (x) => `CHF ${nf(0).format(x)}`;
  const dayMonth = (day) => `${Number(day.slice(8))}. ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
  const monthTargetWh = (m) => state.kwp ? state.kwp * settings.specificTarget * settings.monthDist[m - 1] / 100 * 1000 : null;
  const measured = (arr) => arr.filter((d) => d.coveredWh != null && d.consWh);
  const autarky = (arr) => { const m = measured(arr); return m.length ? sumK(m, 'coveredWh') / sumK(m, 'consWh') : null; };
  const money = (arr) => { const m = measured(arr); return { own: m.reduce((a, d) => a + d.coveredWh / 1000 * impAt(d.day), 0), feed: sumK(m, 'feedWh') / 1000 * settings.tariffFeed, feedWh: sumK(m, 'feedWh') }; };
  const rvBig = (v, u) => `<div class="rv-big">${v}</div><div class="rv-unit">${u}</div>`;
  // Verbrauchskarte für Zeiträume ohne eigene Messung (der Solar-Log speichert nur Ertrag und Verbrauch)
  function consCard(arr, prevArr, prevLabel, seed) {
    const cd = arr.filter((d) => d.consWh && d.yieldWh != null);
    if (cd.length < 3) return null;
    const C = sumK(cd, 'consWh'), r = sumK(cd, 'yieldWh') / C;
    const pc = (prevArr || []).filter((d) => d.consWh), dc = pc.length >= cd.length * 0.9 ? C / sumK(pc, 'consWh') - 1 : null;
    return { theme: 'teal', k: 'Verbrauch', f: 'Wie viel davon direkt vom Dach kam, zeigt der Rückblick für Zeiträume, die das Dashboard selbst misst.',
      b: rvBig(kWhBig(C), 'kWh verbraucht')
        + rvP(r >= 1 ? pickText(seed + 'c', [`Deine Anlage hat rechnerisch ${nf(1).format(r)}-mal so viel produziert, wie du verbraucht hast.`, `Rechnerisch hast du ${nf(1).format(r)}-mal so viel Strom erzeugt wie verbraucht.`]) : `Deine Anlage hat rechnerisch ${pct(r)} % deines Verbrauchs produziert.`)
        + rvP(dc != null && Math.abs(dc) > 0.1 ? `${pct(Math.abs(dc))} % ${dc > 0 ? 'mehr' : 'weniger'} Verbrauch als ${prevLabel}.` : '') };
  }
  const rvP = (t) => t ? `<p class="rv-p">${t}</p>` : '';
  const rvBars = (rows) => `<div class="rv-vs">${rows.map(([l, v, o, max]) => `<div><div class="rv-vs-top"><span>${l}</span><span>${kWhBig(v)} kWh</span></div>
    <i style="opacity:${o};width:${Math.max(2, Math.round(v / max * 100))}%"></i></div>`).join('')}</div>`;

  function ratioText(seed, ratio, noun) {
    const x = pct(ratio);
    if (ratio >= 1.1) return pickText(seed, [`Ein starker ${noun}: ${x} % des Solls.`, `Deutlich über dem Soll, ${x} %.`]);
    if (ratio >= 0.95) return pickText(seed, [`Ziemlich genau im Soll (${x} %).`, `Im Soll: ${x} %.`]);
    if (ratio >= 0.8) return pickText(seed, [`${x} % des Solls.`, `Etwas unter dem Soll, ${x} %.`]);
    return pickText(seed, [`Ein schwacher ${noun}, nur ${x} % des Solls.`, `Deutlich unter dem Soll: ${x} %.`]);
  }
  // längste Folge trüber Tage (unter 40 % des Tagessolls)
  function weakStreak(days) {
    let run = [], longest = [];
    for (const d of days) {
      if (d.yieldWh != null && d.targetWh && d.yieldWh < d.targetWh * 0.4) { run.push(d); if (run.length > longest.length) longest = [...run]; } else run = [];
    }
    return longest.length >= 3 ? longest : null;
  }
  // längste Folge aufeinanderfolgender Tage, die eine Bedingung erfüllen
  function longestRun(days, test) {
    let run = 0, best = 0, prev = null;
    for (const d of days) {
      if (test(d)) { run = prev && addDays(prev, 1) === d.day ? run + 1 : 1; best = Math.max(best, run); prev = d.day; } else { run = 0; prev = null; }
    }
    return best;
  }
  function calendar(y, m, days) {
    const first = (new Date(y, m - 1, 1).getDay() + 6) % 7, max = Math.max(1, ...days.map((d) => d.yieldWh || 0));
    const top = days.reduce((a, d) => (d.yieldWh || 0) > (a?.yieldWh || 0) ? d : a, null);
    return `<div class="rv-cal">${['M', 'D', 'M', 'D', 'F', 'S', 'S'].map((d) => `<b>${d}</b>`).join('')}${'<span></span>'.repeat(first)}${days.map((d) => {
      const v = d.yieldWh, a = v == null ? 0.06 : 0.12 + 0.78 * v / max;
      return `<span title="${dayMonth(d.key)}: ${v == null ? 'keine Daten' : kWhU(v)}"><i style="opacity:${a.toFixed(2)}"></i><em class="${a > 0.55 ? 'dark' : ''}${d === top ? ' top' : ''}">${Number(d.key.slice(8))}</em></span>`;
    }).join('')}</div>`;
  }

  async function buildMonthReview(ref) {
    const [y, m] = ref.split('-').map(Number), name = MONTHS[m - 1], seed = ref;
    const ser = (r) => api(`/api/series?period=month&ref=${r}`).then((s) => s.buckets).catch(() => []);
    const [all, prevAll, lastYear, yearSer] = await Promise.all([ser(ref), ser(shiftRef('month', ref, -1)), ser(`${y - 1}-${pad(m)}`),
      api(`/api/series?period=year&ref=${y}`).then((s) => s.buckets).catch(() => [])]);
    const today = state.today?.day || '';
    const isCurrent = ref === currentRef('month');
    const days = all.filter((d) => d.key <= today);
    const done = days.filter((d) => d.key < today || !isCurrent); // abgeschlossene Tage für Rekorde
    const withY = days.filter((d) => d.yieldWh != null);
    if (withY.length < 3) return null;
    const Y = sumK(withY, 'yieldWh'), T = sumK(withY, 'targetWh');
    const cards = [];

    // 1 Ertrag
    const facts1 = [];
    const ws = weakStreak(done);
    if (ws) facts1.push({ score: ws.length / 3, text: pickText(seed + 'ws', [`Die trüben Tage vom ${Number(ws[0].key.slice(8))}. bis ${dayMonth(ws.at(-1).key)} haben gekostet.`, `Vom ${Number(ws[0].key.slice(8))}. bis ${dayMonth(ws.at(-1).key)} kam kaum Sonne durch.`]) });
    if (done.length >= 14) {
      const half = Math.floor(done.length / 2), a = sumK(done.slice(0, half), 'yieldWh') / half, b = sumK(done.slice(half), 'yieldWh') / (done.length - half);
      const r = (a - b) / Math.max(a, b, 1);
      if (Math.abs(r) > 0.25) facts1.push({ score: Math.abs(r) * 3, text: r > 0 ? pickText(seed + 'h', ['Der Monatsanfang war stark, danach wurde es trüber.', 'Die erste Monatshälfte war deutlich sonniger als die zweite.']) : pickText(seed + 'h', ['Nach einem trüben Start wurde es deutlich besser.', 'Die zweite Monatshälfte war viel sonniger als die erste.']) });
    }
    const ly = lastYear.filter((d) => d.yieldWh != null && Number(d.key.slice(8)) <= Number((days.at(-1)?.key || '').slice(8)));
    if (ly.length >= withY.length * 0.9) {
      const d = Y / sumK(ly, 'yieldWh') - 1;
      if (Math.abs(d) > 0.1) facts1.push({ score: Math.abs(d) * 4, text: `${pct(Math.abs(d))} % ${d > 0 ? 'mehr' : 'weniger'} als im ${name} ${y - 1}.` });
    }
    cards.push({ theme: 'amber', k: `Dein ${name}${isCurrent ? ' bisher' : ''}`, f: isCurrent ? '' : 'Tippen für weiter',
      b: rvBig(kWhBig(Y), 'kWh produziert') + (T ? rvBars([['Ist', Y, 1, Math.max(Y, T)], [isCurrent ? 'Soll bis heute' : 'Soll', T, 0.45, Math.max(Y, T)]]) : '')
        + rvP([T ? ratioText(seed + 'r', Y / T, 'Monat') : '', ...strongest(facts1)].filter(Boolean).join(' ')) });

    // 2 Kalender
    const rated = done.filter((d) => d.yieldWh != null);
    if (rated.length >= 3) {
      const top = rated.reduce((a, d) => d.yieldWh > a.yieldWh ? d : a), low = rated.reduce((a, d) => d.yieldWh < a.yieldWh ? d : a);
      const over = rated.filter((d) => d.targetWh && d.yieldWh >= d.targetWh).length;
      cards.push({ theme: 'copper', k: 'Tag für Tag', f: 'Je heller, desto mehr Ertrag',
        b: `<div class="rv-h">Bester Tag: ${dayMonth(top.key)}</div><div class="rv-unit">${kWhU(top.yieldWh)}${top.peakW ? `, Spitze ${power(top.peakW)}` : ''}</div>`
          + calendar(y, m, all) + rvP(`Schwächster Tag: ${dayMonth(low.key)} mit ${kWhU(low.yieldWh)}.${over ? ` An ${over} ${over === 1 ? 'Tag' : 'Tagen'} über dem Tagessoll.` : ''}`) });
    }

    // 3 Unabhängigkeit
    const meas = measured(days);
    if (meas.length >= 3) {
      const aut = autarky(days), prevAut = measured(prevAll).length >= 3 ? autarky(prevAll) : null;
      const dis = sumK(meas, 'disWh'), noGrid = meas.filter((d) => (d.importWh ?? 1e9) < 300).length;
      const facts3 = [
        dis > 1000 && { score: 1.2, text: pickText(seed + 'b', [`Die Batterie hat ${kWhU(dis)} in die Abende gebracht.`, `Aus der Batterie kamen ${kWhU(dis)}, vor allem abends und nachts.`]) },
        noGrid >= 2 && { score: noGrid / 3, text: `An ${noGrid} Tagen hast du fast keinen Netzstrom gebraucht.` },
        prevAut != null && Math.abs(aut - prevAut) > 0.08 && { score: Math.abs(aut - prevAut) * 8, text: aut > prevAut ? `Das sind ${pct(aut - prevAut)} Prozentpunkte mehr als im ${MONTHS[(m + 10) % 12]}.` : `Das sind ${pct(prevAut - aut)} Prozentpunkte weniger als im ${MONTHS[(m + 10) % 12]}${m >= 8 ? ', die Tage werden kürzer' : ''}.` },
        { score: 0.8, text: `Vom eigenen Solarstrom hast du ${pct(sumK(meas, 'selfWh') / Math.max(1, sumK(meas, 'yieldWh')))} % selbst genutzt.` },
      ];
      cards.push({ theme: 'teal', k: 'Unabhängigkeit', f: [prevAut != null ? `Vormonat: ${pct(prevAut)} %` : '', meas.length < days.length ? `Gemessen an ${meas.length} von ${days.length} Tagen` : ''].filter(Boolean).join(' · '),
        b: rvBig(`${pct(aut)} %`, 'autark') + strongest(facts3, 2).map(rvP).join('') });

      // 4 Gespart
      const v = money(days), ytd = yearSer.filter((b) => b.key <= ref && b.coveredWh != null);
      const vy = ytd.length > 1 ? ytd.reduce((a, b) => a + b.coveredWh / 1000 * impAt(b.key) + (b.feedWh || 0) / 1000 * settings.tariffFeed, 0) : null;
      cards.push({ theme: 'blue', k: 'Gespart', f: meas.length < days.length ? `Gemessen an ${meas.length} von ${days.length} Tagen` : '',
        b: rvBig(chf0(v.own + v.feed), `im ${name}${isCurrent ? ' bisher' : ''}`)
          + rvP(`${chf0(v.own)} durch eigenen Strom statt Netzbezug, ${chf0(v.feed)} Vergütung für ${kWhU(v.feedWh)} Einspeisung.`)
          + rvP(vy ? `Seit Januar zusammen ${chf0(vy)}.` : '') });
    }

    if (meas.length < 3) { const c = consCard(days, ly.length ? lastYear.slice(0, days.length) : null, `im ${name} ${y - 1}`, seed); if (c) cards.push(c); }

    // 5 Ausblick
    if (isCurrent) {
      const rest = all.filter((d) => d.key > today), restT = sumK(rest, 'targetWh');
      if (rest.length && restT) cards.push({ theme: 'purple', k: 'Bis Monatsende', b: `<div class="rv-h">Noch ${rest.length} ${rest.length === 1 ? 'Tag' : 'Tage'}</div>` + rvP(`Nach Soll kommen noch rund ${kWhU(restT)} dazu, dann wären es ca. ${kWhU(Y + restT)} für den ${name}.`), f: 'Nochmals ansehen' });
    } else {
      const nm = m % 12 + 1, nt = monthTargetWh(nm);
      if (nt) {
        const r = nt / Math.max(Y, 1) - 1;
        const head = r < -0.15 ? 'Jetzt wird es dunkler' : r > 0.15 ? 'Es wird heller' : 'Ähnlich weiter';
        const tip = r < -0.15 ? 'Tipp: Grossverbraucher möglichst zwischen 11 und 15 Uhr laufen lassen.' : r > 0.15 ? 'Mehr Überschuss: Waschmaschine, Geschirrspüler und Auto laden lohnen sich jetzt tagsüber.' : '';
        cards.push({ theme: 'purple', k: `Ausblick ${MONTHS[nm - 1]}`, f: 'Nochmals ansehen',
          b: `<div class="rv-h">${head}</div>` + rvP(`Im ${MONTHS[nm - 1]} erwartest du nach Soll rund ${kWhU(nt)}${Math.abs(r) > 0.05 ? `, ${pct(Math.abs(r))} % ${r < 0 ? 'weniger' : 'mehr'} als im ${name}` : ''}.`) + rvP(tip) });
      }
    }
    if (!cards.at(-1).f) cards.at(-1).f = 'Nochmals ansehen';
    return { title: `${name} ${y}`, cards };
  }

  async function buildYearReview(y) {
    const seed = String(y), isCurrent = String(y) === currentRef('year');
    const [months, prevMonths, days] = await Promise.all([
      api(`/api/series?period=year&ref=${y}`).then((s) => s.buckets), api(`/api/series?period=year&ref=${y - 1}`).then((s) => s.buckets).catch(() => []),
      api(`/api/daysrange?from=${y}-01-01&to=${y}-12-31`).catch(() => [])]);
    const withY = months.filter((b) => b.yieldWh);
    if (!withY.length) return null;
    const Y = sumK(withY, 'yieldWh'), kwp = state.kwp, cards = [];
    const curM = isCurrent ? Number(currentRef('month').slice(5)) : 12, dom = Number((state.today?.day || '').slice(8)) || 1;
    const T = months.reduce((a, b, i) => a + (i + 1 < curM ? b.targetWh || 0 : i + 1 === curM ? (b.targetWh || 0) * (isCurrent ? dom / new Date(y, curM, 0).getDate() : 1) : 0), 0);
    const ly = sumK(prevMonths.slice(0, curM).filter((b) => b.yieldWh), 'yieldWh');

    // 1 Jahr
    cards.push({ theme: 'amber', k: `Dein Solarjahr ${y}${isCurrent ? ' bisher' : ''}`, f: 'Tippen für weiter',
      b: `<div class="rv-h">Deine Anlage hat ${isCurrent ? 'bisher' : 'dieses Jahr'}</div>` + rvBig(kWhBig(Y), 'kWh produziert')
        + rvP([kwp ? `Das sind ${nf(0).format(Y / 1000 / kwp)} kWh pro kWp.` : '', T ? ratioText(seed + 'r', Y / T, 'Jahr') : '',
          ly > Y * 0.5 ? `${pct(Math.abs(Y / ly - 1))} % ${Y >= ly ? 'mehr' : 'weniger'} als ${y - 1} im gleichen Zeitraum.` : ''].filter(Boolean).join(' ')) });

    // 2 Rekordtag
    const rated = days.filter((d) => d.yieldWh != null);
    if (rated.length) {
      const top = rated.reduce((a, d) => d.yieldWh > a.yieldWh ? d : a);
      const cd = days.filter((d) => d.consWh), avgCons = cd.length >= 7 ? sumK(cd, 'consWh') / cd.length : null;
      cards.push({ theme: 'copper', k: 'Dein Rekordtag', b: rvBig(`${kWhBig(top.yieldWh)} kWh`, `am ${dayMonth(top.day)}`)
        + rvP([top.peakW ? `Spitze ${power(top.peakW)}.` : '', avgCons && top.yieldWh / avgCons >= 2 ? `Damit hättest du dein Haus ${nf(0).format(top.yieldWh / avgCons)} Tage lang versorgen können.` : ''].filter(Boolean).join(' ')) });
    }

    // 3 Monate
    if (withY.length >= 2) {
      const max = Math.max(...withY.map((b) => b.yieldWh)), best = withY.find((b) => b.yieldWh === max), low = withY.reduce((a, b) => b.yieldWh < a.yieldWh ? b : a);
      cards.push({ theme: 'green', k: 'Sonnigster Monat', f: `${MONTHS[Number(low.key.slice(5)) - 1]} war mit ${kWhU(low.yieldWh)} der dunkelste.`,
        b: `<div class="rv-h">${MONTHS[Number(best.key.slice(5)) - 1]}</div><div class="rv-unit">${kWhU(best.yieldWh)}</div>
          <div class="rv-months">${months.map((b, i) => `<div><i style="height:${Math.round((b.yieldWh || 0) / max * 100)}%;opacity:${b === best ? 1 : 0.35}"></i><span>${'JFMAMJJASOND'[i]}</span></div>`).join('')}</div>` });
    }

    // 4 Autarkie, 5 Batterie, 6 Gespart
    const meas = measured(days);
    if (meas.length >= 7) {
      const aut = autarky(days), high = meas.filter((d) => d.coveredWh / d.consWh >= 0.95).length;
      const run = longestRun(meas, (d) => d.coveredWh / d.consWh >= 0.95);
      cards.push({ theme: 'teal', k: 'Autarkie', f: meas.length < rated.length ? `Gemessen an ${meas.length} Tagen` : '',
        b: rvBig(`${pct(aut)} %`, 'deines Stroms kam vom eigenen Dach') + rvP([high ? `An ${high} Tagen warst du zu über 95 % unabhängig.` : '', run >= 3 ? `Die längste Serie: ${run} Tage am Stück.` : ''].filter(Boolean).join(' ')) });
      const chg = sumK(meas, 'chgWh'), dis = sumK(meas, 'disWh'), cap = settings.batteryCapacity;
      if (dis > 5000) {
        const byMonth = {}; meas.forEach((d) => { byMonth[d.day.slice(5, 7)] = (byMonth[d.day.slice(5, 7)] || 0) + (d.disWh || 0); });
        const bm = Object.entries(byMonth).sort((a, b) => b[1] - a[1])[0];
        cards.push({ theme: 'purple', k: 'Deine Batterie', b: cap ? rvBig(nf(0).format(chg / 1000 / cap), 'volle Ladezyklen') + rvP(`Sie hat ${kWhU(dis)} in die Abende und Nächte gebracht.`) : rvBig(kWhBig(dis), 'kWh aus der Batterie'),
          f: bm ? `Am fleissigsten war sie im ${MONTHS[Number(bm[0]) - 1]}.` : '' });
      }
      const v = money(days);
      cards.push({ theme: 'blue', k: 'Gespart', f: meas.length < rated.length ? `Gemessen an ${meas.length} Tagen` : '',
        b: rvBig(chf0(v.own + v.feed), 'Wert deines Solarstroms') + rvP(`${chf0(v.own)} durch eigenen Strom statt Netzbezug, ${chf0(v.feed)} Vergütung für die Einspeisung.`) });
    } else {
      const end = isCurrent ? (state.today?.day || '').slice(5) : '12-31';
      const prevDays = await api(`/api/daysrange?from=${y - 1}-01-01&to=${y - 1}-${end}`).catch(() => []);
      const c = consCard(days, prevDays, isCurrent ? `${y - 1} im gleichen Zeitraum` : String(y - 1), seed);
      if (c) cards.push(c);
    }

    // 7 Vergleiche (Faustwerte, im Fuss genannt)
    const km = Y / 1000 / 0.17, co2 = Y / 1000 * 0.128;
    cards.push({ theme: 'forest', k: 'So viel ist das', f: 'Annahmen: 17 kWh pro 100 km, Schweizer Verbrauchermix 128 g CO₂ pro kWh, ein Baum bindet 12.5 kg CO₂ im Jahr.',
      b: rvBig(`${nf(0).format(Math.round(km / 100) * 100)} km`, 'mit einem E-Auto') + rvP(`Oder ${nf(1).format(co2 / 1000)} Tonnen CO₂ weniger als mit Strom aus dem Netz. So viel binden etwa ${nf(0).format(co2 / 12.5)} Bäume in einem Jahr.`) });

    // 8 Wechselrichter
    const inv = months.reduce((a, b) => { (b.inv || []).forEach((w, i) => { a[i] = (a[i] || 0) + (w || 0); }); return a; }, []);
    const invSumAll = inv.reduce((a, b) => a + b, 0);
    if (inv.length >= 2 && invSumAll > 0) {
      const name = (i) => settings.inverterNames[i] || `Wechselrichter ${i + 1}`;
      cards.push({ theme: 'amber', k: 'Deine Wechselrichter', b: `<div class="rv-h">${inv.map((w, i) => `${esc(name(i))}: ${pct(w / invSumAll)} %`).join('<br>')}</div>`
        + rvP(`Am meisten lieferte ${esc(name(inv.indexOf(Math.max(...inv))))}.`) });
    }
    cards.at(-1).f ||= 'Nochmals ansehen';
    return { title: String(y), cards };
  }

  // Anzeige: Karten zum Durchtippen (rechts weiter, links zurück, Pfeiltasten, Esc)
  let rv = null;
  function rvShow() {
    const c = rv.cards[rv.i], [bg, fg] = RV[c.theme] || RV.amber, card = $('rvCard');
    card.style.background = bg; card.style.color = fg;
    $('rvBars').innerHTML = rv.cards.map((_, j) => `<i style="opacity:${j <= rv.i ? 0.9 : 0.25}"></i>`).join('');
    $('rvKicker').textContent = c.k; $('rvBody').innerHTML = c.b; $('rvFoot').textContent = c.f || '';
  }
  const rvGo = (d) => { rv.i = (rv.i + d + rv.cards.length) % rv.cards.length; rvShow(); };
  async function openReview(period, ref) {
    try { localStorage.setItem(`solar.review.${period}-${ref}`, '1'); } catch { /* egal */ }
    $('rvBanner').hidden = true;
    const r = period === 'year' ? await buildYearReview(Number(ref)) : await buildMonthReview(ref);
    if (!r) { alert('Für diesen Zeitraum gibt es noch zu wenige Daten für einen Rückblick.'); return; }
    rv = { ...r, i: 0 };
    rvShow();
    $('rv').showModal();
  }
  $('rvCard').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); rvGo(e.clientX - r.left < r.width / 3 ? -1 : 1); });
  $('rvClose').onclick = () => $('rv').close();
  $('rv').addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') rvGo(1); if (e.key === 'ArrowLeft') rvGo(-1); });
  // Hinweis in der ersten Woche eines neuen Monats (im Januar zusätzlich das Jahr), bis er angesehen oder weggeklickt wurde
  async function checkReviewBanner() {
    const today = state?.today?.day;
    if (!today || Number(today.slice(8)) > 7) return;
    const prev = shiftRef('month', today.slice(0, 7), -1);
    const cand = today.slice(5, 7) === '01' ? [['year', prev.slice(0, 4), `Dein Solarjahr ${prev.slice(0, 4)} ist da`], ['month', prev, `Dein ${MONTHS[Number(prev.slice(5)) - 1]} ist da`]] : [['month', prev, `Dein ${MONTHS[Number(prev.slice(5)) - 1]} ist da`]];
    for (const [period, ref, text] of cand) {
      try { if (localStorage.getItem(`solar.review.${period}-${ref}`)) continue; } catch { /* egal */ }
      const s = await api(`/api/series?period=${period}&ref=${ref}`).catch(() => null);
      if (!s || s.buckets.filter((b) => b.yieldWh).length < (period === 'year' ? 1 : 5)) continue;
      const b = $('rvBanner');
      b.innerHTML = `<span><i aria-hidden="true">✦</i> ${text}</span><button class="btn primary" type="button" data-a="open">Ansehen</button><button class="btn" type="button" data-a="dismiss" aria-label="Ausblenden">✕</button>`;
      b.onclick = (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'open') openReview(period, ref);
        if (a === 'dismiss') { try { localStorage.setItem(`solar.review.${period}-${ref}`, '1'); } catch { /* egal */ } b.hidden = true; }
      };
      b.hidden = false;
      return;
    }
  }

  // Tippen auf die Statusleiste (iOS) scrollt immer die Seite im Hintergrund nach oben. Ist ein Blatt offen, fangen wir
  // das ab: Hintergrund bleibt stehen, stattdessen springt der Inhalt des Blatts nach oben.
  let sheetLockY = null;
  const openSheet = () => [...document.querySelectorAll('dialog[open]')].pop();
  document.querySelectorAll('dialog').forEach((d) => new MutationObserver(() => {
    if (d.open) { if (window.scrollY < 2) window.scrollTo(0, 2); sheetLockY = window.scrollY; }
    else if (!openSheet()) sheetLockY = null;
  }).observe(d, { attributes: true, attributeFilter: ['open'] }));
  window.addEventListener('scroll', () => {
    if (sheetLockY == null || !openSheet()) return;
    if (window.scrollY < sheetLockY - 1) {
      const d = openSheet(), box = d.querySelector('.ios-body') || d;
      box.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo(0, sheetLockY);
    }
  }, { passive: true });

  // ---------- Start ----------
  (async () => {
    readColors();
    const s = await api('/api/settings').catch(() => null);
    // entfernte Widget-Typen aus dem gespeicherten Layout werfen
    layout = (s?.layout || []).filter((i) => WIDGETS[i.type]);
    if (s?.layout && layout.length !== s.layout.length) saveLayout();
    await loadState();
    if (!state) { setTimeout(() => location.reload(), 10000); return; }
    renderBoard();
    // Direktlink: ?rueckblick=2026-09 (Monat) oder ?rueckblick=2025 (Jahr)
    const rq = new URLSearchParams(location.search).get('rueckblick');
    if (/^\d{4}-\d{2}$/.test(rq || '')) openReview('month', rq);
    else if (/^\d{4}$/.test(rq || '')) openReview('year', rq);
    else checkReviewBanner();
    setInterval(loadState, 5000); // Server fragt den Solar-Log ab, hier nur den letzten Stand holen
    applyDaypart(); setInterval(applyDaypart, 60000);
    setInterval(() => mounted.forEach((m) => m.ctx.refresh?.()), 5 * 60000);
  })();

  // Diagramme rechnen schmal mit gröberer Auflösung: beim Wechsel schmal/breit neu aufbauen
  let wasWide = isWide(), rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (isWide() !== wasWide) { wasWide = isWide(); renderBoard(); } }, 200); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); readColors(); renderBoard(); });
})();
