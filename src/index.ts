// @adviverse/games — rewarded + interstitial ads for HTML5 / web games.
//
// Adviverse serves the ads itself (no GameDistribution / Poki / CrazyGames
// relationship needed). This is the browser presenter: it fetches a full-screen
// ad from the engine's game endpoint, plays it over your canvas, fires the
// impression, and — for rewarded — confirms the signed reward callback before
// your `onReward` runs, so you only grant currency for a real, completed view.
//
// Framework-free, dependency-free, works in any browser game (vanilla canvas,
// Phaser, PixiJS, Construct, Unity/Godot WebGL via their JS bridges).

import { resolveVast, pixel, VastError, VastTracker, type VastResult } from './vast.js';

export { resolveVast } from './vast.js';
export type { VastResult } from './vast.js';

const DEFAULT_BASE = 'https://serve.adviverse.com';

export interface GamesConfig {
  /** Serve host. Default https://serve.adviverse.com */
  base?: string;
  /** Label for reporting/integrity (default "game-web"). */
  client?: string;
  /** Stable per-player id. Auto-generated + persisted if omitted. */
  uid?: string;
  /** Privacy signals forwarded to serving. */
  consent?: { gdpr?: string; usPrivacy?: string };
}

export interface Creative {
  type?: string;
  asset_url?: string;
  main_image_url?: string;
  icon_url?: string;
  title?: string;
  description?: string;
  cta?: string;
  brand_name?: string;
  duration?: number;
  skip_offset_sec?: number;
  /** Third-party VAST tag; when asset_url is empty the SDK resolves it. */
  vast_tag_url?: string;
}

interface AdResponse {
  request_id: string;
  format: string;
  creative: Creative;
  imp_url: string; // relative, e.g. /imp?rid=…
  click_url: string; // relative
  reward_url?: string; // absolute, rewarded only
}

export interface ShowOptions {
  /** Publisher placement tag. Required. */
  tag: string;
  /** Override the per-player uid for this call. */
  uid?: string;
  /** Granted only after a completed view + verified reward (rewarded only). */
  onReward?: () => void;
  /** Called when the ad closes (rewarded or skipped/finished interstitial). */
  onClose?: () => void;
  /** No-fill, network error, or the player closed early. */
  onError?: (reason: string) => void;
}

const UID_KEY = 'adviverse_game_uid';

function persistedUid(): string {
  try {
    let v = localStorage.getItem(UID_KEY);
    if (!v) {
      v = 'gm_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(UID_KEY, v);
    }
    return v;
  } catch {
    return 'gm_ephemeral';
  }
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const css = `
.adv-g-ov{position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;
  align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif}
.adv-g-media{max-width:100%;max-height:100%;object-fit:contain;cursor:pointer}
.adv-g-label{position:absolute;top:10px;left:10px;background:rgba(0,0,0,.6);color:#fff;
  font-size:11px;line-height:1;padding:4px 7px;border-radius:4px;letter-spacing:.04em;text-transform:uppercase}
.adv-g-timer{position:absolute;top:10px;right:10px;background:rgba(0,0,0,.6);color:#fff;
  font-size:13px;min-width:26px;height:26px;padding:0 8px;border-radius:13px;display:flex;
  align-items:center;justify-content:center}
.adv-g-close{position:absolute;top:8px;right:8px;width:30px;height:30px;border-radius:15px;
  background:rgba(0,0,0,.6);color:#fff;border:none;font-size:18px;cursor:pointer;display:none;
  align-items:center;justify-content:center;line-height:1}
.adv-g-close.show{display:flex}
.adv-g-cta{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);background:#1b50e0;
  color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px}
`;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}

export class AdviverseGames {
  private base: string;
  private client: string;
  private uid: string;
  private consent?: { gdpr?: string; usPrivacy?: string };
  private busy = false;

  constructor(cfg: GamesConfig = {}) {
    this.base = (cfg.base || DEFAULT_BASE).replace(/\/$/, '');
    this.client = cfg.client || 'game-web';
    this.uid = cfg.uid || persistedUid();
    this.consent = cfg.consent;
  }

  /** Show a rewarded ad. `onReward` fires only after a completed, verified view. */
  showRewarded(opts: ShowOptions): Promise<void> {
    return this.show('rewarded', opts);
  }

  /** Show a skippable interstitial. */
  showInterstitial(opts: ShowOptions): Promise<void> {
    return this.show('interstitial', opts);
  }

  private async show(format: 'rewarded' | 'interstitial', opts: ShowOptions): Promise<void> {
    if (typeof document === 'undefined') return;
    // One ad at a time — a second overlay would stack and double-bill.
    if (this.busy) {
      opts.onError?.('busy');
      return;
    }
    this.busy = true;
    try {
      const ad = await this.fetchAd(format, opts);
      if (!ad || !ad.creative) {
        opts.onError?.('no_fill');
        return;
      }
      // Third-party VAST tag (no hosted asset): resolve it to a playable
      // MediaFile first. Any failure fires the chain's <Error> + ours and is a
      // no-fill — the ad never shows, so a rewarded one can never grant.
      let ext: VastResult | undefined;
      if (!ad.creative.asset_url && ad.creative.vast_tag_url) {
        const { code, res } = await resolveVast(ad.creative.vast_tag_url);
        if (code) {
          this.vastFail(ad, res, code);
          opts.onError?.('no_fill');
          return;
        }
        ext = res;
      }
      await this.present(format, ad, opts, ext);
    } catch (e) {
      opts.onError?.(e instanceof Error ? e.message : 'error');
    } finally {
      this.busy = false;
    }
  }

  private async fetchAd(format: string, opts: ShowOptions): Promise<AdResponse | null> {
    const q = new URLSearchParams({
      tag: opts.tag,
      format,
      client: this.client,
      uid: opts.uid || this.uid,
      // Wrapper creatives (third-party VAST tags) are resolvable client-side.
      vast: '1',
    });
    if (this.consent?.gdpr) q.set('gdpr_consent', this.consent.gdpr);
    if (this.consent?.usPrivacy) q.set('us_privacy', this.consent.usPrivacy);
    const res = await fetch(`${this.base}/game/ad?${q.toString()}`, { credentials: 'omit' });
    if (res.status === 204 || !res.ok) return null;
    const ad = (await res.json()) as AdResponse;
    return ad && ad.creative ? ad : null;
  }

  // present builds the full-screen overlay, plays the creative, fires the
  // impression once it's on screen, wires the click, and resolves after the ad
  // closes. Rewarded gates the close on completion and verifies the reward.
  // vastFail reports a VAST resolution/playback failure: the chain's <Error>
  // URLs with [ERRORCODE] + OUR tracking-only error beacon (never billing).
  private vastFail(ad: AdResponse, res: VastResult, code: number): void {
    new VastTracker(res).error(code);
    pixel(`${this.base}${ad.imp_url}&ev=error&code=${code}`);
  }

  private present(format: string, ad: AdResponse, opts: ShowOptions, ext?: VastResult): Promise<void> {
    injectStyles();
    return new Promise<void>((resolve) => {
      const cr = ad.creative;
      const mediaUrl = ext?.media?.url || cr.asset_url || '';
      const isVideo = (cr.type || '').toLowerCase() === 'video' && !!mediaUrl;
      const vt = ext ? new VastTracker(ext) : null;
      const isPlayable = (cr.type || '').toLowerCase() === 'html5' && /^https?:\/\//.test(cr.asset_url || '');
      const rewarded = format === 'rewarded';

      // Playable (interactive HTML5): mount the sandboxed unit + bridge and skip
      // the media/countdown path entirely. Same trust model as the web SDK — the
      // frame is origin-"null" and only its own window's messages are honored.
      if (isPlayable) {
        this.presentPlayable(ad, rewarded, opts, resolve);
        return;
      }

      const ov = document.createElement('div');
      ov.className = 'adv-g-ov';

      const label = document.createElement('span');
      label.className = 'adv-g-label';
      label.textContent = 'Ad';
      ov.appendChild(label);

      const timer = document.createElement('div');
      timer.className = 'adv-g-timer';
      ov.appendChild(timer);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'adv-g-close';
      closeBtn.setAttribute('aria-label', 'Close ad');
      closeBtn.textContent = '×';
      ov.appendChild(closeBtn);

      let impFired = false;
      const fireImp = () => {
        if (impFired) return;
        impFired = true;
        try {
          navigator.sendBeacon?.(`${this.base}${ad.imp_url}`);
        } catch {
          /* best effort */
        }
      };

      const openClick = () => {
        // VAST: open the advertiser's ClickThrough and record OUR click via
        // /click?track=1 (pixel, no redirect) + the chain's ClickTracking.
        const viaVast = !!(vt && ext && ext.clickThrough);
        if (viaVast) {
          pixel(`${this.base}${ad.click_url}&track=1`);
          vt?.clicked();
        }
        try {
          window.open(viaVast ? ext!.clickThrough : `${this.base}${ad.click_url}`, '_blank', 'noopener');
        } catch {
          /* pop-up blocked — ignore */
        }
      };

      let completed = false;
      let done = false;
      const teardown = () => {
        if (done) return;
        done = true;
        ov.remove();
      };

      // reward + close bookkeeping shared by both media paths.
      const finishClose = () => {
        teardown();
        opts.onClose?.();
        resolve();
      };
      const grantIfEarned = async () => {
        if (rewarded && completed && ad.reward_url) {
          const ok = await this.confirmReward(ad.reward_url);
          if (ok) opts.onReward?.();
          else opts.onError?.('reward_unverified');
        }
      };
      closeBtn.addEventListener('click', async () => {
        if (vt) {
          if (!completed) vt.fire('skip');
          vt.fire('closeLinear');
        }
        await grantIfEarned();
        finishClose();
      });

      // The duration that must elapse before the player may close. For video we
      // prefer the media's own end; this is the fallback / interstitial skip.
      // VAST: interstitials honour the tag's skipoffset (absent = not
      // skippable before the media ends); duration falls back to <Duration>.
      const dur = cr.duration || ext?.duration || 0;
      let skipAfter = rewarded
        ? Math.max(1, dur || (isVideo ? 15 : 5))
        : Math.max(1, cr.skip_offset_sec || 5);
      if (ext && !rewarded) skipAfter = Math.max(1, ext.skipOffset >= 0 ? ext.skipOffset : dur || 15);

      let media: HTMLVideoElement | HTMLImageElement;
      if (isVideo) {
        const v = document.createElement('video');
        v.className = 'adv-g-media';
        v.src = mediaUrl;
        v.autoplay = true;
        v.muted = true; // required for autoplay; player can unmute via controls
        (v as HTMLVideoElement).playsInline = true;
        v.addEventListener('loadeddata', fireImp);
        v.addEventListener('ended', () => {
          completed = true;
          markClosable();
        });
        v.addEventListener('click', openClick);
        if (vt) this.trackVideo(v, vt, ad, ext as VastResult, () => {
          // Media failed: error beacons, tear down, no-fill — never a reward.
          clearInterval(iv);
          teardown();
          opts.onError?.('no_fill');
          resolve();
        });
        v.play?.().catch(() => fireImp());
        media = v;
      } else {
        const img = document.createElement('img');
        img.className = 'adv-g-media';
        img.src = (cr.main_image_url || cr.asset_url) as string;
        img.alt = cr.title || 'Advertisement';
        img.addEventListener('load', fireImp);
        img.addEventListener('click', openClick);
        media = img;
        // Static creatives can't "end" — they complete when the timer elapses.
      }
      ov.appendChild(media);

      if (cr.cta) {
        const cta = document.createElement('a');
        cta.className = 'adv-g-cta';
        cta.textContent = cr.cta;
        cta.href = 'javascript:void(0)';
        cta.addEventListener('click', openClick);
        ov.appendChild(cta);
      }

      // Countdown → unlock close. Video also unlocks on natural end (above).
      let remaining = skipAfter;
      const markClosable = () => {
        timer.style.display = 'none';
        closeBtn.classList.add('show');
      };
      timer.textContent = String(remaining);
      const iv = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(iv);
          if (!isVideo) completed = true; // static reward earns on dwell
          markClosable();
        } else {
          timer.textContent = String(remaining);
        }
      }, 1000);

      document.body.appendChild(ov);
      // Image with cache hit may not fire load — ensure the impression lands.
      if (!isVideo) setTimeout(fireImp, 300);
    });
  }

  // trackVideo wires the third-party VAST tracking onto the <video> element
  // (our own impression/click beacons are unchanged) and reports media errors.
  private trackVideo(v: HTMLVideoElement, vt: VastTracker, ad: AdResponse, ext: VastResult, onFail: () => void): void {
    let started = false;
    let failed = false;
    v.addEventListener('playing', () => {
      if (!started) {
        started = true;
        vt.started();
      } else vt.fire('resume', false);
    });
    v.addEventListener('timeupdate', () => vt.progress(v.currentTime, v.duration));
    v.addEventListener('ended', () => vt.fire('complete'));
    v.addEventListener('pause', () => {
      if (!v.ended) vt.fire('pause', false);
    });
    v.addEventListener('volumechange', () => vt.fire(v.muted ? 'mute' : 'unmute', false));
    v.addEventListener('error', () => {
      if (failed) return;
      failed = true;
      const code = started ? VastError.MEDIA_PLAY : VastError.MEDIA_NOT_FOUND;
      this.vastFail(ad, ext, code);
      onFail();
    });
  }

  // presentPlayable mounts an interactive HTML5 unit in a locked-down iframe.
  // The bundle's injected runtime posts {__advPlayable} messages; we honor them
  // ONLY from this frame's own window (the sandbox makes the origin "null", so
  // window identity is the trust check) and map ready→impression, click→open,
  // finish→completed (rewarded), close→dismiss.
  private presentPlayable(
    ad: AdResponse,
    rewarded: boolean,
    opts: ShowOptions,
    resolve: () => void,
  ): void {
    const ov = document.createElement('div');
    ov.className = 'adv-g-ov';

    const label = document.createElement('span');
    label.className = 'adv-g-label';
    label.textContent = 'Ad';
    ov.appendChild(label);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'adv-g-close show';
    closeBtn.setAttribute('aria-label', 'Close ad');
    closeBtn.textContent = '×';
    ov.appendChild(closeBtn);

    const frame = document.createElement('iframe');
    frame.className = 'adv-g-media';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', 'autoplay; fullscreen');
    frame.style.cssText = 'border:0;width:100%;height:100%;background:#000';
    frame.src = ad.creative.asset_url as string;
    ov.appendChild(frame);

    let impFired = false;
    let completed = false;
    let done = false;
    const teardown = () => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      ov.remove();
    };
    const finishClose = async () => {
      if (rewarded && completed && ad.reward_url) {
        const ok = await this.confirmReward(ad.reward_url);
        if (ok) opts.onReward?.();
        else opts.onError?.('reward_unverified');
      }
      teardown();
      opts.onClose?.();
      resolve();
    };

    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return; // trust only this frame
      const d = e.data as { __advPlayable?: number; type?: string } | null;
      if (!d || d.__advPlayable !== 1) return;
      if (d.type === 'ready' && !impFired) {
        impFired = true;
        try {
          navigator.sendBeacon?.(`${this.base}${ad.imp_url}`);
        } catch {
          /* best effort */
        }
      } else if (d.type === 'click') {
        try {
          window.open(`${this.base}${ad.click_url}`, '_blank', 'noopener');
        } catch {
          /* blocked */
        }
      } else if (d.type === 'finish') {
        completed = true;
      } else if (d.type === 'close') {
        void finishClose();
      }
    };
    window.addEventListener('message', onMsg);
    closeBtn.addEventListener('click', () => void finishClose());
    document.body.appendChild(ov);
  }

  // confirmReward calls the signed reward_url and grants only on rewarded:true.
  // The signature + single-use enforcement live in the engine (/game/reward).
  private async confirmReward(rewardUrl: string): Promise<boolean> {
    try {
      const res = await fetch(rewardUrl, { credentials: 'omit' });
      if (!res.ok) return false;
      const j = (await res.json()) as { rewarded?: boolean };
      return j.rewarded === true;
    } catch {
      return false;
    }
  }
}

export default AdviverseGames;

// Attach a browser global for plain <script> use (non-module game builds).
if (typeof window !== 'undefined') {
  (window as unknown as { AdviverseGames?: typeof AdviverseGames }).AdviverseGames = AdviverseGames;
}
