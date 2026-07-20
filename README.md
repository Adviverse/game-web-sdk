# @adviverse/games

Rewarded + interstitial ads for **HTML5 / web games**. Adviverse serves the ads
itself — you do **not** need a GameDistribution / CrazyGames / Poki relationship;
Adviverse *is* the network. The reward is gated on a signed, single-use
server-verified callback, so you only grant currency for a real, completed view.

Works in any browser game: vanilla canvas, Phaser, PixiJS, Construct, or a
Unity/Godot **WebGL** export via their JS bridges.

## Install

```sh
npm install @adviverse/games
```

…or drop the built file in with a `<script>` tag and use the `AdviverseGames`
global.

## Use

```js
import { AdviverseGames } from '@adviverse/games';

const ads = new AdviverseGames({ client: 'my-game' });   // base defaults to serve.adviverse.com

// Rewarded — onReward fires ONLY after a completed + verified view
document.getElementById('free-coins').onclick = () => {
  ads.showRewarded({
    tag: 'game-rewarded',
    onReward: () => player.addCoins(50),
    onClose:  () => resumeGame(),
    onError:  (why) => console.log('no ad:', why),   // e.g. "no_fill"
  });
};

// Interstitial — skippable after a few seconds
function onLevelComplete() {
  ads.showInterstitial({ tag: 'game-interstitial', onClose: nextLevel });
}
```

## What it does

1. Fetches a full-screen ad from `GET /game/ad?tag=…&format=rewarded|interstitial`.
2. Plays it over your canvas (HTML5 `<video>` for video creatives, `<img>` for
   display), with an **Ad** disclosure label and a skip/close countdown.
3. Fires the impression when the ad is on screen; a tap opens the advertiser's
   page in a new tab.
4. **Rewarded:** on completion, calls the signed `reward_url`; your `onReward`
   runs only if the engine returns `rewarded: true` (HMAC-verified, single-use).

## Config

| Field | Purpose |
| --- | --- |
| `base` | Serve host (default `https://serve.adviverse.com`) |
| `client` | Label for reporting/integrity (default `game-web`) |
| `uid` | Stable per-player id — auto-generated + persisted to `localStorage` if omitted |
| `consent` | `{ gdpr?, usPrivacy? }` forwarded to serving |

## Doing it right

- **One ad at a time** — the SDK refuses a second overlay (returns `onError('busy')`).
- **Disclosure** — the **Ad** label is always shown; required by ad policies.
- **Reward integrity** — never grant on `onClose` alone. The signed callback is
  the trust anchor; for hardened server-side verification, have *your* server
  call the `reward_url` and grant on `rewarded: true`.
