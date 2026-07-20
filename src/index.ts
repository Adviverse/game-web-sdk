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
      await this.present(format, ad, opts);
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
  private present(format: string, ad: AdResponse, opts: ShowOptions): Promise<void> {
    injectStyles();
    return new Promise<void>((resolve) => {
      const cr = ad.creative;
      const isVideo = (cr.type || '').toLowerCase() === 'video' && !!cr.asset_url;
      const rewarded = format === 'rewarded';

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
        try {
          window.open(`${this.base}${ad.click_url}`, '_blank', 'noopener');
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
        await grantIfEarned();
        finishClose();
      });

      // The duration that must elapse before the player may close. For video we
      // prefer the media's own end; this is the fallback / interstitial skip.
      const skipAfter = rewarded
        ? Math.max(1, cr.duration || (isVideo ? 15 : 5))
        : Math.max(1, cr.skip_offset_sec || 5);

      let media: HTMLVideoElement | HTMLImageElement;
      if (isVideo) {
        const v = document.createElement('video');
        v.className = 'adv-g-media';
        v.src = cr.asset_url as string;
        v.autoplay = true;
        v.muted = true; // required for autoplay; player can unmute via controls
        (v as HTMLVideoElement).playsInline = true;
        v.addEventListener('loadeddata', fireImp);
        v.addEventListener('ended', () => {
          completed = true;
          markClosable();
        });
        v.addEventListener('click', openClick);
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
