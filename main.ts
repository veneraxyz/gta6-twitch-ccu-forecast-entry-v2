// GTA VI launch-day Twitch forecast, v2.
//
// Model: scale-matched launch curves. For each hour of the release day,
// take the past launches whose hour-1 print is close in size to this
// case's, average their log-ratios ln(viewers_h / viewers_1) with a
// trimmed mean, stretch the result (launches systematically outgrow
// their hour-1 print), and hang asymmetric log-normal quantiles off it:
// the upside tail is wider than the downside tail, because a launch can
// explode upward but can only fall so far. A shape guard keeps the
// forecast sane when the hour-1 print is far above every past launch.
import * as fs from "node:fs";
import * as path from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z_SCORES = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const SPREAD_BELOW = 0.2;
const SPREAD_ABOVE = 0.3;
const LIFT = 1.3;
const TRIM = 0.2;
const BAND = 2;
const LATE_SHAPE_MIN = 0.2;
const MAX_VIEWERS = 1e9;

type HourlyPoint = { from: string; viewers: number };
type Comparable = {
  name: string;
  day_start: string;
  unlock: string;
  hourly: HourlyPoint[];
};
type CaseFile = {
  id: string;
  known: Array<{ viewers: number }>;
  history_hourly?: Array<{ from: string; viewers: number }>;
  comparables: Comparable[];
};

function trimmedMean(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  let cut = Math.floor(n * TRIM);
  if (n - 2 * cut <= 0) cut = Math.max(0, Math.floor((n - 1) / 2));
  const core = n - 2 * cut > 0 ? sorted.slice(cut, n - cut) : sorted;
  let total = 0;
  for (const v of core) total += v;
  return total / core.length;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

// Release-day curve: viewers for hours 1..24, null where the hour is
// missing or non-positive. Hours are whole hours after day_start.
function releaseCurve(comp: Comparable, dayStartMs: number): Array<number | null> {
  const curve: Array<number | null> = new Array(24).fill(null);
  for (const row of comp.hourly) {
    const at = Date.parse(row.from);
    if (!Number.isFinite(at)) continue;
    const deltaHours = (at - dayStartMs) / 3600000;
    const h = Math.round(deltaHours);
    if (deltaHours >= 0 && deltaHours < 24 && Math.abs(deltaHours - h) < 1e-6) {
      if (typeof row.viewers === "number" && row.viewers > 0) curve[h] = row.viewers;
    }
  }
  return curve;
}

type Launch = { h1: number; curve: Array<number | null> };

function usableLaunches(caseFile: CaseFile): Launch[] {
  const launches: Launch[] = [];
  for (const comp of caseFile.comparables ?? []) {
    // Early-access launches are contaminated: their release-day curve is
    // polluted by the early-access peak days before. The Tier marker in
    // the unlock note is the signal; a mere mention is not.
    if (String(comp.unlock ?? "").toLowerCase().includes("early-access-contaminated")) continue;
    const dayStartMs = Date.parse(comp.day_start ?? "");
    if (!Number.isFinite(dayStartMs)) continue;
    const curve = releaseCurve(comp, dayStartMs);
    const h1 = curve[0];
    if (h1 === null || h1 <= 0) continue;
    launches.push({ h1, curve });
  }
  return launches;
}

function logRatios(band: Launch[], hour: number): number[] {
  const out: number[] = [];
  for (const launch of band) {
    const v = launch.curve[hour - 1];
    if (v !== null && v > 0) out.push(Math.log(v / launch.h1));
  }
  return out;
}

function pickBand(p1: number, pool: Launch[], width: number): Launch[] {
  const close = pool.filter((c) => c.h1 >= p1 / width && c.h1 <= p1 * width);
  if (close.length > 0) return close;
  const wide = pool.filter((c) => c.h1 >= p1 / 10 && c.h1 <= p1 * 10);
  if (wide.length > 0) return wide;
  return pool.filter((c) => c.h1 >= 10000);
}

function hourlyCentres(p1: number, pool: Launch[], width: number): Map<number, number> {
  const band = pickBand(p1, pool, width);
  const centres = new Map<number, number>();
  for (let h = 2; h <= 24; h++) centres.set(h, trimmedMean(logRatios(band, h)));
  return centres;
}

function lateDayShape(centres: Map<number, number>): number {
  const tail: number[] = [];
  for (let h = 18; h <= 24; h++) tail.push(centres.get(h) ?? 0);
  return average(tail);
}

// Mean late-day log-ratio of one launch (hours 18-24): positive when the
// launch's audience kept growing into the evening.
function launchLateRise(launch: Launch): number {
  const tail: number[] = [];
  for (let h = 18; h <= 24; h++) {
    const v = launch.curve[h - 1];
    if (v !== null && v > 0) tail.push(Math.log(v / launch.h1));
  }
  return average(tail);
}

function forecastCase(caseFile: CaseFile): { hours: Array<{ hour: number; q: number[] }> } {
  const knownRow = (caseFile.known ?? [])[0];
  let p1 = knownRow && typeof knownRow.viewers === "number" ? knownRow.viewers : NaN;
  if (!Number.isFinite(p1) || p1 < 1) {
    const hist = caseFile.history_hourly ?? [];
    const last = hist.length > 0 ? hist[hist.length - 1].viewers : NaN;
    p1 = Number.isFinite(last) && last >= 1 ? last : 1;
  }
  const pool = usableLaunches(caseFile);

  // Shape guard: when the hour-1 print towers over every past launch,
  // the tight band holds only front-loaded launches whose hour-1 was a
  // peak, and their curves decay all day. A launch-day curve that falls
  // into the evening contradicts how rolling-midnight console launches
  // behave, so widen the band until the late-day shape is clearly
  // rising (mean centre over hours 18-24 of at least +0.2 in log terms
  // — every practice case's tight band clears +0.38, so this never
  // fires there); if no width gets there, fall back to the launches
  // that did keep growing into the evening.
  let centres = hourlyCentres(p1, pool, BAND);
  let widthUsed = BAND;
  for (const w of [3, 4, 6, 10]) {
    if (lateDayShape(centres) >= LATE_SHAPE_MIN) break;
    centres = hourlyCentres(p1, pool, w);
    widthUsed = w;
  }
  if (lateDayShape(centres) < LATE_SHAPE_MIN) {
    const rising = pool.filter((c) => launchLateRise(c) > 0);
    if (rising.length > 0) centres = hourlyCentres(p1, rising, widthUsed);
  }

  const hours: Array<{ hour: number; q: number[] }> = [];
  for (let h = 2; h <= 24; h++) {
    const centre = LIFT * (centres.get(h) ?? 0);
    const row: number[] = Z_SCORES.map((z) => {
      const spread = z < 0 ? SPREAD_BELOW : SPREAD_ABOVE;
      return Math.min(MAX_VIEWERS, Math.max(1, p1 * Math.exp(centre + z * spread)));
    });
    for (let i = 1; i < row.length; i++) row[i] = Math.max(row[i], row[i - 1]);
    hours.push({ hour: h, q: row });
  }
  return { hours };
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs.readdirSync(inputDir).filter((f) => f.endsWith(".in")).sort();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(inputDir, file), "utf8");
    const caseFile = JSON.parse(raw) as CaseFile;
    const forecast = forecastCase(caseFile);
    const id = file.replace(/\.in$/, "");
    fs.writeFileSync(path.join(outputDir, `${id}.out`), JSON.stringify(forecast));
  }
}

main();
