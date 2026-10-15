// Third-party VAST tag resolver for @adviverse/games.
//
// A video creative may carry an advertiser's ad-server VAST tag
// (creative.vast_tag_url) instead of a hosted asset (asset_url empty). The
// presenter resolves it at load time: GET the tag (CORS), follow the Wrapper
// chain (≤5 hops), pick a playable progressive MediaFile (video/mp4, then
// video/webm, then anything the browser can play; never VPAID / JavaScript),
// and collect every third-party beacon along the chain (Impression / Error /
// Tracking / ClickTracking) plus the final ClickThrough, skipoffset and
// Duration. Mirrors the engine's web SDK (sdk_vast.js). Dependency-free.

export const MAX_WRAPPERS = 5;

/** VAST error codes the resolver/player reports ([ERRORCODE]). */
export const VastError = {
  XML: 100,
  TIMEOUT: 301,
  WRAPPER_LIMIT: 302,
  NO_AD: 303,
  MEDIA_NOT_FOUND: 401,
  MEDIA_TIMEOUT: 402,
  MEDIA_UNSUPPORTED: 403,
  MEDIA_PLAY: 405,
} as const;

export interface VastMedia {
  url: string;
  type: string;
}

export interface VastResult {
  media: VastMedia | null;
  clickThrough: string;
  /** Seconds after which the ad may be skipped; -1 = not skippable. */
  skipOffset: number;
  /** Linear <Duration> in seconds (0 when absent/unparseable). */
  duration: number;
  imp: string[];
  err: string[];
  clk: string[];
  track: Record<string, string[]>;
}

/** One parsed VAST document (a single hop of the chain). */
export interface VastDoc {
  /** false when the document holds no <Ad>. */
  hasAd: boolean;
  /** Next hop URL when this is a <Wrapper>, else "". */
  next: string;
  imp: string[];
  err: string[];
  clk: string[];
  track: Record<string, string[]>;
  clickThrough: string;
  skipOffsetRaw: string;
  duration: number;
  mediaFiles: Array<{ url: string; type: string; api: string }>;
}

export interface ResolveOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injectable for tests; defaults to DOMParser. */
  parse?: (xml: string) => Document;
  /** Whether the platform can play a MIME type (third preference tier). */
  canPlay?: (type: string) => boolean;
  /** Per-hop timeout (ms). Default 8000. */
  timeoutMs?: number;
}

// vastMacros fills the IAB macros a player is responsible for.
export function vastMacros(u: string, code?: number): string {
  return String(u)
    .replace(/\[CACHEBUSTING\]/g, String(Math.floor(1e7 + Math.random() * 9e7)))
    .replace(/\[TIMESTAMP\]/g, encodeURIComponent(new Date().toISOString()))
    .replace(/\[ERRORCODE\]/g, code ? String(code) : '');
}

// pixel fires a third-party GET beacon (Image, not sendBeacon: VAST trackers
// expect GET and many reject POST).
export function pixel(u: string): void {
  if (!u || typeof Image === 'undefined') return;
  try {
    const i = new Image();
    i.src = u;
  } catch {
    /* best effort */
  }
}

export function fireAll(list: string[] | undefined, code?: number): void {
  for (const u of list || []) pixel(vastMacros(u, code));
}

/** parseTime converts "HH:MM:SS(.mmm)" to seconds; -1 when unparseable. */
export function parseTime(s: string): number {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/.exec(s || '');
  if (!m) return -1;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** skipOffsetSeconds resolves a skipoffset ("HH:MM:SS" or "N%") to seconds; -1 = none. */
export function skipOffsetSeconds(raw: string, duration: number): number {
  const v = (raw || '').trim();
  if (!v) return -1;
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(v);
  if (pct) return duration > 0 ? (Number(pct[1]) / 100) * duration : -1;
  return parseTime(v);
}

function all(root: Element | Document, tag: string): Element[] {
  return Array.prototype.slice.call(root.getElementsByTagName(tag)) as Element[];
}
function txt(n: Element | undefined | null): string {
  return n ? String(n.textContent || '').trim() : '';
}

/** parseVastDoc extracts one hop's beacons, next URL and creative details. */
export function parseVastDoc(doc: Document): VastDoc {
  const out: VastDoc = {
    hasAd: false, next: '', imp: [], err: [], clk: [], track: {},
    clickThrough: '', skipOffsetRaw: '', duration: 0, mediaFiles: [],
  };
  const ad = all(doc, 'Ad')[0];
  if (!ad) return out;
  out.hasAd = true;
  for (const n of all(ad, 'Impression')) if (txt(n)) out.imp.push(txt(n));
  for (const n of all(ad, 'Error')) if (txt(n)) out.err.push(txt(n));
  for (const n of all(ad, 'ClickTracking')) if (txt(n)) out.clk.push(txt(n));
  for (const n of all(ad, 'Tracking')) {
    const ev = n.getAttribute('event');
    if (ev && txt(n)) (out.track[ev] = out.track[ev] || []).push(txt(n));
  }
  if (all(ad, 'Wrapper').length) out.next = txt(all(ad, 'VASTAdTagURI')[0]);
  out.clickThrough = txt(all(ad, 'ClickThrough')[0]);
  const linear = all(ad, 'Linear')[0];
  if (linear) out.skipOffsetRaw = linear.getAttribute('skipoffset') || '';
  out.duration = Math.max(0, parseTime(txt(all(ad, 'Duration')[0])));
  out.mediaFiles = all(ad, 'MediaFile').map((n) => ({
    url: txt(n),
    type: (n.getAttribute('type') || '').toLowerCase(),
    api: n.getAttribute('apiFramework') || '',
  }));
  return out;
}

/** pickMedia chooses a progressive, non-interactive MediaFile. */
export function pickMedia(files: VastDoc['mediaFiles'], canPlay?: (t: string) => boolean): VastMedia | null {
  const ok = files.filter(
    (f) => f.url && !f.api && f.type !== 'application/javascript' && /^https?:\/\//i.test(f.url),
  );
  for (const pref of ['video/mp4', 'video/webm']) {
    const f = ok.find((x) => x.type === pref);
    if (f) return { url: f.url, type: f.type };
  }
  if (canPlay) {
    for (const f of ok) {
      try {
        if (f.type && canPlay(f.type)) return { url: f.url, type: f.type };
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function browserCanPlay(type: string): boolean {
  if (typeof document === 'undefined') return false;
  const v = document.createElement('video');
  return !!(v.canPlayType && v.canPlayType(type));
}

/**
 * resolveVast follows a VAST tag to a playable MediaFile. Resolves to
 * {code:null, res} on success, or {code, res} with a VAST error code and the
 * beacons collected so far (so the caller can fire the chain's <Error> URLs).
 */
export async function resolveVast(
  tagUrl: string,
  opts: ResolveOptions = {},
): Promise<{ code: number | null; res: VastResult }> {
  const res: VastResult = {
    media: null, clickThrough: '', skipOffset: -1, duration: 0,
    imp: [], err: [], clk: [], track: {},
  };
  const doFetch = opts.fetchImpl || ((u: string, i?: RequestInit) => fetch(u, i));
  const parse = opts.parse || ((x: string) => new DOMParser().parseFromString(x, 'text/xml'));
  const timeoutMs = opts.timeoutMs ?? 8000;

  let url = tagUrl;
  for (let depth = 1; ; depth++) {
    if (depth > MAX_WRAPPERS) return { code: VastError.WRAPPER_LIMIT, res };
    let xml: string;
    try {
      xml = await fetchText(doFetch, vastMacros(url), timeoutMs);
    } catch {
      return { code: VastError.TIMEOUT, res };
    }
    let doc: Document;
    try {
      doc = parse(xml);
    } catch {
      return { code: VastError.XML, res };
    }
    if (all(doc, 'parsererror').length) return { code: VastError.XML, res };
    const d = parseVastDoc(doc);
    if (!d.hasAd) return { code: VastError.NO_AD, res };
    res.imp.push(...d.imp);
    res.err.push(...d.err);
    res.clk.push(...d.clk);
    for (const ev of Object.keys(d.track)) (res.track[ev] = res.track[ev] || []).push(...d.track[ev]);
    if (d.next) {
      url = d.next;
      continue;
    }
    res.clickThrough = d.clickThrough;
    res.duration = d.duration;
    res.skipOffset = skipOffsetSeconds(d.skipOffsetRaw, d.duration);
    res.media = pickMedia(d.mediaFiles, opts.canPlay || browserCanPlay);
    return { code: res.media ? null : VastError.MEDIA_UNSUPPORTED, res };
  }
}

async function fetchText(
  doFetch: (u: string, i?: RequestInit) => Promise<Response>,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl?.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    const r = await Promise.race([doFetch(url, { credentials: 'omit', signal: ctl?.signal }), timeout]);
    if (!r.ok) throw new Error('http ' + r.status);
    return await Promise.race([r.text(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Quartile/progress events the presenter fires from the media's timeline. */
export const QUARTILES: Array<[string, number]> = [
  ['firstQuartile', 0.25],
  ['midpoint', 0.5],
  ['thirdQuartile', 0.75],
];

/**
 * VastTracker fires the chain's third-party tracking for a playing video:
 * Impression + start/creativeView on start, quartiles from timeupdate,
 * complete on end, mute/unmute/pause/resume/skip on the matching player
 * events. Each event fires at most once (pause/resume/mute toggles excepted).
 */
export class VastTracker {
  private fired = new Set<string>();
  constructor(private res: VastResult) {}

  /** Fire an event's URLs; `once` events never fire twice. */
  fire(ev: string, once = true): void {
    if (once) {
      if (this.fired.has(ev)) return;
      this.fired.add(ev);
    }
    fireAll(this.res.track[ev]);
  }

  started(): void {
    if (this.fired.has('__imp')) return;
    this.fired.add('__imp');
    fireAll(this.res.imp);
    this.fire('creativeView');
    this.fire('start');
  }

  progress(current: number, duration: number): void {
    if (!(duration > 0)) return;
    for (const [ev, at] of QUARTILES) if (current / duration >= at) this.fire(ev);
  }

  clicked(): void {
    fireAll(this.res.clk);
  }

  error(code: number): void {
    fireAll(this.res.err, code);
  }
}
