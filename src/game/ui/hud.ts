/**
 * In-game HUD (DOM overlay inside #ui): compass tape with objective markers,
 * world-space waypoint markers, objective text and relay tally, crosshair
 * sized from weapon spread, hitmarkers, damage direction arcs, interact
 * prompt, kill feed, warnings / messages, vitals, ammo and the typed-out
 * radio "comms" line. All DOM writes are cached to avoid layout churn.
 */
import { Vector3 } from 'three';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import type { Game } from '../core/types';

const COMPASS_PX_PER_DEG = 4;
const COMPASS_TAPE_MIN_DEG = -90;
const COMPASS_TAPE_MAX_DEG = 450;
const COMPASS_LABELS: Record<number, string> = {
  0: 'N',
  45: 'NE',
  90: 'E',
  135: 'SE',
  180: 'S',
  225: 'SW',
  270: 'W',
  315: 'NW'
};
const PROMPT_RING_CIRCUMFERENCE = 2 * Math.PI * 19;

/** Creates an element with an optional class name and inner HTML. */
function createEl(tag: string, className?: string, html?: string | null): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (html != null) el.innerHTML = html;
  return el;
}

/**
 * Appends `children` in order. (Same as `parent.append(...children)`, which
 * the Cloudflare worker typings shadow with HTMLRewriter's `Element.append`.)
 */
function appendAll(parent: HTMLElement, ...children: HTMLElement[]): void {
  for (const child of children) parent.appendChild(child);
}

/** Hitmarker flavour. */
export type HitmarkerKind = 'hit' | 'weak' | 'kill';

/** An objective marker shown on the compass and in the world. */
export interface HudMarker {
  id?: string;
  short?: string;
  label?: string;
  pos: Vector3;
  kind?: string;
}

/** A kill-feed line. */
export interface HudFeedLine {
  el: HTMLElement;
  life: number;
  weak: boolean;
  out?: boolean;
}

/**
 * The HUD (`game.hud`). Optional members are absent on the stub HUD used in
 * showcase mode or when the HUD fails to boot.
 */
export interface Hud {
  stub?: boolean;
  root?: HTMLElement;
  show(on: boolean): void;
  setObjective(text: string): void;
  /** Replaces the "Relays" label (holdout wave / score); null restores it. */
  setTally?(text: string | null): void;
  setRelays?(done: number, total: number): void;
  setMarkers?(markers: HudMarker[] | null): void;
  /** Shows the hold-to-interact prompt with a 0..1 progress ring; null hides it. */
  setPrompt?(text: string | null, progress?: number): void;
  /** Queues a radio line, typed out in the comms box. */
  radio?(text: string, secs?: number): void;
  clearRadio?(): void;
  warn?(text: string, secs?: number): void;
  message(text: string, secs?: number): void;
  feed?(html: string): HudFeedLine;
  hitmarker(kind?: HitmarkerKind): void;
  reset?(): void;
  update(dt: number): void;
}

/** Weapon fields the HUD reads (all optional so a stub or missing weapon works). */
interface HudWeaponView {
  state?: string;
  spread?: number;
  magSize?: number;
  ammo?: number;
  reserve?: number;
  name?: string;
  current?: string;
  slots?: { id?: string; name?: string; ammo?: number; reserve?: number }[];
}

interface DamageArc {
  el: HTMLElement;
  life: number;
  max?: number;
  src: Vector3;
  op: number;
  rot: number;
}

interface MarkerView extends HudMarker {
  cEl: HTMLElement;
  wEl: HTMLElement;
  cDist: HTMLElement;
  wDist: HTMLElement;
  lastD: number;
  lastC: number;
  lastW: string;
  vis: null;
}

interface RadioLine {
  text: string;
  secs: number;
}

/** Last values written to the DOM. */
interface HudCache {
  ammo: number;
  mag: number;
  reserve: number;
  name: string | null | undefined;
  cue: string | null;
  low: boolean | null;
  hp: number;
  hpSeg: number;
  hurt: boolean | null;
  head: number;
  tapeX: number;
  gap: number;
  crossOn: boolean | null;
  promptOn: boolean | null;
  promptText: string | null;
  promptT: number;
  promptKey: string | null;
  marksOn: boolean | null;
  done: number;
  total: number;
  alt?: string;
}

interface HitEnemyEvent {
  killed?: boolean;
  weak?: boolean;
  part?: string;
  enemy?: { type?: string };
}

interface EnemyKilledEvent {
  type?: string;
  enemy?: { type?: string };
  /** Display name (defaults to the capitalised type). */
  label?: string;
  /** Kill verb (defaults to "destroyed"). */
  verb?: string;
}

interface EnemySupportEvent {
  type?: string;
}

interface PlayerHitEvent {
  fromPos?: Vector3 | null;
}

const ENEMY_NAME_KEYS: Record<string, MessageKey> = {
  gull: 'enemy.gull',
  hound: 'enemy.hound',
  guard: 'enemy.guard',
  machine: 'enemy.machine'
};

/** Translated display name of an enemy type (falls back to the event label). */
function enemyName(type: string, label?: string): string {
  const key = ENEMY_NAME_KEYS[type];
  if (key) return t(key);
  return label || type.charAt(0).toUpperCase() + type.slice(1);
}

/** Builds the HUD DOM inside #ui and returns its controller. */
export function createHud(game: Game): Hud {
  const uiRoot = document.getElementById('ui')!;
  const root = createEl('div', 'hud');
  root.setAttribute('aria-hidden', 'true');

  // Compass: a long tape of ticks / labels that slides under a fixed needle.
  const compass = createEl('div', 'h-compass');
  const tape = createEl('div', 'h-tape');
  let tapeHtml = '';
  for (let deg = COMPASS_TAPE_MIN_DEG; deg <= COMPASS_TAPE_MAX_DEG; deg += 5) {
    const x = (deg - COMPASS_TAPE_MIN_DEG) * COMPASS_PX_PER_DEG;
    const norm = ((deg % 360) + 360) % 360;
    const major = norm % 45 === 0;
    const mid = norm % 15 === 0;
    tapeHtml += `<i class="${major ? 'mj' : mid ? 'md' : 'mn'}" style="left:${x}px"></i>`;
    if (major) {
      tapeHtml += `<b class="${norm % 90 === 0 ? 'card' : 'ic'}" style="left:${x}px">${COMPASS_LABELS[norm]}</b>`;
    } else if (norm % 15 === 0) {
      tapeHtml += `<b class="num" style="left:${x}px">${String(norm).padStart(3, '0')}</b>`;
    }
  }
  tape.innerHTML = tapeHtml;
  const tapeWrap = createEl('div', 'h-tape-wrap');
  tapeWrap.appendChild(tape);
  const compassMarks = createEl('div', 'h-cmarks');
  const headingEl = createEl('div', 'h-heading', '000');
  appendAll(compass, tapeWrap, createEl('i', 'h-needle'), compassMarks, headingEl);

  const objectiveEl = createEl(
    'div',
    'h-obj',
    `<div class="h-k">${t('hud.objective')}</div><div class="h-obj-t"></div><div class="h-relays"><span>${t('hud.relays')}</span><i></i><i></i><i></i><b>0/3</b></div>`
  );
  const objectiveText = objectiveEl.querySelector<HTMLElement>('.h-obj-t')!;
  const relaysEl = objectiveEl.querySelector<HTMLElement>('.h-relays')!;
  const relaysCount = relaysEl.querySelector<HTMLElement>('b')!;
  const relaysLabel = relaysEl.querySelector<HTMLElement>('span')!;
  let relayPips = [...relaysEl.querySelectorAll<HTMLElement>('i')];
  const warnEl = createEl('div', 'h-warn');
  const crosshair = createEl(
    'div',
    'h-cross',
    '<i class="c-t"></i><i class="c-b"></i><i class="c-l"></i><i class="c-r"></i><i class="c-dot"></i>'
  );
  const crossLines = crosshair.querySelectorAll<HTMLElement>('i');
  const hitEl = createEl('div', 'h-hit', '<i></i><i></i><i></i><i></i>');
  const arcsEl = createEl('div', 'h-arcs');
  const arcs: DamageArc[] = [];
  for (let i = 0; i < 4; i++) {
    const el = createEl(
      'div',
      'h-arc',
      '<svg viewBox="-100 -100 200 200"><path d="M -38 -84 A 92 92 0 0 1 38 -84" /><path class="tip" d="M -7 -97 L 0 -106 L 7 -97" /></svg>'
    );
    arcsEl.appendChild(el);
    arcs.push({
      el,
      life: 0,
      src: new Vector3(),
      op: -1,
      rot: 1e9
    });
  }
  const promptEl = createEl(
    'div',
    'h-prompt',
    `<svg viewBox="-24 -24 48 48"><circle class="bg" r="19"/><circle class="fg" r="19" stroke-dasharray="${PROMPT_RING_CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${PROMPT_RING_CIRCUMFERENCE.toFixed(2)}" transform="rotate(-90)"/></svg><span class="h-key">E</span><span class="h-plabel"></span>`
  );
  const promptRing = promptEl.querySelector('.fg')!;
  const promptKeyEl = promptEl.querySelector<HTMLElement>('.h-key')!;
  const promptLabel = promptEl.querySelector<HTMLElement>('.h-plabel')!;
  const feedEl = createEl('div', 'h-feed');
  const messageEl = createEl('div', 'h-msg');
  const healthEl = createEl(
    'div',
    'h-health',
    '<div class="h-k">Vitals</div><div class="h-hp-row"><b class="h-hp-n">100</b><div class="h-hp-bar">' +
      '<i></i>'.repeat(10) +
      '</div></div>'
  );
  const hpNumber = healthEl.querySelector<HTMLElement>('.h-hp-n')!;
  const hpSegments = [...healthEl.querySelectorAll<HTMLElement>('.h-hp-bar i')];
  const ammoEl = createEl(
    'div',
    'h-ammo',
    '<div class="h-cue"></div><div class="h-ammo-row"><b class="h-ammo-n">30</b><span class="h-ammo-r">120</span></div><div class="h-pips"></div><div class="h-wname"></div><div class="h-alt"></div>'
  );
  const ammoNumber = ammoEl.querySelector<HTMLElement>('.h-ammo-n')!;
  const reserveEl = ammoEl.querySelector<HTMLElement>('.h-ammo-r')!;
  const pipsEl = ammoEl.querySelector<HTMLElement>('.h-pips')!;
  const weaponNameEl = ammoEl.querySelector<HTMLElement>('.h-wname')!;
  const cueEl = ammoEl.querySelector<HTMLElement>('.h-cue')!;
  const altWeaponEl = ammoEl.querySelector<HTMLElement>('.h-alt')!;
  const worldMarksEl = createEl('div', 'h-marks');
  appendAll(
    root,
    worldMarksEl,
    compass,
    objectiveEl,
    warnEl,
    arcsEl,
    crosshair,
    hitEl,
    promptEl,
    feedEl,
    messageEl,
    healthEl,
    ammoEl
  );
  uiRoot.appendChild(root);
  const comms = createEl(
    'div',
    'comms',
    '<span class="comms-who">Control</span><span class="comms-t"></span>'
  );
  comms.setAttribute('role', 'status');
  comms.setAttribute('aria-live', 'polite');
  const commsText = comms.querySelector<HTMLElement>('.comms-t')!;
  uiRoot.appendChild(comms);

  let visible = false;
  let compassWidth = 420;
  let viewWidth = innerWidth;
  let viewHeight = innerHeight;
  const cache: HudCache = {
    ammo: -1,
    mag: -1,
    reserve: -1,
    name: null,
    cue: null,
    low: null,
    hp: -1,
    hpSeg: -1,
    hurt: null,
    head: -1,
    tapeX: 1e9,
    gap: -1,
    crossOn: null,
    promptOn: null,
    promptText: null,
    promptT: -1,
    promptKey: null,
    marksOn: null,
    done: -1,
    total: -1
  };
  let ammoPips: Element[] = [];
  let objective = '';
  let objectiveShown = 0;
  let objectiveTyped = 0;
  const radioQueue: RadioLine[] = [];
  let radioLine: RadioLine | null = null;
  let radioShown = 0;
  let radioTyped = 0;
  let radioHold = 0;
  let warnTimer = 0;
  let messageTimer = 0;
  const feedLines: HudFeedLine[] = [];
  let markers: MarkerView[] = [];
  const projected = new Vector3();
  let lastKillLine: HudFeedLine | null = null;
  let lastKillFrame = -1;

  function onResize(): void {
    viewWidth = innerWidth;
    viewHeight = innerHeight;
    compassWidth = compass.clientWidth || Math.min(420, viewWidth * 0.6);
    cache.tapeX = 1e9;
    cache.gap = -1;
    for (const marker of markers) {
      marker.lastC = 1e9;
      marker.lastW = '';
    }
  }
  addEventListener('resize', onResize);
  game.events.on('player:hitEnemy', (event: HitEnemyEvent | null) => {
    hud.hitmarker(
      event && event.killed
        ? 'kill'
        : event && (event.weak || event.part === 'weak')
          ? 'weak'
          : 'hit'
    );
    // Tag the kill-feed line of this frame's kill as a weak-point kill.
    if (
      event &&
      event.killed &&
      event.weak &&
      lastKillLine &&
      lastKillFrame === game.time.frame &&
      !lastKillLine.weak
    ) {
      lastKillLine.weak = true;
      const human = !!(event.enemy && event.enemy.type === 'guard');
      lastKillLine.el.innerHTML += `<em>${human ? t('hud.headshot') : t('hud.weakPoint')}</em>`;
    }
  });
  game.events.on('enemy:killed', (event: EnemyKilledEvent | null) => {
    const type = String(
      (event && (event.type || (event.enemy && event.enemy.type))) || 'machine'
    );
    const name = enemyName(type, (event && event.label) || undefined);
    const down = !!(event && event.verb === 'down');
    lastKillLine = hud.feed(t(down ? 'feed.down' : 'feed.destroyed', { name }));
    lastKillFrame = game.time.frame;
  });
  game.events.on('enemy:support', (event: EnemySupportEvent | null) => {
    if (event && event.type === 'guard') hud.feed(t('feed.backup', { name: t('enemy.guard') }));
  });
  game.events.on('player:hit', (event: PlayerHitEvent | null) => {
    if (!event || !event.fromPos) return;
    // Reuse a free arc, else the one closest to fading out.
    let arc = arcs[0];
    for (const candidate of arcs) {
      if (candidate.life <= 0) {
        arc = candidate;
        break;
      }
      if (candidate.life < arc.life) arc = candidate;
    }
    arc.src.copy(event.fromPos);
    arc.life = 1.5;
    arc.max = 1.5;
  });

  const hud: Required<Omit<Hud, 'stub'>> = {
    root,
    show(on) {
      on = !!on;
      if (on !== visible) {
        visible = on;
        root.classList.toggle('on', on);
        if (on) onResize();
      }
    },
    setObjective(text) {
      text = text || '';
      if (text !== objective) {
        objective = text;
        objectiveShown = 0;
        objectiveTyped = 0;
        objectiveText.textContent = '';
        objectiveEl.classList.toggle('has', !!text);
        // Restart the flash animation (reading offsetWidth forces a reflow).
        objectiveEl.classList.remove('flash');
        void objectiveEl.offsetWidth;
        objectiveEl.classList.add('flash');
      }
    },
    setTally(text) {
      const on = text != null;
      relaysEl.classList.toggle('tally', on);
      relaysLabel.textContent = on ? text : t('hud.relays');
    },
    setRelays(done, total) {
      if (done === cache.done && total === cache.total) return;
      if (total !== cache.total) {
        relayPips.forEach((pip) => pip.remove());
        relayPips = [];
        for (let i = 0; i < total; i++) {
          const pip = document.createElement('i');
          relaysEl.insertBefore(pip, relaysCount);
          relayPips.push(pip);
        }
      }
      cache.done = done;
      cache.total = total;
      relayPips.forEach((pip, index) => pip.classList.toggle('cut', index < done));
      relaysCount.textContent = `${done}/${total}`;
      relaysEl.classList.toggle('all', done >= total && total > 0);
    },
    setMarkers(list) {
      for (const marker of markers) {
        marker.cEl.remove();
        marker.wEl.remove();
      }
      markers = (list || []).map((marker) => {
        const compassEl = createEl(
          'div',
          'h-cm ' + (marker.kind || 'relay'),
          `<i></i><b>${marker.short || ''}</b><span></span>`
        );
        const worldEl = createEl(
          'div',
          'h-wm ' + (marker.kind || 'relay'),
          `<i></i><b>${marker.short || ''}</b><span></span>`
        );
        compassMarks.appendChild(compassEl);
        worldMarksEl.appendChild(worldEl);
        return {
          ...marker,
          cEl: compassEl,
          wEl: worldEl,
          cDist: compassEl.querySelector<HTMLElement>('span')!,
          wDist: worldEl.querySelector<HTMLElement>('span')!,
          lastD: -1,
          lastC: 1e9,
          lastW: '',
          vis: null
        };
      });
    },
    setPrompt(text, progress = 0) {
      const on = !!text;
      if (on !== cache.promptOn) {
        cache.promptOn = on;
        promptEl.classList.toggle('on', on);
        if (game.input.setPrompt) game.input.setPrompt(on);
      }
      if (!on) return;
      const key = game.input.touch ? t('t.use') : game.input.device === 'pad' ? 'X' : 'E';
      if (key !== cache.promptKey) {
        cache.promptKey = key;
        promptKeyEl.textContent = key;
        promptKeyEl.classList.toggle('wide', key.length > 1);
      }
      const label = t('prompt.hold', { key, text });
      if (label !== cache.promptText) {
        cache.promptText = label;
        promptLabel.textContent = label;
      }
      const step = Math.round(progress * 200) / 200;
      if (step !== cache.promptT) {
        cache.promptT = step;
        promptRing.setAttribute(
          'stroke-dashoffset',
          (PROMPT_RING_CIRCUMFERENCE * (1 - step)).toFixed(2)
        );
        promptEl.classList.toggle('busy', step > 0);
      }
    },
    radio(text, secs = 4.5) {
      if (text) {
        radioQueue.push({
          text,
          secs
        });
      }
    },
    clearRadio() {
      radioQueue.length = 0;
      radioLine = null;
      comms.classList.remove('on');
    },
    warn(text, secs = 3) {
      warnEl.textContent = text;
      warnTimer = secs;
      // Restart the CSS animation.
      warnEl.classList.remove('on');
      void warnEl.offsetWidth;
      warnEl.classList.add('on');
    },
    message(text, secs = 3) {
      messageEl.textContent = text || '';
      messageTimer = text ? secs : 0;
      messageEl.classList.toggle('on', !!text);
    },
    feed(html) {
      const el = createEl('div', 'h-fl', html);
      feedEl.appendChild(el);
      const line: HudFeedLine = {
        el,
        life: 4.2,
        weak: false
      };
      for (feedLines.push(line); feedLines.length > 4;) feedLines.shift()!.el.remove();
      return line;
    },
    hitmarker(kind = 'hit') {
      hitEl.className = 'h-hit ' + kind;
      const scale = kind === 'weak' || kind === 'kill' ? 1.5 : 1.15;
      try {
        hitEl.animate(
          [
            {
              opacity: 1,
              transform: `translate(-50%,-50%) scale(${scale})`
            },
            {
              opacity: 1,
              transform: 'translate(-50%,-50%) scale(1)',
              offset: 0.35
            },
            {
              opacity: 0,
              transform: 'translate(-50%,-50%) scale(0.92)'
            }
          ],
          {
            duration: kind === 'kill' ? 420 : 240,
            easing: 'ease-out'
          }
        );
      } catch {}
    },
    reset() {
      radioQueue.length = 0;
      radioLine = null;
      comms.classList.remove('on');
      for (const line of feedLines) line.el.remove();
      feedLines.length = 0;
      for (const arc of arcs) arc.life = 0;
      warnTimer = 0;
      warnEl.classList.remove('on');
      hud.message('');
      hud.setPrompt(null);
      hud.setObjective('');
      cache.hp = -1;
    },
    update
  };

  function update(dt: number): void {
    updateRadio(dt);
    if (!visible) return;
    const player = game.player;
    const weapon: HudWeaponView = game.weapon || {};
    const camera = game.camera;
    const ads = player.ads || 0;
    let heading = ((-player.yaw * 180) / Math.PI) % 360;
    if (heading < 0) heading += 360;

    // Compass tape + heading readout.
    const tapeX =
      Math.round((compassWidth / 2 - (heading - COMPASS_TAPE_MIN_DEG) * COMPASS_PX_PER_DEG) * 2) /
      2;
    if (tapeX !== cache.tapeX) {
      cache.tapeX = tapeX;
      tape.style.transform = `translate3d(${tapeX}px,0,0)`;
    }
    const headingInt = Math.round(heading) % 360;
    if (headingInt !== cache.head) {
      cache.head = headingInt;
      headingEl.textContent = String(headingInt).padStart(3, '0');
    }

    // Objective markers on the compass and in the world (hidden while aiming).
    const marksOn = ads < 0.5;
    if (marksOn !== cache.marksOn) {
      cache.marksOn = marksOn;
      worldMarksEl.classList.toggle('off', !marksOn);
    }
    if (markers.length) {
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      const compassEdge = compassWidth / 2 - 14;
      for (const marker of markers) {
        const dx = marker.pos.x - player.pos.x;
        const dz = marker.pos.z - player.pos.z;
        const dist = Math.round(Math.hypot(dx, dz));
        if (dist !== marker.lastD) {
          marker.lastD = dist;
          const distText = dist + 'm';
          marker.cDist.textContent = distText;
          marker.wDist.textContent = distText;
        }
        let relDeg = (Math.atan2(dx, -dz) * 180) / Math.PI - heading;
        relDeg = ((relDeg + 540) % 360) - 180;
        const compassX = Math.round(
          Math.max(-compassEdge, Math.min(compassEdge, relDeg * COMPASS_PX_PER_DEG))
        );
        if (compassX !== marker.lastC) {
          marker.lastC = compassX;
          marker.cEl.style.transform = `translate3d(${compassX}px,0,0)`;
          marker.cEl.classList.toggle('edge', Math.abs(compassX) >= compassEdge);
        }
        projected
          .set(marker.pos.x, marker.pos.y + (marker.kind === 'extract' ? 1.2 : 1.9), marker.pos.z)
          .project(camera);
        // Behind the camera or off screen: clamp to the screen border.
        let offscreen = false;
        if (projected.z > 1) {
          offscreen = true;
          projected.x = -projected.x;
          projected.y = -projected.y;
        }
        if (offscreen || Math.abs(projected.x) > 0.9 || Math.abs(projected.y) > 0.82) {
          offscreen = true;
          const scale = Math.max(Math.abs(projected.x) / 0.9, Math.abs(projected.y) / 0.82, 0.001);
          projected.x /= scale;
          projected.y /= scale;
          if (projected.z > 1) {
            const edgeScale = Math.max(Math.abs(projected.x) / 0.9, Math.abs(projected.y) / 0.82);
            if (edgeScale < 0.999) {
              projected.x /= edgeScale;
              projected.y /= edgeScale;
            }
          }
        }
        const screenX = Math.round((projected.x * 0.5 + 0.5) * viewWidth);
        const screenY = Math.round((-projected.y * 0.5 + 0.5) * viewHeight);
        const dim = !offscreen && Math.hypot(projected.x, projected.y * 0.6) < 0.16;
        const stateKey =
          screenX +
          ',' +
          screenY +
          (offscreen ? 'o' : '') +
          (dist < 3 ? 'n' : '') +
          (dim ? 'd' : '');
        if (stateKey !== marker.lastW) {
          marker.lastW = stateKey;
          marker.wEl.style.transform = `translate3d(${screenX}px,${screenY}px,0)`;
          marker.wEl.classList.toggle('offscreen', offscreen);
          marker.wEl.classList.toggle('near', dist < 3);
          marker.wEl.classList.toggle('dim', dim);
        }
      }
    }

    // Crosshair: gap follows the weapon's angular spread.
    const crossOn = ads <= 0.6 && player.alive && weapon.state !== 'reloading_hidden';
    if (crossOn !== cache.crossOn) {
      cache.crossOn = crossOn;
      crosshair.classList.toggle('off', !crossOn);
    }
    if (crossOn) {
      const spread = typeof weapon.spread == 'number' ? weapon.spread : 0.012;
      const halfFov = (camera.fov * Math.PI) / 360;
      let gap =
        (Math.tan(spread) / Math.tan(halfFov)) * (viewHeight / 2) + 4 + (player.sprinting ? 10 : 0);
      gap = Math.round(Math.max(4, Math.min(70, gap)) * 2) / 2;
      if (gap !== cache.gap) {
        cache.gap = gap;
        crossLines[0].style.transform = `translate3d(-50%,${-gap}px,0) translateY(-100%)`;
        crossLines[1].style.transform = `translate3d(-50%,${gap}px,0)`;
        crossLines[2].style.transform = `translate3d(${-gap}px,-50%,0) translateX(-100%)`;
        crossLines[3].style.transform = `translate3d(${gap}px,-50%,0)`;
      }
    }

    // Ammo: count, pips, reserve, weapon names.
    const magSize = Math.max(1, Math.min(60, Number(weapon.magSize) | 0 || 30));
    const ammo = Math.max(0, Number(weapon.ammo) | 0);
    const reserve = weapon.reserve === Infinity ? 9999 : Math.max(0, Number(weapon.reserve) | 0);
    if (magSize !== cache.mag) {
      cache.mag = magSize;
      pipsEl.innerHTML = '<i></i>'.repeat(magSize);
      ammoPips = [...pipsEl.children];
      cache.ammo = -1;
    }
    if (ammo !== cache.ammo) {
      cache.ammo = ammo;
      ammoNumber.textContent = String(ammo).padStart(2, '0');
      for (let i = 0; i < ammoPips.length; i++) ammoPips[i].className = i < ammo ? '' : 'off';
    }
    if (reserve !== cache.reserve) {
      cache.reserve = reserve;
      reserveEl.textContent = reserve >= 9999 ? '∞' : String(reserve).padStart(3, '0');
    }
    if (weapon.name !== cache.name) {
      cache.name = weapon.name;
      weaponNameEl.textContent = weapon.name || '';
    }
    let altHtml = '';
    if (weapon.slots && weapon.slots.length > 1) {
      const other = weapon.slots[0].id === weapon.current ? weapon.slots[1] : weapon.slots[0];
      const device = game.input.device;
      altHtml =
        (device === 'pad'
          ? '<kbd>Y</kbd>'
          : device === 'touch' || game.input.touch
            ? ''
            : '<kbd>Q</kbd>') +
        `<b>${other.name || ''}</b> ${String(Math.max(0, Number(other.ammo) | 0)).padStart(2, '0')} / ${other.reserve === Infinity ? '∞' : Math.max(0, Number(other.reserve) | 0)}`;
    }
    if (altHtml !== cache.alt) {
      cache.alt = altHtml;
      altWeaponEl.innerHTML = altHtml;
    }
    const lowAmmo = ammo <= Math.ceil(magSize * 0.27);
    const cue =
      weapon.state === 'reloading'
        ? t('cue.reloading')
        : weapon.state === 'switching'
          ? ''
          : ammo === 0
            ? reserve > 0
              ? game.input.touch
                ? t('cue.reload')
                : t('cue.reloadKey', { key: game.input.device === 'pad' ? 'X' : 'R' })
              : weapon.slots && weapon.slots.length > 1
                ? game.input.device === 'pad'
                  ? t('cue.emptySwapKey', { key: 'Y' })
                  : game.input.touch
                    ? t('cue.emptySwap')
                    : t('cue.emptySwapKey', { key: 'Q' })
                : t('cue.empty')
            : lowAmmo
              ? t('cue.lowAmmo')
              : '';
    if (cue !== cache.cue) {
      cache.cue = cue;
      cueEl.textContent = cue;
      cueEl.className =
        'h-cue' +
        (cue ? ' on' : '') +
        (ammo === 0 && weapon.state !== 'reloading' ? ' urgent' : '');
    }
    if (lowAmmo !== cache.low) {
      cache.low = lowAmmo;
      ammoEl.classList.toggle('low', lowAmmo);
    }

    // Vitals.
    const hp = Math.max(0, Math.ceil(player.health));
    const hurt = player.health < player.maxHealth - 0.5;
    if (hp !== cache.hp) {
      cache.hp = hp;
      hpNumber.textContent = String(hp);
      const segments = Math.ceil((hp / player.maxHealth) * hpSegments.length);
      if (segments !== cache.hpSeg) {
        cache.hpSeg = segments;
        for (let i = 0; i < hpSegments.length; i++) {
          hpSegments[i].className = i < segments ? '' : 'off';
        }
        healthEl.classList.toggle('crit', segments <= 3);
      }
    }
    if (hurt !== cache.hurt) {
      cache.hurt = hurt;
      healthEl.classList.toggle('on', hurt);
    }

    // Damage direction arcs point at the shooter, relative to the view.
    for (const arc of arcs) {
      if (arc.life <= 0) {
        if (arc.op !== 0) {
          arc.op = 0;
          arc.el.style.opacity = '0';
        }
        continue;
      }
      arc.life -= dt;
      const angle = Math.atan2(arc.src.x - player.pos.x, -(arc.src.z - player.pos.z)) + player.yaw;
      const deg = Math.round((angle * 180) / Math.PI);
      if (deg !== arc.rot) {
        arc.rot = deg;
        arc.el.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
      }
      const opacity = Math.round(Math.min(1, Math.max(0, arc.life / 0.6)) * 20) / 20;
      if (opacity !== arc.op) {
        arc.op = opacity;
        arc.el.style.opacity = String(opacity);
      }
    }

    // Objective text types itself out.
    if (objectiveShown < objective.length) {
      objectiveTyped += dt * 46;
      const count = Math.min(objective.length, Math.floor(objectiveTyped));
      if (count !== objectiveShown) {
        objectiveShown = count;
        objectiveText.textContent = objective.slice(0, count);
      }
    }
    if (warnTimer > 0) {
      warnTimer -= dt;
      if (warnTimer <= 0) warnEl.classList.remove('on');
    }
    if (messageTimer > 0) {
      messageTimer -= dt;
      if (messageTimer <= 0) messageEl.classList.remove('on');
    }
    for (let i = feedLines.length - 1; i >= 0; i--) {
      const line = feedLines[i];
      line.life -= dt;
      if (line.life <= 0) {
        line.el.remove();
        feedLines.splice(i, 1);
      } else if (line.life < 0.6 && !line.out) {
        line.out = true;
        line.el.classList.add('out');
      }
    }
  }

  /** Types out the current radio line, then holds it for its duration. */
  function updateRadio(dt: number): void {
    if (!radioLine) {
      if (!radioQueue.length) return;
      radioLine = radioQueue.shift()!;
      radioShown = 0;
      radioTyped = 0;
      radioHold = radioLine.secs;
      commsText.textContent = '';
      comms.classList.add('on');
      game.events.emit('radio:line', {
        text: radioLine.text
      });
    }
    const text = radioLine.text;
    if (radioShown < text.length) {
      radioTyped += dt * 58;
      const count = Math.min(text.length, Math.floor(radioTyped));
      if (count !== radioShown) {
        radioShown = count;
        commsText.textContent = text.slice(0, count);
      }
    } else {
      radioHold -= dt;
      if (radioHold <= 0) {
        radioLine = null;
        if (!radioQueue.length) comms.classList.remove('on');
      }
    }
  }

  onResize();
  return hud;
}
