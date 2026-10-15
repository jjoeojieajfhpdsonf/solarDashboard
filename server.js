// Solar-Dashboard – Backend
// Fragt den Solar-Log ab, speichert den Verlauf in SQLite und liefert API + Frontend.
// Keine npm-Abhängigkeiten (Node >= 22.13).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const CFG = {
  port: Number(env.PORT || 8080),
  solarlog: (env.SOLARLOG_URL || 'http://192.168.0.76').replace(/\/$/, ''),
  pollMs: Number(env.POLL_SECONDS || 30) * 1000,
  dbPath: env.DB_PATH || path.join(__dirname, 'data', 'solar.db'),
  tz: env.TZ || 'Europe/Zurich',
  demo: env.DEMO === '1',
  pushContact: env.PUSH_CONTACT || 'mailto:solar-dashboard@example.com', // Absenderangabe für die Push-Dienste (VAPID)
};

// Standard-Einstellungen (im Dashboard änderbar)
const DEFAULT_SETTINGS = {
  plantName: env.PLANT_NAME || 'Solaranlage',
  tariffImport: Number(env.TARIFF_IMPORT || 0.30),
  tariffFeed: Number(env.TARIFF_FEED || 0.10),
  // Netzbezug automatisch aus den Strompreisen der Gemeinde (ElCom), Verbrauchsprofil H1–H8
  tariffAuto: true, tariffCategory: 'H5',
  specificTarget: 1000, // kWh pro kWp und Jahr
  // typische Verteilung Schweizer Mittelland in % des Jahresertrags
  monthDist: [3, 5, 8.5, 11, 12.5, 13, 13.5, 12, 9, 6, 3.5, 3],
  inverterCount: Number(env.INVERTER_COUNT || 2),
  inverterNames: (env.INVERTER_NAMES || 'Wechselrichter 1,Wechselrichter 2').split(',').map((s) => s.trim()),
  batteryCapacity: Number(env.BATTERY_KWH || 0), // kWh, 0 = unbekannt
  // Ertragsprognose: ohne Standort aus, dann gibt es keine Anfragen nach aussen
  location: '', lat: null, lon: null, placeLabel: '',
  // Push-Mitteilungen (gehen nur an Geräte, die sie in den Einstellungen erlaubt haben)
  pushOutage: true, pushFull: true, pushEvening: true, pushEveningTime: '19:00',
  pvTilt: 30, pvOrientation: '180',
};

// Raster mit 12 Spalten, Höhe in Rasterzeilen (je ca. 40 px)
// iPhone-Stil: Grössen s (1×1), m (2×1), l (2×2), xl (ganze Breite); Reihenfolge = Reihenfolge im Tab (mtab)
const DEFAULT_LAYOUT = [
  { type: 'flow', size: 'xl' },
  { type: 'mode', size: 's' },
  { type: 'soc', size: 's' },
  { type: 'today', size: 'm' },
  { type: 'stack', size: 'm', opts: { items: ['window', 'batEta', 'tomorrow', 'month'] } },
  { type: 'solarNow', size: 's' },
  { type: 'gridNow', size: 's' },
  { type: 'day', size: 'xl' },
  { type: 'sankey', size: 'l' },
  { type: 'dayYield', size: 's' },
  { type: 'daySun', size: 's' },
  { type: 'dayBattery', size: 's' },
  { type: 'dayRatio', size: 'm' },
  { type: 'dayGrid', size: 's' },
  { type: 'battery', size: 'xl' },
  { type: 'month', size: 's', mtab: 'bal' },
  { type: 'yearSoll', size: 's' },
  { type: 'money', size: 'm' },
  { type: 'total', size: 'm' },
  { type: 'balance', size: 'xl', opts: { period: 'month', mode: 'split', target: true } },
  { type: 'target', size: 'l' },
  { type: 'ratioYear', size: 's' },
  { type: 'polar', size: 'l' },
  { type: 'invCompare', size: 'm' },
  { type: 'record', size: 's' },
  { type: 'yoy', size: 's' },
  { type: 'avg30', size: 'm' },
  { type: 'inverters', size: 'l' },
  { type: 'ratios', size: 'l', opts: { days: 30 } },
  { type: 'heatmap', size: 'xl', opts: { days: 90 } },
  { type: 'typical', size: 'l' },
  { type: 'yearCompare', size: 'l', opts: { cumulative: false } },
];

// ---------- Datenbank ----------
mkdirSync(path.dirname(CFG.dbPath), { recursive: true });
const db = new DatabaseSync(CFG.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS samples (ts INTEGER PRIMARY KEY, pv INTEGER NOT NULL, cons INTEGER NOT NULL, inv TEXT);
  CREATE TABLE IF NOT EXISTS days (
    day TEXT PRIMARY KEY, yield_wh REAL, cons_wh REAL, self_wh REAL, peak_w INTEGER, inv TEXT, src TEXT DEFAULT 'live'
  );
  CREATE TABLE IF NOT EXISTS hours (day TEXT, hour INTEGER, pv_wh REAL, cons_wh REAL, PRIMARY KEY (day, hour));
  CREATE TABLE IF NOT EXISTS months_hist (month TEXT PRIMARY KEY, yield_wh REAL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);
// Migration: Datenbanken aus der ersten Version um neue Spalten ergänzen
{
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('samples').includes('inv')) db.exec('ALTER TABLE samples ADD COLUMN inv TEXT');
  if (!cols('days').includes('inv')) db.exec('ALTER TABLE days ADD COLUMN inv TEXT');
  if (!cols('days').includes('src')) db.exec("ALTER TABLE days ADD COLUMN src TEXT DEFAULT 'live'");
  for (const c of ['import_wh', 'feed_wh', 'chg_wh', 'dis_wh']) if (!cols('days').includes(c)) db.exec(`ALTER TABLE days ADD COLUMN ${c} REAL`);
  for (const c of ['soc', 'bat']) if (!cols('samples').includes(c)) db.exec(`ALTER TABLE samples ADD COLUMN ${c} INTEGER`);
}

const q = {
  insertSample: db.prepare('INSERT OR REPLACE INTO samples (ts, pv, cons, inv, soc, bat) VALUES (?, ?, ?, ?, ?, ?)'),
  lastSample: db.prepare('SELECT ts, pv, cons, inv, soc, bat FROM samples ORDER BY ts DESC LIMIT 1'),
  samplesBetween: db.prepare('SELECT ts, pv, cons, inv, soc, bat FROM samples WHERE ts >= ? AND ts < ? ORDER BY ts'),
  setSoc: db.prepare('UPDATE samples SET soc = ? WHERE ts = ?'),
  prune: db.prepare('DELETE FROM samples WHERE ts < ?'),
  day: db.prepare('SELECT * FROM days WHERE day = ?'),
  putDay: db.prepare(`INSERT OR REPLACE INTO days (day, yield_wh, cons_wh, self_wh, peak_w, inv, src, import_wh, feed_wh, chg_wh, dis_wh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  allDays: db.prepare('SELECT * FROM days ORDER BY day'),
  daysRange: db.prepare('SELECT * FROM days WHERE day >= ? AND day <= ? ORDER BY day'),
  lastDays: db.prepare('SELECT * FROM days ORDER BY day DESC LIMIT ?'),
  anyDay: db.prepare('SELECT 1 FROM days LIMIT 1'),
  firstDay: db.prepare('SELECT MIN(day) AS day FROM days'),
  histDays: db.prepare("SELECT day FROM days WHERE src = 'hist' ORDER BY day DESC"),
  liveDays: db.prepare("SELECT day FROM days WHERE src = 'live' AND day >= ? AND day < ? ORDER BY day"),
  delHours: db.prepare('DELETE FROM hours WHERE day = ?'),
  addHour: db.prepare(`INSERT INTO hours (day, hour, pv_wh, cons_wh) VALUES (?, ?, ?, ?)
    ON CONFLICT(day, hour) DO UPDATE SET pv_wh = pv_wh + excluded.pv_wh, cons_wh = cons_wh + excluded.cons_wh`),
  hoursRange: db.prepare('SELECT day, hour, pv_wh FROM hours WHERE day >= ? ORDER BY day, hour'),
  putMonthHist: db.prepare('INSERT OR REPLACE INTO months_hist (month, yield_wh) VALUES (?, ?)'),
  monthsHist: db.prepare('SELECT month, yield_wh FROM months_hist ORDER BY month'),
  monthAgg: db.prepare(`SELECT substr(day, 1, 7) AS month, SUM(yield_wh) y, SUM(cons_wh) c,
    SUM(self_wh) s, COUNT(self_wh) ns, COUNT(cons_wh) nc, COUNT(*) n FROM days GROUP BY month ORDER BY month`),
  setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
};
const meta = (k, fallback) => { const r = q.getMeta.get(k); return r ? JSON.parse(r.value) : fallback; };
const setMeta = (k, v) => q.setMeta.run(k, JSON.stringify(v));

let settings = { ...DEFAULT_SETTINGS, ...meta('settings', {}) };
// echtes 3D-Haus (swisstopo) gibt es nicht mehr: alte Einstellungen und das gespeicherte Haus entfernen
for (const k of ['houseModel', 'houseRot', 'facadeColor']) delete settings[k];
q.setMeta.run('building', 'null');
let layout = meta('layout', DEFAULT_LAYOUT);
// Prognose-Widget einmalig direkt unter dem Energiefluss einfügen (bestehende Layouts)
if (!meta('forecastWidgetAdded', false)) {
  if (!layout.some((w) => w.type === 'forecast')) {
    const flow = layout.find((w) => w.type === 'flow'), at = flow ? (flow.y ?? 0) + (flow.h ?? 9) : 0, hgt = 6;
    layout = [...layout.map((w) => (w.y != null && w.y >= at ? { ...w, y: w.y + hgt } : w)), { type: 'forecast', x: 0, y: at, w: 12, h: hgt }];
    setMeta('layout', layout);
  }
  setMeta('forecastWidgetAdded', true);
}
// Neues Design: Haus etwas höher, Status-Widget einmalig direkt darunter
if (!meta('statusWidgetAdded', false)) {
  if (!layout.some((w) => w.type === 'status')) {
    const flow = layout.find((w) => w.type === 'flow'), grow = flow && (flow.h ?? 9) < 10 ? 10 - (flow.h ?? 9) : 0;
    const at = flow ? (flow.y ?? 0) + (flow.h ?? 9) : 0, hgt = 5;
    layout = [...layout.map((w) => w === flow ? { ...w, h: (w.h ?? 9) + grow } : (w.y != null && w.y >= at ? { ...w, y: w.y + hgt + grow } : w)),
      { type: 'status', x: 0, y: at + grow, w: 12, h: hgt }];
    setMeta('layout', layout);
  }
  setMeta('statusWidgetAdded', true);
}
// Home-Überblick: Prognose, Kennzahlen und Batterie stecken jetzt im Überblick und im Tagesverlauf; einmalig entfernen
// (lassen sich im Anpassen-Modus wieder hinzufügen)
if (!meta('homeRich', false)) {
  const st = layout.find((w) => w.type === 'status');
  if (st && (st.h ?? 5) < 9) {
    const grow = 9 - (st.h ?? 5), at = (st.y ?? 0) + (st.h ?? 5);
    layout = layout.map((w) => (w === st ? { ...w, h: 9 } : w.y != null && w.y >= at ? { ...w, y: w.y + grow } : w));
    setMeta('layout', layout);
  }
  setMeta('homeRich', true);
}
if (!meta('homeCleanup', false)) {
  layout = layout.filter((w) => !['forecast', 'figures'].includes(w.type));
  setMeta('layout', layout); setMeta('homeCleanup', true);
}
// iPhone-Projekt: einmalig auf das Widget-Layout mit festen Grössen umstellen
if (!meta('iosLayout2', false)) { layout = DEFAULT_LAYOUT; setMeta('layout', layout); setMeta('iosLayout', true); setMeta('iosLayout2', true); } // mit kleinen Widgets für Tag, Bilanz, Analyse
// Tagesbilanz als Sankey einmalig auf dem Tag-Tab einfügen (vor dem Akku-Widget, sonst nach dem Tagesverlauf)
if (!meta('sankeyAdded', false)) {
  if (!layout.some((w) => w.type === 'sankey') && layout.length < 40) {
    const i = layout.findIndex((w) => w.type === 'battery' && !w.mtab), j = layout.findIndex((w) => w.type === 'day');
    const at = i >= 0 ? i : j >= 0 ? j + 1 : layout.length;
    layout = [...layout.slice(0, at), { type: 'sankey', size: 'l' }, ...layout.slice(at)];
    setMeta('layout', layout);
  }
  setMeta('sankeyAdded', true);
}
// Prototyp Polarkalender einmalig auf dem Tab Analyse einfügen (vor "Produktion nach Stunde")
if (!meta('polarAdded', false)) {
  if (!layout.some((w) => w.type === 'polar') && layout.length < 40) {
    const i = layout.findIndex((w) => w.type === 'heatmap' && !w.mtab);
    layout = i >= 0 ? [...layout.slice(0, i), { type: 'polar', size: 'l' }, ...layout.slice(i)] : [...layout, { type: 'polar', size: 'l' }];
    setMeta('layout', layout);
  }
  setMeta('polarAdded', true);
}
// Akku-Prognose in den Stapel auf Home (nach dem besten Zeitfenster), Typischer Tag auf Analyse vor dem Jahresvergleich
if (!meta('batEtaAdded', false)) {
  const st = layout.find((w) => w.type === 'stack');
  if (st) {
    const items = [...(st.opts?.items || ['window', 'tomorrow', 'month', 'solarNow'])].filter((t) => t !== 'batEta');
    items.splice(Math.min(1, items.length), 0, 'batEta');
    st.opts = { ...(st.opts || {}), items };
  }
  if (!layout.some((w) => w.type === 'typical') && layout.length < 40) {
    const i = layout.findIndex((w) => w.type === 'yearCompare' && !w.mtab);
    layout = i >= 0 ? [...layout.slice(0, i), { type: 'typical', size: 'l' }, ...layout.slice(i)] : [...layout, { type: 'typical', size: 'l' }];
  }
  setMeta('layout', layout); setMeta('batEtaAdded', true);
}
// Polarkalender an den Anfang von Analyse, die kleinen Widgets daneben (wie beim Sankey)
if (!meta('polarOrder', false)) {
  const pw = layout.find((w) => w.type === 'polar' && !w.mtab), first = layout.find((w) => w.type === 'invCompare' && !w.mtab);
  if (pw && first) { layout = layout.filter((w) => w !== pw); layout.splice(layout.indexOf(first), 0, pw); setMeta('layout', layout); }
  setMeta('polarOrder', true);
}
// Sankey direkt unter den Tagesverlauf, die kleinen Tag-Widgets daneben (füllt auf breiten Bildschirmen 3 + 3 Spalten)
if (!meta('sankeyOrder', false)) {
  const sk = layout.find((w) => w.type === 'sankey' && !w.mtab), day = layout.findIndex((w) => w.type === 'day');
  if (sk && day >= 0) {
    layout = layout.filter((w) => w !== sk); layout.splice(layout.findIndex((w) => w.type === 'day') + 1, 0, sk);
    const bi = layout.findIndex((w) => w.type === 'dayBattery' && !w.mtab), ri = layout.findIndex((w) => w.type === 'dayRatio' && !w.mtab);
    if (bi > ri && ri >= 0) { const [b] = layout.splice(bi, 1); layout.splice(ri, 0, b); }
    setMeta('layout', layout);
  }
  setMeta('sankeyOrder', true);
}
// Batterie-Widget einmalig unter dem Tagesverlauf einfügen, sobald eine Batterie erkannt wird
function withBattery(l) {
  if (l.some((w) => w.type === 'battery')) return l;
  const day = l.find((w) => w.type === 'day'), at = day ? (day.y ?? 9) + (day.h ?? 9) : 9, hgt = 9;
  return [...l.map((w) => (w.y != null && w.y >= at ? { ...w, y: w.y + hgt } : w)), { type: 'battery', x: 0, y: at, w: 12, h: hgt }];
}
function ensureBatteryWidget() {
  if (meta('batteryWidgetAdded', false)) return;
  layout = withBattery(layout); setMeta('layout', layout); setMeta('batteryWidgetAdded', true);
}
// Das Batterie-Widget war kurz entfernt (Akku im Tagesverlauf); wieder einfügen, wenn eine Batterie da ist
if (!meta('batteryBack', false)) {
  if (meta('batSeen', false)) { layout = withBattery(layout); setMeta('layout', layout); }
  setMeta('batteryBack', true);
}

// ---------- Zeit-Helfer (Anlagen-Zeitzone) ----------
const fmtDay = new Intl.DateTimeFormat('sv-SE', { timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHM = new Intl.DateTimeFormat('en-GB', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayKey = (ts) => fmtDay.format(ts);
const minuteOfDay = (ts) => { const [h, m] = fmtHM.format(ts).split(':').map(Number); return h * 60 + m; };
const solarlogDay = (s) => { const m = /^(\d{2})\.(\d{2})\.(\d{2})/.exec(s || ''); return m ? `20${m[3]}-${m[2]}-${m[1]}` : null; };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12
const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Zeitstempel für lokale Mitternacht eines Tages (DST-sicher genug für 5-Minuten-Buckets)
function dayStartTs(day) {
  let ts = Date.parse(day + 'T00:00:00Z') - 14 * 3600e3;
  while (dayKey(ts) !== day) ts += 15 * 60e3;
  return ts;
}

// ---------- Ertragsziele ----------
function kwpVal() { return live.kwp || meta('kwp', null); }
function monthTargetWh(y, m) {
  const kwp = kwpVal();
  if (!kwp) return null;
  return kwp * settings.specificTarget * (settings.monthDist[m - 1] / 100) * 1000;
}

// ---------- Erfassung ----------
let last = q.lastSample.get() || null;
if (last) { last.inv = last.inv ? JSON.parse(last.inv) : null; last.bat = last.soc != null ? { soc: last.soc, charge: Math.max(last.bat, 0), discharge: Math.max(-last.bat, 0) } : null; }
const live = { ts: null, pv: 0, cons: 0, inv: [], bat: null, solarlogTime: null, kwp: meta('kwp', null) };
let batSeen = meta('batSeen', false);
let invOffset = meta('invOffset', 0); // Position des ersten Wechselrichters in der Geräteliste (Key 782)
let lastOk = 0, lastError = null;
let periods = meta('periods', null);

function record(ts, pv, cons, inv, counters, bat) {
  const day = dayKey(ts);
  const row = q.day.get(day) || { day, yield_wh: 0, cons_wh: 0, self_wh: 0, peak_w: 0, inv: null, src: 'live', import_wh: 0, feed_wh: 0, chg_wh: 0, dis_wh: 0 };
  if (row.src === 'hist') Object.assign(row, { self_wh: 0, cons_wh: row.cons_wh ?? 0, src: 'live', import_wh: 0, feed_wh: 0, chg_wh: 0, dis_wh: 0 });
  // Tage aus älteren Versionen: Netzbilanz aus dem bisherigen Eigenverbrauch fortführen
  if (row.import_wh == null || row.feed_wh == null) {
    row.feed_wh = Math.max((row.yield_wh || 0) - (row.self_wh || 0), 0);
    row.import_wh = Math.max((row.cons_wh || 0) - (row.self_wh || 0), 0);
  }
  const invWh = row.inv ? JSON.parse(row.inv) : [];

  if (last && dayKey(last.ts) === day && ts > last.ts && ts - last.ts <= 10 * 60e3) {
    const h = (ts - last.ts) / 3.6e6;
    const pvAvg = (pv + last.pv) / 2, consAvg = (cons + last.cons) / 2;
    const chg = bat ? (bat.charge + (last.bat?.charge ?? bat.charge)) / 2 : 0;
    const dis = bat ? (bat.discharge + (last.bat?.discharge ?? bat.discharge)) / 2 : 0;
    // Energiebilanz: PV + Entladen + Bezug = Verbrauch + Laden + Einspeisung
    const grid = consAvg + chg - pvAvg - dis;
    row.self_wh = (row.self_wh || 0) + Math.min(pvAvg, consAvg) * h;
    row.import_wh += Math.max(grid, 0) * h;
    row.feed_wh += Math.max(-grid, 0) * h;
    row.chg_wh = (row.chg_wh || 0) + chg * h;
    row.dis_wh = (row.dis_wh || 0) + dis * h;
    if (!counters) { row.yield_wh += pvAvg * h; row.cons_wh += consAvg * h; }
    inv?.forEach((w, i) => { invWh[i] = (invWh[i] || 0) + ((w + (last.inv?.[i] ?? w)) / 2) * h; });
    q.addHour.run(day, Math.floor(minuteOfDay(ts) / 60), pvAvg * h, consAvg * h);
  }
  if (counters && counters.day === day) { row.yield_wh = counters.yieldWh; row.cons_wh = counters.consWh; }
  row.peak_w = Math.max(row.peak_w || 0, Math.round(pv));
  const hasBat = bat && (batSeen || CFG.demo);
  q.putDay.run(day, row.yield_wh, row.cons_wh, row.self_wh, row.peak_w, invWh.length ? JSON.stringify(invWh.map(Math.round)) : null, 'live',
    row.import_wh, row.feed_wh, hasBat ? row.chg_wh : null, hasBat ? row.dis_wh : null);
  q.insertSample.run(ts, Math.round(pv), Math.round(cons), inv ? JSON.stringify(inv.map(Math.round)) : null,
    hasBat ? Math.round(bat.soc) : null, hasBat ? Math.round(bat.charge - bat.discharge) : null);
  last = { ts, pv, cons, inv, bat };
}

// ---------- Solar-Log ----------
async function solarlogPost(body) {
  const res = await fetch(`${CFG.solarlog}/getjp`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Solar-Log antwortet mit HTTP ${res.status}`);
  return res.json();
}

async function pollReal() {
  const ts = Date.now();
  const j = await solarlogPost({ 801: { 170: null }, 782: null, 858: null });
  const d = j?.['801']?.['170'];
  if (!d) throw new Error('Solar-Log liefert keine Live-Daten (JSON-Schnittstelle aktiv?)');
  // Der Solar-Log erneuert seine Werte nur etwa alle 15 s; unveränderte Stände nicht nochmals speichern
  if (d[100] && d[100] === live.solarlogTime) return;
  const pv = Number(d[101]) || 0, cons = Number(d[110]) || 0;
  let inv = null;
  if (j['782'] && typeof j['782'] === 'object') {
    // 782 ist die ganze Geräteliste; Zähler oder Batterie können vor den Wechselrichtern stehen.
    // Die Wechselrichter sind die Positionen, deren Summe der Gesamtproduktion entspricht.
    const all = Object.keys(j['782']).sort((a, b) => a - b).map((k) => Number(j['782'][k]) || 0);
    const n = settings.inverterCount;
    if (pv > 200) {
      for (let off = 0; off + n <= all.length; off++) {
        const sum = all.slice(off, off + n).reduce((a, b) => a + b, 0);
        if (Math.abs(sum - pv) <= Math.max(50, pv * 0.05)) { if (off !== invOffset) { invOffset = off; setMeta('invOffset', off); } break; }
      }
    }
    inv = Array.from({ length: n }, (_, i) => all[invOffset + i] || 0);
  }
  // Batterie (Key 858): [?, Ladezustand %, Ladeleistung W, Entladeleistung W]
  let bat = null;
  const b = j['858'];
  if (Array.isArray(b) && b.length >= 4) {
    bat = { soc: Number(b[1]) || 0, charge: Number(b[2]) || 0, discharge: Number(b[3]) || 0 };
    if (!batSeen && (bat.soc > 0 || bat.charge > 0 || bat.discharge > 0)) { batSeen = true; setMeta('batSeen', true); ensureBatteryWidget(); }
  }
  record(ts, pv, cons, inv, { day: solarlogDay(d[100]), yieldWh: Number(d[105]), consWh: Number(d[111]) }, bat);

  // Vortag nachtragen, falls das Dashboard gestern nicht lief
  const yKey = addDays(dayKey(ts), -1);
  if (!q.day.get(yKey)) q.putDay.run(yKey, Number(d[106]), Number(d[112]), null, null, null, 'hist', null, null, null, null);

  live.kwp = Number(d[116]) / 1000 || live.kwp;
  periods = {
    month: { yieldWh: Number(d[107]), consWh: Number(d[113]) },
    year: { yieldWh: Number(d[108]), consWh: Number(d[114]) },
    total: { yieldWh: Number(d[109]), consWh: Number(d[115]) },
  };
  setMeta('periods', periods); setMeta('kwp', live.kwp);
  Object.assign(live, { ts, pv, cons, inv: inv || [], bat: bat && batSeen ? bat : null, solarlogTime: d[100] });
}

// Historische Daten aus dem Solar-Log übernehmen (best effort, je nach Firmware vorhanden)
function parseHistFile(text, varName) {
  const out = [];
  const re = new RegExp(`${varName}\\[\\w+\\+\\+\\]\\s*=\\s*"(\\d{2})\\.(\\d{2})\\.(\\d{2})\\|([^"]*)"`, 'g');
  for (const m of text.matchAll(re)) {
    const vals = m[4].split('|').map((seg) => Number(seg.split(';')[0]) || 0);
    out.push({ date: `20${m[3]}-${m[2]}-${m[1]}`, vals });
  }
  return out;
}
// Historie über die JSON-Schnittstelle (neuere Firmware ohne days_hist.js): Key 777 mit n liefert die Tageswerte
// des Monats, in dem "heute minus n Tage" liegt, pro Gerät. Den Verbrauchszähler erkennt man an den Jahreswerten:
// sein Wert in 854 (pro Gerät) entspricht dem Jahresverbrauch in 878.
const isoDay = (s) => `20${s.slice(6, 8)}-${s.slice(3, 5)}-${s.slice(0, 2)}`; // "01.10.26" -> "2026-10-01"
const daysBetween = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 864e5);
async function importHistoryJson() {
  const n = settings.inverterCount, today = dayKey(Date.now());
  let consIdx = meta('consIdx', null);
  if (consIdx == null) {
    const j = await solarlogPost({ 854: null, 878: null });
    const perDev = new Map((j['854'] || []).map(([d, vals]) => [d, vals]));
    for (const [d, , cons] of j['878'] || []) {
      const vals = perDev.get(d);
      const idx = vals?.findIndex((v, i) => (i < invOffset || i >= invOffset + n) && cons > 0 && Math.abs(v - cons) <= cons * 0.01);
      if (idx >= 0) { consIdx = idx; setMeta('consIdx', idx); break; }
    }
  }
  const full = !meta('histJsonDone', false); // beim ersten Mal alles, danach nur dieser und der letzte Monat
  let imported = 0, empty = 0;
  for (let i = 0; i <= (full ? 240 : 1) && empty < 3; i++) {
    let [y, m] = today.slice(0, 7).split('-').map(Number);
    m -= i; while (m < 1) { m += 12; y--; }
    const ym = `${y}-${String(m).padStart(2, '0')}`, back = Math.max(0, daysBetween(today, `${ym}-15`));
    const list = (await solarlogPost({ 777: { [back]: null } }))?.['777']?.[back];
    const rows = Array.isArray(list) ? list.filter((e) => isoDay(e[0]).startsWith(ym)) : [];
    if (!rows.length) { empty++; continue; }
    empty = 0;
    db.exec('BEGIN');
    for (const [d, vals] of rows) {
      const day = isoDay(d);
      if (day >= today || (q.day.get(day)?.src ?? 'hist') !== 'hist') continue; // eigene Messungen und Kurven haben Vorrang
      const inv = vals.slice(invOffset, invOffset + n).map((v) => Number(v) || 0);
      q.putDay.run(day, inv.reduce((a, b) => a + b, 0), consIdx != null ? Number(vals[consIdx]) || null : null, null, null, JSON.stringify(inv), 'hist', null, null, null, null);
      imported++;
    }
    db.exec('COMMIT');
    await new Promise((r) => setTimeout(r, 150)); // den Solar-Log nicht überfahren
  }
  if (full && imported) setMeta('histJsonDone', true);
  if (imported) console.log(`Historie: ${imported} Tage über die JSON-Schnittstelle übernommen${consIdx != null ? ' (mit Verbrauch)' : ''}`);
  return imported;
}

// 5-Minuten-Kurven aus dem Solar-Log (Key 776, n = Tage zurück). Daraus entstehen die Aufteilung wie bei den
// Live-Daten (Eigenverbrauch, Einspeisung, Netzbezug, Batterie), die Stundenwerte für die Heatmap und die Messpunkte
// für den Tagesverlauf. Pro Gerät: [W, Wh seit Mitternacht], die Batterie hat vier Werte, davon [2] = Laden und
// [3] = Entladen in W. Der Ladezustand fehlt in der Historie.
async function fetchCurve(day, today) {
  const back = daysBetween(today, day);
  const list = (await solarlogPost({ 776: { [back]: null } }))?.['776']?.[back];
  await new Promise((r) => setTimeout(r, 250)); // den Solar-Log nicht überfahren
  if (!Array.isArray(list) || !list.length) return null;
  const n = settings.inverterCount, consIdx = meta('consIdx', null), H = 5 / 60;
  const batIdx = list[0][1].findIndex((a) => Array.isArray(a) && a.length === 4);
  const out = { bat: batIdx >= 0, points: [], self: 0, imp: 0, feed: 0, chg: 0, dis: 0, peak: 0, invWh: new Array(n).fill(0), consWh: 0 };
  for (const [t, devs] of list) {
    const [hh, mm] = t.split(':').map(Number);
    const inv = devs.slice(invOffset, invOffset + n).map((a) => Number(a?.[0]) || 0);
    const pv = inv.reduce((a, b) => a + b, 0), cons = Number(devs[consIdx]?.[0]) || 0;
    const c = out.bat ? Number(devs[batIdx][2]) || 0 : 0, d = out.bat ? Number(devs[batIdx][3]) || 0 : 0;
    // Energiebilanz wie in record(): PV + Entladen + Bezug = Verbrauch + Laden + Einspeisung
    const grid = cons + c - pv - d;
    out.self += Math.min(pv, cons) * H; out.imp += Math.max(grid, 0) * H; out.feed += Math.max(-grid, 0) * H; out.chg += c * H; out.dis += d * H;
    out.peak = Math.max(out.peak, pv);
    // Tageszähler pro Gerät (Wh seit Mitternacht)
    devs.slice(invOffset, invOffset + n).forEach((a, i) => { out.invWh[i] = Math.max(out.invWh[i], Number(a?.[1]) || 0); });
    out.consWh = Math.max(out.consWh, Number(devs[consIdx]?.[1]) || 0);
    out.points.push({ m: hh * 60 + mm, pv, cons, inv, bat: c - d });
  }
  return out;
}

// Kurven für Tage ohne eigene Messung (src = 'hist'); Messpunkte nur für die letzten 400 Tage
let curvesRunning = false;
async function importCurves() {
  if (curvesRunning || meta('consIdx', null) == null) return;
  curvesRunning = true;
  const today = dayKey(Date.now()), H = 5 / 60;
  const todo = q.histDays.all().map((r) => r.day).filter((d) => d < today); // neueste zuerst
  let done = 0;
  try {
    for (const day of todo) {
      const c = await fetchCurve(day, today);
      if (!c) continue;
      const start = dayStartTs(day), keepSamples = day >= addDays(today, -400);
      db.exec('BEGIN');
      q.delHours.run(day);
      for (const p of c.points) {
        q.addHour.run(day, Math.floor(p.m / 60), p.pv * H, p.cons * H);
        if (keepSamples) q.insertSample.run(start + p.m * 60e3, Math.round(p.pv), Math.round(p.cons), JSON.stringify(p.inv), null, c.bat ? Math.round(p.bat) : null);
      }
      const r = q.day.get(day);
      q.putDay.run(day, r.yield_wh, r.cons_wh, c.self, Math.round(c.peak), r.inv, 'curve', c.imp, c.feed, c.bat ? c.chg : null, c.bat ? c.dis : null);
      db.exec('COMMIT');
      if (++done % 200 === 0) console.log(`Historie: ${done} von ${todo.length} Tageskurven übernommen`);
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* keine offene Transaktion */ }
    console.error('Historie (Kurven):', e.message);
  } finally { curvesRunning = false; }
  if (done) console.log(`Historie: ${done} Tageskurven übernommen (Aufteilung, Stundenwerte, Messpunkte)`);
}

// Live-Tage mit Lücken (Mac nicht im Heimnetz, Container aus) aus der Tageskurve vervollständigen: Aufteilung und
// Stundenwerte aus der Kurve neu rechnen, leere 5-Minuten-Slots mit Kurvenpunkten füllen. Eigene Messpunkte
// (mit Ladezustand) bleiben unverändert. Danach gilt der Tag als 'curve' und wird nicht erneut geprüft.
let gapsRunning = false;
async function fillGaps() {
  if (CFG.demo || gapsRunning || meta('consIdx', null) == null) return;
  gapsRunning = true;
  const today = dayKey(Date.now()), H = 5 / 60;
  let done = 0;
  try {
    for (const { day } of q.liveDays.all(addDays(today, -399), today)) {
      const start = dayStartTs(day), end = dayStartTs(addDays(day, 1)), slots = Math.round((end - start) / 300e3);
      const have = new Set(q.samplesBetween.all(start, end).map((s) => Math.floor((s.ts - start) / 300e3)));
      if (have.size >= slots * 0.9) continue;
      try {
        const c = await fetchCurve(day, today);
        if (!c) { console.log(`Lücken: keine Tageskurve für ${day}`); continue; }
        let added = 0;
        db.exec('BEGIN');
        q.delHours.run(day);
        for (const p of c.points) {
          q.addHour.run(day, Math.floor(p.m / 60), p.pv * H, p.cons * H);
          if (have.has(p.m / 5)) continue;
          q.insertSample.run(start + p.m * 60e3, Math.round(p.pv), Math.round(p.cons), JSON.stringify(p.inv.map(Math.round)), null, c.bat ? Math.round(p.bat) : null);
          added++;
        }
        const r = q.day.get(day), curveYield = c.invWh.reduce((a, b) => a + b, 0);
        q.putDay.run(day, Math.max(r.yield_wh || 0, curveYield), Math.max(r.cons_wh || 0, c.consWh), c.self, Math.max(r.peak_w || 0, Math.round(c.peak)),
          curveYield ? JSON.stringify(c.invWh.map(Math.round)) : r.inv, 'curve', c.imp, c.feed, c.bat ? c.chg : null, c.bat ? c.dis : null);
        db.exec('COMMIT');
        done++;
        console.log(`Lücken: ${day} aus der Tageskurve vervollständigt (${have.size} von ${slots} Slots gemessen, ${added} ergänzt)`);
        fillSocGaps(day);
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* keine offene Transaktion */ }
        console.error(`Lücken (${day}):`, e.message);
      }
    }
  } finally { gapsRunning = false; }
  return done;
}

// Lücken von heute (z. B. VPN auf dem Mac aktiv, Mac im Ruhezustand, Solar-Log kurz weg) gleich aus der Tageskurve
// füllen, nicht erst nach Mitternacht. Nur fehlende 5-Minuten-Slots bis vor 10 Minuten; die Tagessummen bleiben aus
// den Zählern, eigene Messpunkte (mit Ladezustand) unverändert. Die Kurve wird nur geholt, wenn wirklich etwas fehlt.
// Ladezustand in Lücken (Punkte aus der Tageskurve haben keinen) aus der Akku-Leistung rekonstruieren: Energie über die
// Lücke aufsummieren und so skalieren, dass der Verlauf genau an den gemessenen Wert davor und danach anschliesst.
// Passt die Leistung nicht zur Änderung (fehlt, oder falsches Vorzeichen), wird gerade verbunden. Höchstens 4 Stunden.
function fillSocGaps(day) {
  const rows = q.samplesBetween.all(dayStartTs(day), dayStartTs(addDays(day, 1)));
  let filled = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].soc != null || i === 0 || rows[i - 1].soc == null) continue;
    let j = i; while (j < rows.length && rows[j].soc == null) j++;
    if (j >= rows.length) break; // Lücke bis jetzt: kein Wert danach
    const a = rows[i - 1], b = rows[j], run = rows.slice(i, j);
    if (b.ts - a.ts > 4 * 3600e3) { i = j; continue; }
    const e = []; let acc = 0, prev = a;
    for (const r of run) { acc += ((prev.bat || 0) + (r.bat || 0)) / 2 * (r.ts - prev.ts); e.push(acc); prev = r; }
    const total = acc + ((prev.bat || 0) + (b.bat || 0)) / 2 * (b.ts - prev.ts), dS = b.soc - a.soc;
    const useEnergy = Math.abs(total) > 1e-9 && Math.sign(total) === Math.sign(dS) && dS !== 0;
    db.exec('BEGIN');
    run.forEach((r, k) => {
      const f = useEnergy ? e[k] / total : (r.ts - a.ts) / (b.ts - a.ts);
      q.setSoc.run(Math.round((a.soc + dS * f) * 10) / 10, r.ts); filled++;
    });
    db.exec('COMMIT');
    i = j;
  }
  if (filled) console.log(`Ladezustand ${day}: ${filled} Werte aus der Akku-Leistung ergänzt`);
  return filled;
}

let todayGapsRunning = false;
async function fillTodayGaps() {
  if (CFG.demo || todayGapsRunning || meta('consIdx', null) == null) return 0;
  const today = dayKey(Date.now()), start = dayStartTs(today), upto = Date.now() - 10 * 60e3;
  const have = new Set(q.samplesBetween.all(start, upto).map((r) => Math.floor((r.ts - start) / 300e3)));
  try { fillSocGaps(today); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } console.error('Ladezustand:', e.message); }
  if (have.size >= Math.floor((upto - start) / 300e3) - 1) return 0;
  todayGapsRunning = true;
  let added = 0;
  try {
    const c = await fetchCurve(today, today);
    if (!c) return 0;
    db.exec('BEGIN');
    for (const pt of c.points) {
      const ts = start + pt.m * 60e3;
      if (ts >= upto || have.has(pt.m / 5)) continue;
      q.insertSample.run(ts, Math.round(pt.pv), Math.round(pt.cons), JSON.stringify(pt.inv.map(Math.round)), null, c.bat ? Math.round(pt.bat) : null);
      added++;
    }
    db.exec('COMMIT');
    if (added) console.log(`Lücken heute: ${added} Fünf-Minuten-Werte aus der Tageskurve ergänzt`);
    if (added) fillSocGaps(today);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* keine offene Transaktion */ }
    console.error('Lücken heute:', e.message);
  } finally { todayGapsRunning = false; }
  return added;
}

async function importHistory() {
  if (await importHistoryJson().catch((e) => { console.error('Historie (JSON):', e.message); return 0; })) return;
  const n = settings.inverterCount;
  const get = async (f) => {
    try { const r = await fetch(`${CFG.solarlog}/${f}`, { signal: AbortSignal.timeout(15000) }); return r.ok ? await r.text() : ''; }
    catch { return ''; }
  };
  const today = dayKey(Date.now());
  const yesterday = addDays(today, -1);

  const daysTxt = await get('days_hist.js');
  const days = parseHistFile(daysTxt, 'da').map((e) => ({ ...e, inv: e.vals.slice(0, n), y: e.vals.slice(0, n).reduce((a, b) => a + b, 0) }));
  // Plausibilitätsprüfung gegen den Live-Wert "Ertrag gestern"
  const yRow = q.day.get(yesterday);
  const check = days.find((e) => e.date === yesterday);
  const plausible = check && yRow?.yield_wh ? Math.abs(check.y - yRow.yield_wh) <= Math.max(500, yRow.yield_wh * 0.1) : !!check;
  if (days.length && plausible) {
    db.exec('BEGIN');
    for (const e of days) {
      if (e.date >= today) continue;
      const ex = q.day.get(e.date);
      if (ex && ex.src === 'live') continue;
      q.putDay.run(e.date, e.y, ex?.cons_wh ?? null, null, null, JSON.stringify(e.inv), 'hist', null, null, null, null);
    }
    db.exec('COMMIT');
    console.log(`Historie: ${days.length} Tage aus days_hist.js übernommen`);
  } else if (days.length) {
    console.log('Historie: days_hist.js gefunden, Werte passen aber nicht zum Live-Ertrag; übersprungen');
  }

  const monTxt = await get('months.js');
  const months = parseHistFile(monTxt, 'mo');
  if (months.length) {
    const cur = months.find((e) => e.date.slice(0, 7) === today.slice(0, 7));
    const sumOf = (e) => e.vals.slice(0, Math.max(1, Math.min(n, e.vals.length))).reduce((a, b) => a + b, 0);
    const ok = !periods?.month?.yieldWh || !cur || Math.abs(sumOf(cur) - periods.month.yieldWh) <= Math.max(2000, periods.month.yieldWh * 0.1);
    if (ok) {
      db.exec('BEGIN');
      for (const e of months) q.putMonthHist.run(e.date.slice(0, 7), sumOf(e));
      db.exec('COMMIT');
      console.log(`Historie: ${months.length} Monate aus months.js übernommen`);
    } else console.log('Historie: months.js passt nicht zum Live-Monatsertrag; übersprungen');
  }
}

// ---------- Demo-Modus ----------
function hash(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return ((h >>> 0) % 1000) / 1000; }
function demoPower(ts) {
  const day = dayKey(ts);
  const mo = Number(day.slice(5, 7));
  const m = minuteOfDay(ts) / 60;
  const season = Math.cos(((mo - 6.5) / 12) * 2 * Math.PI); // 1 im Sommer, -1 im Winter
  const rise = 7.3 - 1.9 * season, set = 17.6 + 3.3 * season;
  const peak = 11000 + 4500 * season;
  const clear = 0.35 + 0.65 * hash(day);
  const flicker = 0.85 + 0.15 * Math.sin(ts / 4.1e5) * Math.sin(ts / 1.7e6 + clear * 9);
  const pv = m > rise && m < set ? peak * Math.pow(Math.sin(Math.PI * (m - rise) / (set - rise)), 1.5) * clear * flicker : 0;
  const bump = (c, w, p) => p * Math.exp(-((m - c) ** 2) / (2 * w * w));
  const heat = (ts / 6e4) % 180 < 40 ? 1200 + 900 * Math.max(0, -season) : 0;
  const cons = 300 + bump(7.2, 0.5, 1100) + bump(12.1, 0.6, 1800) + bump(19, 1.1, 1400) + heat + 100 * Math.sin(ts / 9e4);
  const split = 0.58 + 0.05 * Math.sin(m);
  return { pv: Math.max(0, pv), cons: Math.max(150, cons), inv: [pv * split, pv * (1 - split)] };
}
let demoSoc = 40, demoLastTs = null;
function demoBattery(ts, pv, cons) {
  const cap = 10000, maxP = 5000;
  const h = demoLastTs ? Math.min((ts - demoLastTs) / 3.6e6, 0.2) : 0;
  demoLastTs = ts;
  const surplus = pv - cons;
  let charge = 0, discharge = 0;
  if (surplus > 50 && demoSoc < 100) charge = Math.min(surplus, maxP, ((100 - demoSoc) / 100) * cap / Math.max(h, 1e-6));
  else if (surplus < -50 && demoSoc > 8) discharge = Math.min(-surplus, maxP, ((demoSoc - 8) / 100) * cap / Math.max(h, 1e-6));
  demoSoc = Math.min(100, Math.max(0, demoSoc + ((charge * 0.95 - discharge) * h / cap) * 100));
  return { soc: demoSoc, charge, discharge };
}
function seedDemo() {
  if (q.anyDay.get()) return;
  const now = Date.now();
  console.log('Demo: erzeuge Beispieldaten…');
  db.exec('BEGIN');
  for (let ts = now - 120 * 864e5; ts <= now; ts += 5 * 60e3) { const p = demoPower(ts); record(ts, p.pv, p.cons, p.inv, null, demoBattery(ts, p.pv, p.cons)); }
  // ältere Monate als Monats-Historie
  const [cy, cm] = dayKey(now).split('-').map(Number);
  for (let y = cy - 2; y <= cy; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === cy && m >= cm) break;
      const f = 0.85 + 0.25 * hash(`${y}-${m}`);
      q.putMonthHist.run(`${y}-${String(m).padStart(2, '0')}`, 19.2 * 1000 * DEFAULT_SETTINGS.monthDist[m - 1] / 100 * 1000 * f);
    }
  }
  db.exec('COMMIT');
  live.kwp = 19.2; setMeta('kwp', 19.2);
}
function pollDemo() {
  const ts = Date.now();
  const p = demoPower(ts);
  const bat = demoBattery(ts, p.pv, p.cons);
  record(ts, p.pv, p.cons, p.inv, null, bat);
  const months = monthsAll();
  const cur = dayKey(ts);
  const sum = (filter) => months.filter(filter).reduce((a, r) => ({ y: a.y + (r.yieldWh || 0), c: a.c + (r.consWh || 0) }), { y: 0, c: 0 });
  const mo = sum((r) => r.month === cur.slice(0, 7)), yr = sum((r) => r.month.startsWith(cur.slice(0, 4))), tot = sum(() => true);
  periods = {
    month: { yieldWh: mo.y, consWh: mo.c },
    year: { yieldWh: yr.y, consWh: yr.c + 5_200_000 },
    total: { yieldWh: tot.y + 61_000_000, consWh: tot.c + 52_000_000 },
  };
  Object.assign(live, { ts, pv: p.pv, cons: p.cons, inv: p.inv, bat, kwp: 19.2 });
}

// Antwortet der Solar-Log nicht, wird die Pause nach jedem Fehler doppelt so lang (bis 2 Minuten), damit er sich
// erholen kann statt alle paar Sekunden neue Anfragen zu bekommen. Nach der ersten Antwort wieder im normalen Takt.
let failStreak = 0;
async function poll() {
  try {
    CFG.demo ? pollDemo() : await pollReal();
    if (failStreak) {
      console.log(new Date().toISOString(), `Solar-Log antwortet wieder (nach ${failStreak} Fehlversuchen)`);
      setTimeout(() => fillTodayGaps().catch(() => {}), 60e3); // die Lücke gleich aus der Tageskurve füllen
    }
    lastOk = Date.now(); lastError = null; failStreak = 0;
  } catch (err) {
    lastError = err.name === 'TimeoutError' ? 'Solar-Log antwortet nicht (Zeitüberschreitung)' : String(err.message || err);
    failStreak++;
    if (failStreak <= 3 || failStreak % 10 === 0) console.error(new Date().toISOString(), lastError, failStreak > 1 ? `(${failStreak}. Mal in Folge)` : '');
  } finally { setTimeout(poll, failStreak ? Math.min(120e3, CFG.pollMs * 2 ** Math.min(failStreak, 6)) : CFG.pollMs); }
}

// ---------- Auswertungen ----------
function enrichDay(r) {
  if (!r) return null;
  const liveRow = r.src !== 'hist';
  let feed = null, imp = null;
  if (liveRow && r.feed_wh != null && r.import_wh != null) {
    feed = Math.min(Math.max(r.feed_wh, 0), r.yield_wh ?? Infinity);
    imp = r.cons_wh != null ? Math.min(Math.max(r.import_wh, 0), r.cons_wh) : null;
  } else if (liveRow && r.self_wh != null) {
    const self = Math.min(r.self_wh, r.yield_wh ?? Infinity, r.cons_wh ?? Infinity);
    feed = Math.max(r.yield_wh - self, 0);
    imp = r.cons_wh != null ? Math.max(r.cons_wh - self, 0) : null;
  }
  return {
    day: r.day, yieldWh: r.yield_wh, consWh: r.cons_wh, peakW: r.peak_w,
    selfWh: feed != null ? r.yield_wh - feed : null,       // selbst genutzte Produktion (inkl. Batterieladung)
    coveredWh: imp != null ? r.cons_wh - imp : null,        // Verbrauch aus eigener Erzeugung (inkl. Batterie)
    feedWh: feed, importWh: imp,
    chgWh: r.chg_wh ?? null, disWh: r.dis_wh ?? null,
    inv: r.inv ? JSON.parse(r.inv) : null,
  };
}

// Summen über mehrere Tage; Werte nur, wenn alle Tage sie haben
function aggregate(list) {
  const out = { yieldWh: 0, consWh: 0, selfWh: 0, feedWh: 0, coveredWh: 0, importWh: 0, chgWh: 0, disWh: 0 };
  const ok = { consWh: true, selfWh: true, feedWh: true, coveredWh: true, importWh: true, chgWh: true, disWh: true };
  let anyBat = false;
  for (const d of list) {
    out.yieldWh += d.yieldWh || 0;
    for (const k of Object.keys(ok)) { if (d[k] == null) ok[k] = false; else out[k] += d[k]; }
    if (d.chgWh != null) anyBat = true;
  }
  for (const k of Object.keys(ok)) if (!ok[k] && !(anyBat && (k === 'chgWh' || k === 'disWh'))) out[k] = null;
  if (!anyBat) { out.chgWh = null; out.disWh = null; }
  return out;
}

// Monatswerte: Tageswerte + Monats-Historie aus dem Solar-Log
function monthsAll() {
  const byMonth = new Map();
  for (const r of q.allDays.all()) { const k = r.day.slice(0, 7); (byMonth.get(k) || byMonth.set(k, []).get(k)).push(enrichDay(r)); }
  const map = new Map();
  for (const r of q.monthsHist.all()) map.set(r.month, { month: r.month, yieldWh: r.yield_wh, consWh: null, selfWh: null, feedWh: null, coveredWh: null, importWh: null, chgWh: null, disWh: null });
  for (const [k, list] of byMonth) {
    const a = aggregate(list);
    const e = map.get(k);
    if (e && e.yieldWh > a.yieldWh * 1.03 + 1000) {
      // Monats-Historie ist vollständiger als die aufgezeichneten Tage: nur Ertrag übernehmen
      map.set(k, { ...e, consWh: null });
    } else map.set(k, { month: k, ...a });
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function invSum(rows) {
  let out = null;
  for (const r of rows) if (r.inv) { out ??= []; r.inv.forEach((v, i) => { out[i] = (out[i] || 0) + v; }); }
  return out;
}

function apiSeries(period, ref) {
  const now = dayKey(Date.now());
  if (period === 'month') {
    const [y, m] = (ref || now.slice(0, 7)).split('-').map(Number);
    const n = daysInMonth(y, m);
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const rows = new Map(q.daysRange.all(`${key}-01`, `${key}-31`).map((r) => [r.day, enrichDay(r)]));
    const tgt = monthTargetWh(y, m);
    return {
      period, ref: key,
      buckets: Array.from({ length: n }, (_, i) => {
        const day = `${key}-${String(i + 1).padStart(2, '0')}`;
        return { key: day, label: String(i + 1), ...(rows.get(day) || {}), targetWh: tgt != null ? tgt / n : null };
      }),
    };
  }
  if (period === 'year') {
    const y = Number(ref || now.slice(0, 4));
    const all = new Map(monthsAll().map((r) => [r.month, r]));
    const invByMonth = new Map();
    for (const r of q.daysRange.all(`${y}-01-01`, `${y}-12-31`)) {
      const k = r.day.slice(0, 7); const arr = invByMonth.get(k) || []; arr.push({ inv: r.inv ? JSON.parse(r.inv) : null }); invByMonth.set(k, arr);
    }
    return {
      period, ref: String(y),
      buckets: Array.from({ length: 12 }, (_, i) => {
        const k = `${y}-${String(i + 1).padStart(2, '0')}`;
        return { key: k, label: String(i + 1), ...(all.get(k) || {}), inv: invSum(invByMonth.get(k) || []), targetWh: monthTargetWh(y, i + 1) };
      }),
    };
  }
  // Gesamt: pro Jahr
  const years = new Map();
  for (const r of monthsAll()) { const y = r.month.slice(0, 4); (years.get(y) || years.set(y, []).get(y)).push(r); }
  const kwp = kwpVal();
  return {
    period: 'total', ref: null,
    buckets: [...years].map(([y, list]) => ({ key: y, label: y, ...aggregate(list), targetWh: kwp ? kwp * settings.specificTarget * 1000 : null })),
  };
}

function apiDay(day) {
  day = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : dayKey(Date.now());
  const start = dayStartTs(day), end = dayStartTs(addDays(day, 1));
  const buckets = new Map();
  for (const s of q.samplesBetween.all(start, end)) {
    const b = Math.floor(minuteOfDay(s.ts) / 5) * 5;
    const e = buckets.get(b) || { m: b, pv: 0, cons: 0, inv: null, n: 0, soc: 0, ns: 0, bat: 0, nb: 0 };
    e.pv += s.pv; e.cons += s.cons; e.n++;
    if (s.soc != null) { e.soc += s.soc; e.ns++; }
    if (s.bat != null) { e.bat += s.bat; e.nb++; } // Historie aus dem Solar-Log hat Laden/Entladen, aber keinen Ladezustand
    if (s.inv) { const a = JSON.parse(s.inv); e.inv ??= []; a.forEach((v, i) => { e.inv[i] = (e.inv[i] || 0) + v; }); }
    buckets.set(b, e);
  }
  const today = dayKey(Date.now());
  return {
    day, isToday: day === today, nowMinute: day === today ? minuteOfDay(Date.now()) : null,
    summary: enrichDay(q.day.get(day)), targetWh: (() => { const [y, m] = day.split('-').map(Number); const t = monthTargetWh(y, m); return t != null ? t / daysInMonth(y, m) : null; })(),
    points: [...buckets.values()].sort((a, b) => a.m - b.m).map((e) => ({
      m: e.m, pv: Math.round(e.pv / e.n), cons: Math.round(e.cons / e.n), inv: e.inv ? e.inv.map((v) => Math.round(v / e.n)) : null,
      soc: e.ns ? Math.round(e.soc / e.ns) : null, bat: e.nb ? Math.round(e.bat / e.nb) : null,
    })),
  };
}

function apiHeatmap(nDays) {
  const n = Math.min(Math.max(nDays || 90, 7), 366);
  const from = addDays(dayKey(Date.now()), -(n - 1));
  const map = new Map();
  for (const r of q.hoursRange.all(from)) { (map.get(r.day) || map.set(r.day, new Array(24).fill(null)).get(r.day))[r.hour] = Math.round(r.pv_wh); }
  const days = Array.from({ length: n }, (_, i) => addDays(from, i));
  return { days, values: days.map((d) => map.get(d) || new Array(24).fill(null)) };
}

function apiYearsMonths() {
  const out = {};
  for (const r of monthsAll()) { const y = r.month.slice(0, 4); (out[y] ||= new Array(12).fill(null))[Number(r.month.slice(5, 7)) - 1] = r.yieldWh; }
  return out;
}

function apiState() {
  const now = Date.now();
  return {
    settings, kwp: kwpVal(), demo: CFG.demo, source: CFG.solarlog, pollSeconds: CFG.pollMs / 1000, now: Date.now(), firstDay: q.firstDay.get()?.day ?? null,
    live, lastOk, error: lastError,
    today: enrichDay(q.day.get(dayKey(now))),
    yesterday: enrichDay(q.day.get(addDays(dayKey(now), -1))),
    periods,
    yearTarget: (() => {
      const [y, m, d] = dayKey(now).split('-').map(Number);
      const full = kwpVal() ? kwpVal() * settings.specificTarget * 1000 : null;
      if (full == null) return null;
      let soFar = 0;
      for (let i = 1; i < m; i++) soFar += monthTargetWh(y, i);
      soFar += monthTargetWh(y, m) * (d / daysInMonth(y, m));
      return { fullWh: full, toDateWh: soFar, monthWh: monthTargetWh(y, m), monthToDateWh: monthTargetWh(y, m) * (d / daysInMonth(y, m)) };
    })(),
  };
}

// ---------- Einstellungen ----------
function cleanSettings(s) {
  const n = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const out = { ...settings };
  if (typeof s.plantName === 'string') out.plantName = s.plantName.slice(0, 60) || DEFAULT_SETTINGS.plantName;
  out.tariffImport = n(s.tariffImport, 0, 5, settings.tariffImport);
  out.tariffFeed = n(s.tariffFeed, 0, 5, settings.tariffFeed);
  if (typeof s.tariffAuto === 'boolean') out.tariffAuto = s.tariffAuto;
  if (TARIFF_CATS.includes(s.tariffCategory)) out.tariffCategory = s.tariffCategory;
  for (const k of ['pushOutage', 'pushFull', 'pushEvening']) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (/^\d{2}:\d{2}$/.test(s.pushEveningTime || '')) out.pushEveningTime = s.pushEveningTime;
  out.specificTarget = n(s.specificTarget, 100, 3000, settings.specificTarget);
  out.inverterCount = Math.round(n(s.inverterCount, 1, 10, settings.inverterCount));
  out.batteryCapacity = n(s.batteryCapacity, 0, 500, settings.batteryCapacity || 0);
  if (Array.isArray(s.monthDist) && s.monthDist.length === 12) {
    const arr = s.monthDist.map((v) => n(v, 0, 100, 0)); const sum = arr.reduce((a, b) => a + b, 0);
    if (sum > 0) out.monthDist = arr.map((v) => Math.round((v / sum) * 1000) / 10);
  }
  if (Array.isArray(s.inverterNames)) out.inverterNames = s.inverterNames.slice(0, 10).map((x) => String(x).slice(0, 40));
  out.pvTilt = Math.round(n(s.pvTilt, 0, 90, settings.pvTilt ?? 30));
  const az = parseAzimuths(s.pvOrientation);
  if (az) out.pvOrientation = az.join(', ');
  return out;
}
const WIDGETS = new Set(['battery', 'forecast', 'flow', 'status', 'day', 'figures', 'balance', 'target', 'inverters', 'heatmap', 'ratios', 'yearCompare', 'totals',
  'mode', 'soc', 'solarNow', 'today', 'tomorrow', 'month', 'gridNow', 'window', 'stack',
  'sankey', 'polar', 'batEta', 'typical', 'dayYield', 'dayRatio', 'daySun', 'dayBattery', 'dayGrid', 'yearSoll', 'total', 'money', 'ratioYear', 'invCompare', 'record', 'yoy', 'avg30']);
const SIZES = new Set(['s', 'm', 'l', 'xl']);
const MOBILE_TABS = new Set(['now', 'day', 'bal', 'ana', 'hide']);
function cleanLayout(l) {
  if (!Array.isArray(l)) return layout;
  const int = (v, lo, hi) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined; };
  return l.filter((w) => w && WIDGETS.has(w.type)).slice(0, 40).map((w) => {
    let opts;
    try { opts = w.opts && typeof w.opts === 'object' && JSON.stringify(w.opts).length < 2000 ? w.opts : undefined; } catch { opts = undefined; }
    const mtab = MOBILE_TABS.has(w.mtab) ? w.mtab : undefined;
    return { type: w.type, size: SIZES.has(w.size) ? w.size : undefined, opts, mtab };
  });
}

// ---------- Ertragsprognose (Open-Meteo) ----------
// Einstrahlung auf die Modulebene × kWp ergibt den Modellertrag. Ein Faktor aus den letzten 14 Tagen
// (gemessen / Modell) gleicht Verschattung, Verluste und eine ungenaue Ausrichtung aus.
// Nach aussen gehen nur Standort, Neigung und Ausrichtung.
// Ausrichtung als Kompassgrad wie im Solar-Log-Portal (180 = Süd), mehrere Dachflächen mit Komma: "169, 259"
const LEGACY_ORIENTATION = { S: '180', SE: '135', SW: '225', E: '90', W: '270', EW: '90, 270', SW2: '180, 270', SE2: '90, 180' };
function parseAzimuths(v) {
  const list = String(LEGACY_ORIENTATION[v] ?? v ?? '').split(/[\s,;]+/).filter(Boolean).map(Number);
  return list.length && list.length <= 4 && list.every((x) => Number.isFinite(x) && x >= 0 && x <= 360) ? list.map((x) => Math.round(x)) : null;
}
const WEATHER = [[0, 'Klar'], [1, 'Überwiegend sonnig'], [2, 'Teils bewölkt'], [3, 'Bedeckt'], [45, 'Nebel'], [51, 'Nieselregen'],
  [61, 'Regen'], [66, 'Gefrierender Regen'], [71, 'Schnee'], [80, 'Regenschauer'], [85, 'Schneeschauer'], [95, 'Gewitter']];
const weatherText = (c) => c == null ? null : [...WEATHER].reverse().find(([k]) => c >= k)?.[1] ?? null;
// MeteoSwiss ICON-CH2 (2 km) trifft Schauerlagen in der Schweiz deutlich besser als das Standardmodell (ICON-D2);
// fehlt dort ein Wert, springt das Standardmodell ein
const MODELS = ['meteoswiss_icon_ch2', 'best_match'];
const fcKey = (s = settings) => s.lat == null ? null : [s.lat, s.lon, s.pvTilt, s.pvOrientation].join('|');
let fc = meta('forecast', null), fcError = null;

async function refreshForecast() {
  const key = fcKey();
  if (!key) { fc = null; fcError = null; return; }
  try {
    // Open-Meteo zählt den Azimut ab Süden: 0 = Süd, −90 = Ost, 90 = West
    const res = await Promise.all((parseAzimuths(settings.pvOrientation) || [180]).map((deg) => deg - 180).map(async (azimuth) => {
      const u = new URL('https://api.open-meteo.com/v1/forecast');
      const params = { latitude: settings.lat, longitude: settings.lon, tilt: settings.pvTilt, azimuth, hourly: 'global_tilted_irradiance,sunshine_duration', daily: 'weather_code,sunrise,sunset', current: 'temperature_2m,weather_code,is_day,cloud_cover,precipitation,snow_depth', past_days: 14, forecast_days: 2, timezone: CFG.tz, models: MODELS.join(',') };
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`Open-Meteo antwortet mit HTTP ${r.status}`);
      return r.json();
    }));
    // Wert des ersten Modells, das einen hat (MeteoSwiss vor dem Standardmodell)
    const pick = (obj, v, i) => MODELS.map((m) => obj[`${v}_${m}`]?.[i]).find((x) => x != null) ?? null;
    const h = res[0].hourly;
    // mehrere Dachflächen: Mittel (gleich gross angenommen)
    const gti = h.time.map((_, i) => res.reduce((a, j) => a + (pick(j.hourly, 'global_tilted_irradiance', i) || 0), 0) / res.length);
    fc = { key, fetched: Date.now(), time: h.time, gti, sun: h.time.map((_, i) => pick(h, 'sunshine_duration', i)),
      dailyTime: res[0].daily.time, codes: res[0].daily.time.map((_, i) => pick(res[0].daily, 'weather_code', i)),
      sunrise: res[0].daily.time.map((_, i) => pick(res[0].daily, 'sunrise', i)), sunset: res[0].daily.time.map((_, i) => pick(res[0].daily, 'sunset', i)),
      cur: res[0].current || null }; // aktuelles Wetter für die Szene hinter dem Haus
    setMeta('forecast', fc); fcError = null;
  } catch (e) {
    fcError = e.name === 'TimeoutError' ? 'Open-Meteo antwortet nicht' : String(e.message || e);
    console.error(new Date().toISOString(), 'Prognose:', fcError);
  }
}

async function geocode(text) {
  if (!text) return { location: '', lat: null, lon: null, placeLabel: '' };
  const m = text.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (m) return { location: text, lat: Number(m[1]), lon: Number(m[2]), placeLabel: `${m[1]}, ${m[2]}` };
  for (const cc of ['CH', null]) { // zuerst in der Schweiz suchen
    const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
    u.searchParams.set('name', text); u.searchParams.set('count', '1'); u.searchParams.set('language', 'de');
    if (cc) u.searchParams.set('countryCode', cc);
    const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
    const g = r.ok ? (await r.json())?.results?.[0] : null;
    if (g) return { location: text, lat: g.latitude, lon: g.longitude, placeLabel: [g.name, g.admin1, g.country_code !== 'CH' ? g.country : null].filter(Boolean).join(', ') };
  }
  throw new Error(`Ort „${text}“ nicht gefunden. Versuche es mit einem anderen Ortsnamen oder mit Koordinaten wie 47.39, 8.05.`);
}

function apiForecast() {
  if (!fcKey()) return { enabled: false };
  const kwp = kwpVal();
  if (!fc || fc.key !== fcKey() || !kwp) return { enabled: true, error: fcError || (kwp ? 'Die Prognose wird geladen.' : 'Die Anlagenleistung ist noch unbekannt.') };
  const today = dayKey(Date.now());
  // Open-Meteo-Stundenwerte sind Mittel der vorangehenden Stunde: "10:00" gilt für 9–10 Uhr
  const days = {};
  fc.time.forEach((t, i) => {
    let day = t.slice(0, 10), hh = Number(t.slice(11, 13)) - 1;
    if (hh < 0) { day = addDays(day, -1); hh = 23; }
    const d = (days[day] ??= { modelWh: 0, hours: new Array(24).fill(0), sun: new Array(24).fill(0) });
    d.hours[hh] = kwp * fc.gti[i]; d.modelWh += kwp * fc.gti[i]; d.sun[hh] = (fc.sun?.[i] || 0) / 3600; // Anteil Sonnenschein der Stunde
  });
  delete days[addDays(fc.time[0].slice(0, 10), -1)]; // angeschnittener Vortag
  // Abgleich mit dem gemessenen Ertrag; sehr trübe Tage und Ausreisser (z. B. Schnee auf den Modulen) zählen nicht
  let sumA = 0, sumM = 0, calDays = 0;
  for (const [day, d] of Object.entries(days)) {
    const y = day < today ? q.day.get(day)?.yield_wh : null;
    if (!y || d.modelWh < kwp * 300 || y / d.modelWh < 0.2 || y / d.modelWh > 1.5) continue;
    sumA += y; sumM += d.modelWh; calDays++;
  }
  const factor = calDays >= 3 ? Math.min(1.2, Math.max(0.3, sumA / sumM)) : 0.85;
  const out = {};
  for (const [day, d] of Object.entries(days)) {
    // Sonnenscheindauer statt Bewölkungsgrad: dünne Schleierwolken zählen als "bedeckt", lassen aber viel Sonne durch
    const sunny = d.sun.map((x, h) => x >= 0.5 && d.hours[h] > kwp * 100); // und nennenswerte Einstrahlung (nicht nur Sonnenaufgang)
    const sunH = d.sun.reduce((a, x) => a + x, 0);
    const ci = fc.dailyTime.indexOf(day), code = fc.codes[ci];
    const weather = code >= 45 ? weatherText(code)
      : sunH >= 6 ? 'Sonnig' : sunH >= 3 ? 'Teils sonnig' : sunH >= 1 ? 'Meist bewölkt' : 'Bedeckt';
    out[day] = {
      wh: Math.round(d.modelWh * factor), hours: d.hours.map((w) => Math.round(w * factor)),
      sunnyFrom: sunny.filter(Boolean).length >= 2 ? sunny.indexOf(true) : null,
      sunHours: Math.round(sunH * 10) / 10, weather,
      sunrise: fc.sunrise?.[ci]?.slice(11, 16) ?? null, sunset: fc.sunset?.[ci]?.slice(11, 16) ?? null,
    };
  }
  const c = fc.cur;
  const current = c ? { temp: c.temperature_2m, code: c.weather_code, isDay: !!c.is_day, cloud: c.cloud_cover, precip: c.precipitation, snow: c.snow_depth ?? null, text: weatherText(c.weather_code) } : null;
  return { enabled: true, place: settings.placeLabel, updated: fc.fetched, factor: Math.round(factor * 100) / 100, calDays, today, tomorrow: addDays(today, 1), days: out, current, error: fcError };
}

// ---------- Push-Mitteilungen (Web Push, ohne fremde Dienste) ----------
// Die App auf dem Homescreen meldet ein Abo an: eine Adresse beim Push-Dienst des Geräts (Apple, Google, Mozilla) und
// zwei Schlüssel. Der Server verschlüsselt jede Nachricht nur für dieses Gerät (RFC 8291, aes128gcm) und weist sich mit
// einem eigenen Schlüsselpaar aus (VAPID, RFC 8292). Der Push-Dienst sieht nur verschlüsselte Daten.
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
function vapidKeys() {
  let v = meta('vapid', null);
  if (!v) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    v = { jwk, pub: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])) }; // unkomprimierter Punkt, 65 Bytes
    setMeta('vapid', v);
  }
  return v;
}
function vapidAuth(endpoint) {
  const v = vapidKeys();
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CFG.pushContact }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: crypto.createPrivateKey({ key: v.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`;
}
// Inhalt für ein Gerät verschlüsseln (RFC 8291). test: feste Schlüssel und Salz fürs Prüfen gegen das Beispiel im Standard
function encryptPush(keys, payload, test = {}) {
  const uaPub = fromB64u(keys.p256dh), authSecret = fromB64u(keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (test.priv) ecdh.setPrivateKey(fromB64u(test.priv)); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), secret = ecdh.computeSecret(uaPub);
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const ikm = hmac(hmac(authSecret, secret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const salt = test.salt ? fromB64u(test.salt) : crypto.randomBytes(16), prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
async function pushTo(sub, msg) {
  const r = await fetch(sub.endpoint, {
    method: 'POST', body: encryptPush(sub.keys, JSON.stringify(msg)), signal: AbortSignal.timeout(15000),
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: msg.urgent ? 'high' : 'normal', Authorization: vapidAuth(sub.endpoint) },
  });
  return { status: r.status, text: r.ok ? '' : (await r.text().catch(() => '')).slice(0, 200) };
}
// an alle angemeldeten Geräte; abgelaufene Abos (404/410) fallen weg
async function pushAll(msg) {
  const subs = meta('pushSubs', []), keep = [];
  let sent = 0, error = null;
  for (const s of subs) {
    try {
      const r = await pushTo(s, msg);
      if (r.status === 404 || r.status === 410) continue;
      keep.push(s);
      if (r.status >= 200 && r.status < 300) sent++;
      else { error = `${new URL(s.endpoint).host}: HTTP ${r.status} ${r.text}`; console.error(new Date().toISOString(), 'Push:', error); }
    } catch (e) { keep.push(s); error = e.message; console.error(new Date().toISOString(), 'Push:', e.message); }
  }
  if (keep.length !== subs.length) setMeta('pushSubs', keep);
  return { sent, total: subs.length, error };
}
const notifyState = meta('notifyState', {});
const markSent = (k, v) => { notifyState[k] = v; setMeta('notifyState', notifyState); };
const clockOf = (ts) => new Intl.DateTimeFormat('de-CH', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit' }).format(ts);
const kwh1 = (wh) => (wh / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
// bestes Zeitfenster für ein Gerät mit 2 kW bei 0.45 kW Grundlast (wie im Widget "Bestes Zeitfenster")
function windowText(d) {
  let best = null, cur = -1;
  d.hours.forEach((w, h) => { if (w / 1000 - 0.45 >= 2) { if (cur < 0) cur = h; if (!best || h - cur > best[1] - best[0]) best = [cur, h]; } else cur = -1; });
  return best ? `${best[0]}–${best[1] + 1} Uhr` : null;
}
let belowDay = null; // Tag, an dem der Akku unter 95 % war (erst danach zählt "voll")
// Eine Mitteilung gilt erst als erledigt, wenn sie mindestens ein Gerät erreicht hat. Sonst nächste Minute nochmals,
// nach 5 Fehlversuchen wird aufgegeben (bis zum nächsten Anlass), damit nichts endlos versucht wird.
const tries = {};
async function sendOnce(key, value, msg) {
  const r = await pushAll(msg);
  if (r.sent || (tries[key] = (tries[key] || 0) + 1) >= 5) {
    markSent(key, value); delete tries[key];
    if (!r.sent) console.error(new Date().toISOString(), `Mitteilung "${msg.title}" aufgegeben: ${r.error || 'kein Gerät erreicht'}`);
  }
}
async function notifyTick() {
  const s = settings;
  if (CFG.demo || !meta('pushSubs', []).length) return;
  const now = Date.now(), day = dayKey(now), hm = clockOf(now);
  try {
    if (s.pushOutage && lastOk) {
      const down = now - lastOk > 15 * 60e3;
      if (down && !notifyState.outage) {
        await sendOnce('outage', now, { title: 'Solar-Log antwortet nicht', body: `Seit ${clockOf(lastOk)} keine Daten.${lastError ? ` ${lastError}.` : ''}`, url: './', tag: 'outage', urgent: true });
      } else if (!down && notifyState.outage) {
        await sendOnce('outage', 0, { title: 'Solar-Log wieder erreichbar', body: 'Die Daten kommen wieder, Lücken werden aus der Tageskurve ergänzt.', url: './?tab=day&w=day', tag: 'outage' });
      }
    }
    const b = live.bat;
    if (b && b.soc < 95) belowDay = day;
    if (s.pushFull && b && b.soc >= 99 && belowDay === day && notifyState.fullDay !== day) {
      await sendOnce('fullDay', day, { title: 'Akku voll', body: `Der Akku ist um ${hm} voll geladen.`, url: './?tab=day&w=battery', tag: 'battery' });
    }
    // Ausblick: einmal pro Tag und eingestellter Uhrzeit (eine neue Uhrzeit gilt auch am selben Tag); ohne Prognose warten
    const at = s.pushEveningTime || '19:00', mark = `${day} ${at}`;
    if (s.pushEvening && hm >= at && notifyState.eveningDay !== mark) {
      const f = apiForecast(), m = f?.days?.[f.tomorrow];
      if (!m) { if (!tries.noForecast) console.error(new Date().toISOString(), 'Ausblick wartet: noch keine Prognose für morgen', f?.error || ''); tries.noForecast = 1; }
      else {
        delete tries.noForecast;
        const w = windowText(m);
        await sendOnce('eveningDay', mark, { title: `Morgen ca. ${kwh1(m.wh)} kWh`, body: [m.weather, w ? `Gutes Zeitfenster für grosse Geräte: ${w}` : 'Kaum Überschuss für grosse Geräte.'].filter(Boolean).join(' · '),
          url: './?tab=now', tag: 'evening' });
      }
    }
  } catch (e) { console.error(new Date().toISOString(), 'Mitteilungen:', e.message); }
}
setInterval(notifyTick, 60e3);

// ---------- Typischer Tag und Akku-Modell ----------
// Aus den Messpunkten der letzten 3 Wochen: Verbrauch pro Viertelstunde als Median über die Tage (Spitzen, die fast
// jeden Tag zur selben Zeit kommen, wie der Boiler, bleiben; einmalige fallen weg), dazu Grundlast und die
// wiederkehrenden Spitzen. Fürs Akku-Modell: Energie pro Prozent Ladezustand beim Laden und Entladen (aus Abschnitten
// mit mindestens 10 % Änderung), übliche Lade- und Entladeleistung und wie tief der Akku nachts üblicherweise geht.
let profileCache = null;
const medianOf = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function apiProfile() {
  if (profileCache && Date.now() - profileCache.at < 30 * 60e3) return profileCache.data;
  const today = dayKey(Date.now()), perSlot = Array.from({ length: 96 }, () => []);
  const lows = [], chg = [], dis = [], inPct = [], outPct = [];
  let days = 0;
  for (let k = 21; k >= 1; k--) {
    const day = addDays(today, -k), t0 = dayStartTs(day), t1 = dayStartTs(addDays(day, 1)), slotMs = (t1 - t0) / 96;
    const rows = q.samplesBetween.all(t0, t1);
    if (!rows.length) continue;
    const sum = new Array(96).fill(0), cnt = new Array(96).fill(0);
    let low = null, seg = null;
    const close = () => { if (seg && Math.abs(seg.s1 - seg.s0) >= 10) (seg.dir > 0 ? inPct : outPct).push(seg.e / Math.abs(seg.s1 - seg.s0)); seg = null; };
    rows.forEach((r, i) => {
      const sl = Math.min(95, Math.floor((r.ts - t0) / slotMs));
      sum[sl] += r.cons; cnt[sl]++;
      if (r.bat != null) { if (r.bat > 50) chg.push(r.bat); else if (r.bat < -50) dis.push(-r.bat); }
      if (r.soc != null) low = low == null ? r.soc : Math.min(low, r.soc);
      const nx = rows[i + 1], gap = nx ? nx.ts - r.ts : 0, dir = r.bat > 150 ? 1 : r.bat < -150 ? -1 : 0;
      if (seg && (dir !== seg.dir || r.soc == null)) close();
      if (dir && r.soc != null) {
        if (!seg) seg = { dir, s0: r.soc, s1: r.soc, e: 0 };
        seg.s1 = r.soc;
        if (gap > 0 && gap <= 600e3) seg.e += Math.abs(r.bat) * gap / 3600e3; else close();
      }
    });
    close();
    if (cnt.filter(Boolean).length < 80) continue; // Tag mit grossen Lücken nicht fürs Profil
    days++;
    for (let s = 0; s < 96; s++) if (cnt[s]) perSlot[s].push(sum[s] / cnt[s]);
    if (low != null) lows.push(low);
  }
  if (days < 3) return { days };
  const slots = perSlot.map((a) => Math.round(medianOf(a) ?? 0));
  const base = Math.round(quantile(slots, 0.1));
  const runs = []; let cur = null;
  slots.forEach((w, s) => {
    if (w > base + 500) { if (!cur) cur = { from: s, to: s, max: w, wh: 0 }; cur.to = s; cur.max = Math.max(cur.max, w); cur.wh += (w - base) / 4; }
    else if (cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  const peaks = runs.filter((r) => r.wh >= 150).sort((a, b) => b.wh - a.wh).slice(0, 4).sort((a, b) => a.from - b.from)
    .map((r) => ({ from: r.from, to: r.to + 1, maxW: Math.round(r.max), wh: Math.round(r.wh) }));
  const data = {
    days, slots, base, peaks, typicalWh: Math.round(slots.reduce((a, w) => a + w / 4, 0)),
    bat: { whPerPctIn: medianOf(inPct), whPerPctOut: medianOf(outPct), chargeMax: Math.round(quantile(chg, 0.95) || 0),
      dischargeMax: Math.round(quantile(dis, 0.95) || 0), low: medianOf(lows) },
  };
  profileCache = { at: Date.now(), data };
  return data;
}

// ---------- Strompreis der Gemeinde (ElCom) ----------
// Standort -> Gemeindenummer (geo.admin.ch) -> Preise aller Jahre für das gewählte Verbrauchsprofil aus den offenen
// Daten der ElCom (LINDAS). Verwendet wird der Preis pro kWh ohne Grundgebühr: genau das spart jede selbst genutzte kWh.
// Nach aussen gehen nur die Koordinaten und die Gemeindenummer.
const TARIFF_CATS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'];
const elcomKey = (s = settings) => s.lat == null || s.tariffAuto === false ? null : [s.lat, s.lon, s.tariffCategory || 'H5'].join('|');
let elcom = meta('elcom', null), elcomError = null;

async function fetchElcom(lat, lon, cat) {
  const get = async (url, opts) => {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const g = await get(`https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometryType=esriGeometryPoint&geometry=${lon},${lat}`
    + '&sr=4326&layers=all:ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill&tolerance=0&returnGeometry=false&imageDisplay=1,1,96&mapExtent=0,0,1,1');
  const gde = (g.results || []).map((x) => x.attributes).sort((a, b) => (b.is_current_jahr - a.is_current_jahr) || (b.jahr - a.jahr))[0];
  const bfs = Math.round(Number(gde?.gde_nr));
  if (!bfs) throw new Error('Zum Standort wurde keine Schweizer Gemeinde gefunden.');
  const D = 'https://energy.ld.admin.ch/elcom/electricityprice';
  const query = `PREFIX d: <${D}/dimension/> PREFIX schema: <http://schema.org/>
    SELECT ?period ?total ?op ?opname WHERE {
      ?obs d:municipality <https://ld.admin.ch/municipality/${bfs}> ; d:category <${D}/category/${cat}> ;
           d:product <${D}/product/standard> ; d:period ?period ; d:total ?total ; d:operator ?op .
      OPTIONAL { ?op schema:name ?opname }
    } ORDER BY DESC(?period) ?total`;
  const r = await get('https://lindas.admin.ch/query', { method: 'POST', headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ query }) });
  const rows = (r.results?.bindings || []).map((b) => ({ year: String(b.period.value).slice(0, 4), rp: Number(b.total.value), op: b.op.value, name: b.opname?.value || '' }));
  if (!rows.length) throw new Error(`Für die Gemeinde ${gde.gemname} hat die ElCom keine Preise.`);
  // mehrere Netzbetreiber in einer Gemeinde: den nehmen, der im neusten Jahr am günstigsten ist, und für alle Jahre bei ihm bleiben
  const op = rows[0].op, years = {};
  for (const x of rows) if (x.op === op && years[x.year] == null && Number.isFinite(x.rp)) years[x.year] = Math.round(x.rp * 10) / 1000;
  return { key: [lat, lon, cat].join('|'), bfs, gemeinde: gde.gemname, operator: rows[0].name, category: cat, years, fetched: Date.now() };
}

// Preis des laufenden Jahres als Netzbezug übernehmen, alle Jahre fürs Rechnen mit dem Preis des jeweiligen Jahres
function applyTariff() {
  const on = elcomKey() && elcom?.key === elcomKey(), y = dayKey(Date.now()).slice(0, 4);
  if (!on) { settings.tariffByYear = null; settings.tariffInfo = elcomKey() ? { error: elcomError || 'Strompreis wird geladen.' } : null; return; }
  const known = Object.keys(elcom.years).sort(), year = elcom.years[y] != null ? y : known.filter((k) => k <= y).at(-1) || known[0];
  settings.tariffImport = elcom.years[year];
  settings.tariffByYear = elcom.years;
  settings.tariffInfo = { gemeinde: elcom.gemeinde, operator: elcom.operator, category: elcom.category, year, next: elcom.years[String(Number(y) + 1)] ?? null, error: elcomError };
}

// einmal am Tag nachsehen; die ElCom veröffentlicht die Preise fürs nächste Jahr jeweils Ende August
async function refreshTariff() {
  const key = elcomKey();
  if (key && (!elcom || elcom.key !== key || Date.now() - elcom.fetched > 20 * 3600e3)) {
    try {
      const [lat, lon, cat] = key.split('|');
      elcom = await fetchElcom(Number(lat), Number(lon), cat); setMeta('elcom', elcom); elcomError = null;
    } catch (e) {
      elcomError = e.name === 'TimeoutError' ? 'Die ElCom-Daten antworten nicht.' : String(e.message || e);
      console.error(new Date().toISOString(), 'Strompreis:', elcomError);
    }
  }
  applyTariff(); setMeta('settings', settings);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8' };
const PUBLIC = path.join(__dirname, 'public');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100_000) { reject(new Error('zu gross')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    const p = url.pathname, sp = url.searchParams;
    if (p === '/api/state') return json(apiState());
    if (p === '/api/day') return json(apiDay(sp.get('date')));
    if (p === '/api/series') return json(apiSeries(sp.get('period') || 'month', sp.get('ref')));
    if (p === '/api/days') return json(q.lastDays.all(Math.min(Math.max(Number(sp.get('n') || 30), 1), 400)).reverse().map(enrichDay));
    if (p === '/api/heatmap') return json(apiHeatmap(Number(sp.get('days'))));
    if (p === '/api/years') return json(apiYearsMonths());
    if (p === '/api/forecast') return json(apiForecast());
    if (p === '/api/profile') return json(apiProfile());
    if (p === '/api/push/key') return json({ key: vapidKeys().pub });
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const b = await readBody(req), ep = String(b.endpoint || '');
      if (!/^https:\/\//.test(ep) || !b.keys?.p256dh || !b.keys?.auth) return json({ error: 'Ungültiges Abo.' }, 400);
      const subs = meta('pushSubs', []).filter((x) => x.endpoint !== ep);
      subs.push({ endpoint: ep, keys: { p256dh: String(b.keys.p256dh), auth: String(b.keys.auth) }, created: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 120) });
      setMeta('pushSubs', subs.slice(-10));
      return json({ ok: true, total: Math.min(10, subs.length) });
    }
    if (p === '/api/push/unsubscribe' && req.method === 'POST') {
      const ep = String((await readBody(req)).endpoint || '');
      setMeta('pushSubs', meta('pushSubs', []).filter((x) => x.endpoint !== ep));
      return json({ ok: true });
    }
    if (p === '/api/push/test' && req.method === 'POST') {
      const pvTxt = live.pv < 1000 ? `${Math.round(live.pv)} W` : `${(live.pv / 1000).toFixed(2)} kW`;
      const r = await pushAll({ title: 'Test vom Solar-Dashboard', body: `So sehen Mitteilungen aus. Solar gerade ${pvTxt}. Antippen öffnet das Dashboard.`, url: './?tab=now', tag: 'test' });
      return json(r, r.sent ? 200 : 422);
    }
    // 3D-Haus: getrennt von den Einstellungen gespeichert, damit /api/state klein bleibt
    if (p === '/api/daysrange') { // Tage eines Zeitraums, z. B. für den Jahresrückblick
      const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
      if (!ok(sp.get('from')) || !ok(sp.get('to'))) return json({ error: 'from und to als YYYY-MM-DD angeben' }, 400);
      return json(q.daysRange.all(sp.get('from'), sp.get('to')).map(enrichDay));
    }
    if (p === '/api/settings' && req.method === 'GET') return json({ settings, layout });
    if (p === '/api/settings' && req.method === 'PUT') {
      const body = await readBody(req);
      let warning = null;
      if (body.settings) {
        const next = cleanSettings(body.settings);
        const loc = typeof body.settings.location === 'string' ? body.settings.location.trim().slice(0, 80) : null;
        if (loc != null && loc !== (settings.location || '')) {
          try { Object.assign(next, await geocode(loc)); } catch (e) { warning = e.name === 'TimeoutError' ? 'Die Ortssuche antwortet nicht.' : e.message; }
        }
        if (body.settings.pvOrientation != null && !parseAzimuths(body.settings.pvOrientation)) warning = 'Ausrichtung nicht verstanden. Gradzahlen zwischen 0 und 360 eingeben, mehrere mit Komma, z. B. 169, 259.';
        const fcChanged = fcKey(next) !== fcKey(), tfChanged = elcomKey(next) !== elcomKey();
        settings = next; applyTariff(); setMeta('settings', settings);
        if (fcChanged) await refreshForecast();
        if (tfChanged) await refreshTariff();
      }
      if (body.layout) { layout = cleanLayout(body.layout); setMeta('layout', layout); }
      if (body.resetLayout) { layout = batSeen || CFG.demo ? withBattery(DEFAULT_LAYOUT) : DEFAULT_LAYOUT; setMeta('layout', layout); }
      return json({ settings, layout, warning });
    }
    if (p === '/healthz') return json({ ok: !lastError, lastOk });

    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=86400' : 'no-cache' });
    res.end(body);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'EISDIR') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
    console.error(e); json({ error: String(e.message || e) }, 500);
  }
});

if (CFG.demo) { seedDemo(); ensureBatteryWidget(); }
await poll();
// Tageswerte, danach im Hintergrund die 5-Minuten-Kurven (läuft beim ersten Mal einige Minuten) und Lücken in Live-Tagen
const syncHistory = () => importHistory().catch((e) => console.error('Historie:', e.message)).then(importCurves).then(fillGaps).then(fillTodayGaps);
// kurz nach Mitternacht den Vortag vervollständigen (der Solar-Log hat dann die ganze Kurve)
function scheduleGaps() {
  const next = dayStartTs(addDays(dayKey(Date.now()), 1)) + 10 * 60e3;
  setTimeout(() => { fillGaps().catch((e) => console.error('Lücken:', e.message)).finally(scheduleGaps); }, next - Date.now());
}
if (!CFG.demo) { syncHistory(); setInterval(syncHistory, 6 * 3600e3); scheduleGaps(); setInterval(() => fillTodayGaps().catch(() => {}), 30 * 60e3); }
setInterval(() => q.prune.run(Date.now() - 400 * 864e5), 3600e3);
refreshForecast(); setInterval(refreshForecast, 30 * 60e3); // Open-Meteo rechnet stündlich neu
refreshTariff(); setInterval(refreshTariff, 6 * 3600e3);

// Tägliches Backup: ab 3 Uhr nachts eine saubere Kopie der Datenbank nach data/backup/solar-JJJJ-MM-TT.db
// (VACUUM INTO geht bei laufendem Betrieb und schreibt einen stimmigen Stand), die letzten 14 Tage bleiben.
// Wiederherstellen: Container stoppen, gewünschte Datei als data/solar.db zurückkopieren, starten.
const BACKUP_DIR = path.join(path.dirname(CFG.dbPath), 'backup');
function backupDb() {
  try {
    const hour = Number(new Intl.DateTimeFormat('de-CH', { timeZone: CFG.tz, hour: '2-digit', hourCycle: 'h23' }).format(Date.now()));
    if (CFG.demo || hour < 3) return;
    mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `solar-${dayKey(Date.now())}.db`);
    if (existsSync(file)) return; // heute schon gesichert
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = readdirSync(BACKUP_DIR).filter((f) => /^solar-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14);
    for (const f of old) unlinkSync(path.join(BACKUP_DIR, f));
    console.log(new Date().toISOString(), `Backup: ${path.basename(file)} angelegt${old.length ? `, ${old.length} ältere entfernt` : ''}`);
  } catch (e) { console.error(new Date().toISOString(), 'Backup:', e.message); }
}
setTimeout(backupDb, 2 * 60e3); setInterval(backupDb, 30 * 60e3);
server.listen(CFG.port, () => console.log(`Solar-Dashboard läuft auf http://0.0.0.0:${CFG.port} (${CFG.demo ? 'Demo-Modus' : `Quelle ${CFG.solarlog}`})`));
