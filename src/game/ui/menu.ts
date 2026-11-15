/**
 * Menus (DOM inside #ui): title, pause, death and debrief screens, the
 * settings / controls panel, the location card, persisted settings
 * (localStorage) and keyboard / gamepad menu navigation helpers. Created and
 * driven by the game flow.
 */
import { PLAYER_BODY, QUALITY_PRESETS } from '../core/config';
import type { QualityName } from '../core/config';
import type { Game } from '../core/types';
import { LANGS, getLang, getLocale, setLang, t } from '../i18n';
import type { Lang, MessageKey } from '../i18n';

/** Persisted player settings. */
export interface MenuSettings {
  /** `'auto'` or a quality preset name. */
  quality: string;
  sens: number;
  invertY: boolean;
  /** Master volume, 0..1. */
  volume: number;
  fov: number;
  difficulty: string;
  /** `'mission'` or `'holdout'`. */
  mode: string;
  /** Viewmodel position preset (1..3). */
  view: number;
  /** `'rain'` or `'clear'`. */
  weather: string;
  /** Background music (off by default). */
  music: boolean;
}

const SETTINGS_KEY = 'saltline.settings.v1';
const DEFAULT_SETTINGS: MenuSettings = {
  quality: 'auto',
  sens: 1,
  invertY: false,
  volume: 0.8,
  fov: PLAYER_BODY.fov,
  difficulty: 'hard',
  mode: 'mission',
  view: 1,
  weather: 'rain',
  music: false
};
const VIEW_OPTIONS: [number, MessageKey][] = [
  [1, 'view.close'],
  [2, 'view.threeQuarter'],
  [3, 'view.compact']
];
const MODE_OPTIONS: [string, MessageKey][] = [
  ['mission', 'mode.mission'],
  ['holdout', 'mode.holdout']
];
const MODE_NOTES: Record<string, MessageKey | undefined> = {
  mission: 'note.mission',
  holdout: 'note.holdout'
};
const WEATHER_OPTIONS: [string, MessageKey][] = [
  ['rain', 'weather.rain'],
  ['clear', 'weather.clear']
];
const DIFFICULTY_OPTIONS: [string, MessageKey][] = [
  ['standard', 'diff.standard'],
  ['hard', 'diff.hard'],
  ['brutal', 'diff.brutal']
];
const QUALITY_LEVELS = ['low', 'medium', 'high', 'ultra'];

/** Settings as read back from storage (unvalidated). */
interface StoredSettings {
  quality?: unknown;
  sens?: unknown;
  invertY?: unknown;
  volume?: unknown;
  fov?: unknown;
  difficulty?: unknown;
  mode?: unknown;
  view?: unknown;
  weather?: unknown;
  music?: unknown;
}

/** Loads settings from localStorage, keeping defaults for anything missing or invalid. */
function loadSettings(): MenuSettings {
  const settings: MenuSettings = {
    ...DEFAULT_SETTINGS
  };
  try {
    const stored = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) || 'null'
    ) as StoredSettings | null;
    if (stored && typeof stored == 'object') {
      if (stored.quality === 'auto' || (QUALITY_LEVELS as unknown[]).includes(stored.quality)) {
        settings.quality = stored.quality as string;
      }
      if (Number.isFinite(stored.sens)) {
        settings.sens = Math.min(3, Math.max(0.2, stored.sens as number));
      }
      settings.invertY = !!stored.invertY;
      settings.music = stored.music === true;
      if (Number.isFinite(stored.volume)) {
        settings.volume = Math.min(1, Math.max(0, stored.volume as number));
      }
      if (Number.isFinite(stored.fov)) {
        settings.fov = Math.min(95, Math.max(60, stored.fov as number));
      }
      if (DIFFICULTY_OPTIONS.some((option) => option[0] === stored.difficulty)) {
        settings.difficulty = stored.difficulty as string;
      }
      if (MODE_OPTIONS.some((option) => option[0] === stored.mode)) {
        settings.mode = stored.mode as string;
      }
      if (VIEW_OPTIONS.some((option) => option[0] === stored.view)) {
        settings.view = stored.view as number;
      }
      if (WEATHER_OPTIONS.some((option) => option[0] === stored.weather)) {
        settings.weather = stored.weather as string;
      }
    }
  } catch {}
  return settings;
}

function saveSettings(settings: MenuSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

const keyRow = (term: string, desc: string) => `<div><dt>${term}</dt><dd>${desc}</dd></div>`;
const keyboardControlsHtml = () => `
  <dl class="keys">
    ${keyRow(t('lg.move'), '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>')}
    ${keyRow(t('lg.look'), t('key.mouse'))}
    ${keyRow(t('lg.fire'), t('v.leftButton'))}
    ${keyRow(t('lg.aim'), t('v.rightButton'))}
    ${keyRow(t('lg.reload'), '<kbd>R</kbd>')}
    ${keyRow(t('k.swap'), t('v.swapKeys'))}
    ${keyRow(t('lg.cut'), t('v.holdE'))}
    ${keyRow(t('lg.jump'), `<kbd>${t('key.space')}</kbd>`)}
    ${keyRow(t('lg.sprint'), `<kbd>${t('key.shift')}</kbd>`)}
    ${keyRow(t('lg.crouch'), t('v.crouchKeys'))}
    ${keyRow(t('k.melee'), '<kbd>F</kbd>')}
    ${keyRow(t('lg.pause'), t('v.pauseKeys'))}
  </dl>`;
const gamepadControlsHtml = () => `
  <dl class="keys">
    ${keyRow(t('k.moveLook'), t('v.sticks'))}
    ${keyRow(t('k.fireAim'), '<kbd>RT</kbd>, <kbd>LT</kbd>')}
    ${keyRow(t('lg.reload'), '<kbd>X</kbd>')}
    ${keyRow(t('lg.cut'), t('v.padCut'))}
    ${keyRow(t('k.swap'), t('v.padSwap'))}
    ${keyRow(t('lg.jump'), '<kbd>A</kbd>')}
    ${keyRow(t('lg.crouch'), t('v.padCrouch'))}
    ${keyRow(t('lg.sprint'), t('v.padSprint'))}
    ${keyRow(t('k.melee'), t('v.padMelee'))}
    ${keyRow(t('lg.pause'), '<kbd>Start</kbd>')}
  </dl>`;
const touchControlsHtml = () => `
  <dl class="keys">
    ${keyRow(t('lg.move'), t('v.tMove'))}
    ${keyRow(t('lg.look'), t('v.tLook'))}
    ${keyRow(t('lg.fire'), t('v.tFire'))}
    ${keyRow(t('lg.aim'), t('v.tAim'))}
    ${keyRow(t('lg.reload'), t('t.reload'))}
    ${keyRow(t('lg.jump'), t('t.jump'))}
    ${keyRow(t('lg.cut'), t('v.tCut'))}
    ${keyRow(t('lg.sprint'), t('v.tSprint'))}
  </dl>`;

/** Callbacks the menu invokes; button `data-act` names map to the methods. */
export interface MenuActions {
  difficulty?(level: string): void;
  deploy?(event?: MouseEvent): void;
  resume?(event?: MouseEvent): void;
  home?(event?: MouseEvent): void;
  restart?(event?: MouseEvent): void;
  retry?(event?: MouseEvent): void;
  redeploy?(event?: MouseEvent): void;
}
type MenuActionName = 'deploy' | 'resume' | 'home' | 'restart' | 'retry' | 'redeploy';

/** Holdout results shown on the death screen. */
export interface HoldoutResult {
  waves: number;
  kills: number;
  score: number;
  best: number;
  /** True when `best` was just set by this run. */
  record: boolean;
}

/** Which menu screen is shown. */
export type MenuScreen = 'none' | 'title' | 'paused' | 'dead' | 'complete';

/** The menu controller returned by {@link createMenu}. */
export interface Menu {
  root: HTMLElement;
  settings: MenuSettings;
  /** Formats seconds as `mm:ss`. */
  fmtTime(seconds: number): string;
  readonly screen: string;
  readonly panelOpen: boolean;
  /** Closes the settings panel; returns false if it was not open. */
  closePanel(): boolean;
  /** Moves keyboard / pad focus by `dir` (+1 / -1) through the visible controls. */
  nav(dir: number): void;
  /** Nudges the focused slider by `dir`, or navigates when no slider is focused. */
  adjust(dir: number): void;
  /** Clicks the focused button, else the screen's primary button. */
  accept(): void;
  primary(): void;
  show(screen: MenuScreen): void;
  locationCard(on: boolean): void;
  setLookMode(text: string): void;
  setDead(info: {
    time: number;
    relays: number;
    total: number;
    holdout: HoldoutResult | null;
  }): void;
  setDebrief(info: {
    time: number;
    accuracy: number | null;
    kills: number;
    retries: number;
    rating: string;
  }): void;
  /** Pushes settings to the subsystems (all, or only the one named by `key`). */
  applySettings(key?: string): void;
}

/** Vendor-prefixed fullscreen API (Safari). */
interface WebkitFullscreenDocument {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
}
interface WebkitFullscreenElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/** Builds the menu DOM inside #ui. */
export function createMenu(game: Game, actions: MenuActions): Menu {
  const uiRoot = document.getElementById('ui')!;
  const settings = loadSettings();
  const root = document.createElement('div');
  root.className = 'menu';
  root.dataset.screen = 'none';
  const seg = (attr: string, labelId: string, options: [string | number, string][]) =>
    `<div class="seg" role="group" aria-labelledby="${labelId}">${options.map((option) => `<button data-${attr}="${option[0]}" aria-pressed="false">${option[1]}</button>`).join('')}</div>`;
  const row = (labelHtml: string, controlHtml: string, extra = '') =>
    `<div class="row"${extra}>${labelHtml}<div class="row-c">${controlHtml}</div></div>`;
  const tr = <V,>(options: [V, MessageKey][]): [V, string][] =>
    options.map(([value, key]) => [value, t(key)]);
  const langSelect = (id: string) =>
    `<div class="select"><select id="${id}">${LANGS.map(([code, name]) => `<option value="${code}"${code === getLang() ? ' selected' : ''}>${name}</option>`).join('')}</select><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></div>`;
  root.innerHTML = `
    <div class="m-veil"></div>

    <section class="m-screen m-title" data-s="title" aria-label="Saltline">
      <div class="m-title-main">
        <div class="m-eyebrow"><span class="m-tag">B4</span><span>${t('title.unit')}</span><span class="m-dim">\xB7 ${t('title.place')}</span></div>
        <h1 class="m-word">Saltline</h1>
        <p class="m-premise">${t('title.premise')}</p>
        <div class="m-options">
          <div class="m-opt"><span class="m-opt-l" id="l-tm">${t('opt.mode')}</span>${seg('m', 'l-tm', tr(MODE_OPTIONS))}</div>
          <p class="m-pick-note" data-f="modenote"></p>
          <div class="m-opt"><span class="m-opt-l" id="l-td">${t('opt.difficulty')}</span>${seg('d', 'l-td', tr(DIFFICULTY_OPTIONS))}</div>
          <div class="m-opt"><span class="m-opt-l" id="l-tw">${t('opt.weather')}</span>${seg('w', 'l-tw', tr(WEATHER_OPTIONS))}</div>
        </div>
        <button class="btn primary m-start" data-act="deploy">${t('btn.start')}</button>
        <div class="m-secondary">
          <button class="btn quiet" data-act="settings">${t('btn.settings')}</button>
          <button class="btn quiet" data-act="controls">${t('btn.controls')}</button>
        </div>
        <p class="m-note">${t('title.note')}</p>
        <p class="m-ad">${t('ad.text')} <a href="https://layerwise.app" target="_blank" rel="noopener">${t('ad.link')}<span aria-hidden="true"> ↗</span></a></p>
        <p class="m-credit m-credit-narrow">${t('credit')}</p>
      </div>
      <aside class="m-legend" aria-label="${t('legend.aria')}">
        <div><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> ${t('lg.move')}</span><span><kbd>${t('key.mouse')}</kbd> ${t('lg.look')}</span><span><kbd>${t('key.lmb')}</kbd> ${t('lg.fire')}</span><span><kbd>${t('key.rmb')}</kbd> ${t('lg.aim')}</span><span><kbd>R</kbd> ${t('lg.reload')}</span></div>
        <div><span><kbd>Q</kbd> ${t('lg.sidearm')}</span><span><kbd>E</kbd> ${t('lg.cut')}</span><span><kbd>${t('key.space')}</kbd> ${t('lg.jump')}</span><span><kbd>${t('key.shift')}</kbd> ${t('lg.sprint')}</span><span><kbd>C</kbd> ${t('lg.crouch')}</span><span><kbd>Esc</kbd> ${t('lg.pause')}</span></div>
        <div class="lg-pad"><em>${t('lg.controller')}</em><span>${t('lg.sticks')}</span><span><kbd>RT</kbd> ${t('lg.fire')}</span><span><kbd>LT</kbd> ${t('lg.aim')}</span><span><kbd>X</kbd> ${t('lg.reloadCut')}</span><span><kbd>Y</kbd> ${t('lg.sidearm')}</span><span><kbd>A</kbd> ${t('lg.start')}</span></div>
        <div class="lg-touch"><em>${t('lg.touch')}</em><span>${t('lg.leftThumb')}</span><span>${t('lg.rightThumb')}</span><span>${t('lg.touchButtons')}</span></div>
        <p class="m-credit">${t('credit')}</p>
      </aside>
    </section>

    <section class="m-screen m-card" data-s="paused" aria-label="${t('paused.h')}">
      <div class="m-k">${t('paused.k')}</div>
      <h2 class="m-h">${t('paused.h')}</h2>
      <p class="m-line" data-f="lookmode"></p>
      <div class="m-actions col">
        <button class="btn primary" data-act="resume">${t('btn.resume')}</button>
        <button class="btn" data-act="settings">${t('btn.settings')}</button>
        <button class="btn" data-act="controls">${t('btn.controls')}</button>
        <button class="btn quiet" data-act="restart">${t('btn.restart')}</button>
        <button class="btn quiet" data-act="home">${t('btn.home')}</button>
      </div>
    </section>

    <section class="m-screen m-card m-dead" data-s="dead" aria-label="${t('dead.h')}">
      <div class="m-k">${t('dead.k')}</div>
      <h2 class="m-h">${t('dead.h')}</h2>
      <dl class="m-stats"><div><dt>${t('st.timeSurvived')}</dt><dd data-f="dead-time">00:00</dd></div><div data-only="mission"><dt>${t('st.relaysCut')}</dt><dd data-f="dead-relays">0/3</dd></div><div data-only="holdout"><dt>${t('st.wavesCleared')}</dt><dd data-f="dead-wave">0</dd></div><div data-only="holdout"><dt>${t('st.hostilesDown')}</dt><dd data-f="dead-kills">0</dd></div><div data-only="holdout"><dt>${t('st.score')}</dt><dd data-f="dead-score">0</dd></div><div data-only="holdout"><dt>${t('st.best')}</dt><dd data-f="dead-best">0</dd></div></dl>
      <div class="m-actions col"><button class="btn primary" data-act="retry">${t('btn.retry')}</button></div>
    </section>

    <section class="m-screen m-card m-debrief" data-s="complete" aria-label="${t('debrief.aria')}">
      <div class="m-k">${t('debrief.k')}</div>
      <h2 class="m-h">${t('debrief.h')}</h2>
      <div class="m-rating"><span>${t('st.rating')}</span><b data-f="rating">${t('rating.3')}</b></div>
      <dl class="m-stats">
        <div><dt>${t('st.time')}</dt><dd data-f="time">00:00</dd></div>
        <div><dt>${t('st.accuracy')}</dt><dd data-f="acc">0%</dd></div>
        <div><dt>${t('st.hostilesDown')}</dt><dd data-f="kills">0</dd></div>
        <div><dt>${t('st.retries')}</dt><dd data-f="retries">0</dd></div>
      </dl>
      <div class="m-actions col"><button class="btn primary" data-act="redeploy">${t('btn.again')}</button></div>
    </section>

    <div class="panel" role="dialog" aria-modal="true" aria-label="${t('panel.aria')}" tabindex="-1" hidden>
      <header class="panel-h">
        <button class="back" data-act="close-panel"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>${t('btn.back')}</button>
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="settings" aria-selected="true">${t('btn.settings')}</button>
          <button class="tab" role="tab" data-tab="controls" aria-selected="false">${t('btn.controls')}</button>
        </div>
      </header>
      <div class="panel-b" data-pane="settings">
        <section class="p-group" aria-labelledby="g-gfx"><h3 id="g-gfx">${t('g.graphics')}</h3>
          ${row(`<label id="l-q">${t('set.quality')}</label>`, seg('q', 'l-q', QUALITY_LEVELS.map((level) => [level, t(`q.${level}` as MessageKey)])))}
          ${row(`<label for="s-fov">${t('set.fov')}</label>`, '<div class="slider"><input id="s-fov" type="range" min="60" max="95" step="1"><output data-o="fov"></output></div>')}
          ${row(`<label id="l-v">${t('set.weaponPos')}</label>`, seg('v', 'l-v', tr(VIEW_OPTIONS)))}
          ${row(`<label id="l-fs">${t('set.fullscreen')}</label>`, `<button class="btn small" data-act="fullscreen" aria-labelledby="l-fs fs-t"><span id="fs-t">${t('fs.enter')}</span></button>`, ' data-row="fs"')}
        </section>
        <section class="p-group" aria-labelledby="g-audio"><h3 id="g-audio">${t('g.audio')}</h3>
          ${row(`<label for="s-vol">${t('set.volume')}</label>`, '<div class="slider"><input id="s-vol" type="range" min="0" max="100" step="1"><output data-o="vol"></output></div>')}
          ${row(`<label id="l-mus">${t('set.music')}</label>`, `<button class="toggle" data-act="music" aria-labelledby="l-mus" aria-pressed="false"><span>${t('off')}</span><i></i></button>`)}
        </section>
        <section class="p-group" aria-labelledby="g-ctl"><h3 id="g-ctl">${t('g.controls')}</h3>
          ${row(`<label for="s-sens">${t('set.sens')}</label>`, '<div class="slider"><input id="s-sens" type="range" min="0.2" max="3" step="0.05"><output data-o="sens"></output></div>')}
          ${row(`<label id="l-inv">${t('set.invert')}</label>`, `<button class="toggle" data-act="invert" aria-labelledby="l-inv" aria-pressed="false"><span>${t('off')}</span><i></i></button>`)}
        </section>
        <section class="p-group" aria-labelledby="g-play"><h3 id="g-play">${t('g.gameplay')}</h3>
          ${row(`<label id="l-d">${t('opt.difficulty')}</label>`, seg('d', 'l-d', tr(DIFFICULTY_OPTIONS)))}
          ${row(`<label id="l-w">${t('opt.weather')}</label>`, seg('w', 'l-w', tr(WEATHER_OPTIONS)))}
          ${row(`<label for="s-lang">${t('opt.language')}</label>`, langSelect('s-lang'))}
        </section>
        <p class="panel-note" data-f="qnote"></p>
      </div>
      <div class="panel-b" data-pane="controls" hidden>
        <h3>${t('ctl.kbm')}</h3>${keyboardControlsHtml()}
        <p class="panel-note">${t('ctl.noteMouse')}</p>
        <h3>${t('ctl.touch')}</h3>${touchControlsHtml()}
        <h3>${t('ctl.pad')}</h3>${gamepadControlsHtml()}
        <p class="panel-note">${t('ctl.notePad')}</p>
      </div>
    </div>

    <div class="loc-card" aria-hidden="true"><i></i><b>${t('loc.title')}</b><span>${t('loc.sub')}</span></div>
  `;
  uiRoot.appendChild(root);
  const find = <T extends HTMLElement = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;
  const findAll = <T extends HTMLElement = HTMLElement>(selector: string) => [
    ...root.querySelectorAll<T>(selector)
  ];
  const panel = find('.panel');
  const locCard = find('.loc-card');
  const field = (name: string) => root.querySelector<HTMLElement>(`[data-f="${name}"]`)!;
  const sensInput = find<HTMLInputElement>('#s-sens');
  const volumeInput = find<HTMLInputElement>('#s-vol');
  const fovInput = find<HTMLInputElement>('#s-fov');
  let screen = 'none';
  /** Element focused before the panel opened (focus returns there on close). */
  let focusBeforePanel: HTMLElement | null = null;

  function applySettings(key?: string): void {
    if (!key || key === 'sens') game.input.sensitivity = settings.sens;
    if (!key || key === 'invertY') game.input.invertY = settings.invertY;
    if (!key || key === 'volume') {
      try {
        // Not every audio implementation (e.g. the silent stub) has a volume control.
        const audio = game.audio as typeof game.audio & { setVolume?(volume: number): void };
        if (audio && audio.setVolume) audio.setVolume(settings.volume);
      } catch (err) {
        console.error(err);
      }
    }
    if (!key || key === 'music') {
      try {
        const audio = game.audio as typeof game.audio & { setMusic?(on: boolean): void };
        if (audio && audio.setMusic) audio.setMusic(settings.music);
      } catch (err) {
        console.error(err);
      }
    }
    if (!key || key === 'view') {
      try {
        if (game.weapon && game.weapon.setView) game.weapon.setView(settings.view);
      } catch (err) {
        console.error(err);
      }
    }
    // `?rain=` pins the weather for QA.
    if ((!key || key === 'weather') && game.params.rain === undefined && game.weather) {
      game.weather.rain = settings.weather === 'clear' ? 0 : 1;
    }
    if ((!key || key === 'fov') && game.player && game.player.setFov) {
      game.player.setFov(settings.fov);
    }
    if (
      key === 'quality' ||
      (!key &&
        settings.quality !== 'auto' &&
        !game.params.shot &&
        !game.params.q &&
        settings.quality !== (game.quality && game.quality.name))
    ) {
      const preset = QUALITY_PRESETS[settings.quality as QualityName];
      if (preset) {
        try {
          if (game.render && game.render.setQuality) {
            game.render.setQuality({
              ...preset
            });
          } else {
            game.quality = {
              ...preset
            };
          }
        } catch (err) {
          console.error('[game] setQuality failed', err);
        }
      }
    }
  }

  /** Syncs every control with the current settings. */
  function refreshControls(): void {
    const activeQuality =
      settings.quality === 'auto' ? game.quality && game.quality.name : settings.quality;
    for (const button of findAll('.seg button[data-q]')) {
      button.setAttribute('aria-pressed', String(button.dataset.q === activeQuality));
    }
    for (const button of findAll('.seg button[data-d]')) {
      button.setAttribute('aria-pressed', String(button.dataset.d === settings.difficulty));
    }
    for (const button of findAll('.seg button[data-v]')) {
      button.setAttribute('aria-pressed', String(+button.dataset.v! === settings.view));
    }
    for (const button of findAll('.seg button[data-w]')) {
      button.setAttribute('aria-pressed', String(button.dataset.w === settings.weather));
    }
    for (const button of findAll('.seg button[data-m]')) {
      button.setAttribute('aria-pressed', String(button.dataset.m === settings.mode));
    }
    root.dataset.mode = settings.mode;
    const modeNote = MODE_NOTES[settings.mode];
    field('modenote').textContent = modeNote ? t(modeNote) : '';
    sensInput.value = String(settings.sens);
    volumeInput.value = String(Math.round(settings.volume * 100));
    fovInput.value = String(settings.fov);
    for (const input of [sensInput, volumeInput, fovInput]) {
      const pct = ((+input.value - +input.min) / (+input.max - +input.min)) * 100;
      input.style.setProperty('--pct', pct + '%');
    }
    find('[data-o="sens"]').textContent = settings.sens.toFixed(2) + '\xD7';
    find('[data-o="vol"]').textContent = Math.round(settings.volume * 100) + '%';
    find('[data-o="fov"]').textContent = Math.round(settings.fov) + '\xB0';
    const musicButton = find('[data-act="music"]');
    musicButton.setAttribute('aria-pressed', String(settings.music));
    musicButton.querySelector('span')!.textContent = settings.music ? t('on') : t('off');
    const invertButton = find('[data-act="invert"]');
    invertButton.setAttribute('aria-pressed', String(settings.invertY));
    invertButton.querySelector('span')!.textContent = settings.invertY ? t('on') : t('off');
    field('qnote').textContent =
      settings.quality === 'auto'
        ? t('qnote.auto', {
            q: activeQuality ? t(`q.${activeQuality}` as MessageKey) : t('qnote.default')
          })
        : t('qnote.manual');
    field('qnote').textContent += ' ' + t('qnote.difficulty');
  }

  root.querySelector('#s-lang')!.addEventListener('change', (event) => {
    setLang((event.target as unknown as { value: string }).value as Lang);
  });
  sensInput.addEventListener('input', () => {
    settings.sens = +sensInput.value;
    applySettings('sens');
    refreshControls();
    saveSettings(settings);
  });
  volumeInput.addEventListener('input', () => {
    settings.volume = +volumeInput.value / 100;
    applySettings('volume');
    refreshControls();
    saveSettings(settings);
  });
  fovInput.addEventListener('input', () => {
    settings.fov = +fovInput.value;
    applySettings('fov');
    refreshControls();
    saveSettings(settings);
  });

  // Fullscreen toggle (hidden where the API is unavailable).
  const fullscreenRow = find('[data-row="fs"]');
  const fullscreenLabel = find('#fs-t');
  const doc = document as Document & WebkitFullscreenDocument;
  const isFullscreen = () => doc.fullscreenElement || doc.webkitFullscreenElement || null;
  const fullscreenTarget = (document.getElementById('app') || document.documentElement) as
    (HTMLElement & WebkitFullscreenElement) | null;
  if (!(
    fullscreenTarget &&
    (fullscreenTarget.requestFullscreen || fullscreenTarget.webkitRequestFullscreen) &&
    doc.fullscreenEnabled !== false &&
    doc.webkitFullscreenEnabled !== false
  )) {
    fullscreenRow.hidden = true;
  }
  function onFullscreenUnavailable(): void {
    fullscreenLabel.textContent = t('fs.unavailable');
  }
  function toggleFullscreen(): void {
    try {
      if (isFullscreen()) {
        (doc.exitFullscreen || doc.webkitExitFullscreen).call(document);
        return;
      }
      const target = fullscreenTarget!;
      const result: Promise<void> | void = (
        target.requestFullscreen || target.webkitRequestFullscreen
      ).call(target);
      if (result && result.catch) result.catch(onFullscreenUnavailable);
    } catch {
      onFullscreenUnavailable();
    }
  }
  const updateFullscreenLabel = () => {
    fullscreenLabel.textContent = isFullscreen() ? t('fs.exit') : t('fs.enter');
  };
  document.addEventListener('fullscreenchange', updateFullscreenLabel);
  document.addEventListener('webkitfullscreenchange', updateFullscreenLabel);

  function openPanel(tab?: string): void {
    focusBeforePanel = document.activeElement as HTMLElement | null;
    panel.hidden = false;
    root.classList.add('panel-open');
    selectTab(tab || 'settings');
    try {
      panel.focus({
        preventScroll: true
      });
    } catch {}
  }

  function closePanel(): boolean {
    if (panel.hidden) return false;
    panel.hidden = true;
    root.classList.remove('panel-open');
    if (focusBeforePanel && focusBeforePanel.focus && root.contains(focusBeforePanel)) {
      focusBeforePanel.focus();
    } else {
      focusPrimary();
    }
    return true;
  }

  function selectTab(tab: string): void {
    for (const tabButton of findAll('.tab')) {
      tabButton.setAttribute('aria-selected', String(tabButton.dataset.tab === tab));
    }
    for (const pane of findAll('.panel-b')) pane.hidden = pane.dataset.pane !== tab;
  }

  function focusPrimary(): void {
    const button = root.querySelector<HTMLElement>(`.m-screen[data-s="${screen}"] .btn.primary`);
    if (button) {
      try {
        button.focus({
          preventScroll: true
        });
      } catch {}
    }
  }

  root.addEventListener('click', (event) => {
    const button = (event.target as Element).closest('button');
    if (!button || !root.contains(button)) return;
    game.events.emit('ui:click', {});
    if (button.dataset.q) {
      settings.quality = button.dataset.q;
      applySettings('quality');
      refreshControls();
      saveSettings(settings);
      return;
    }
    if (button.dataset.v) {
      settings.view = +button.dataset.v;
      applySettings('view');
      refreshControls();
      saveSettings(settings);
      return;
    }
    if (button.dataset.w) {
      settings.weather = button.dataset.w;
      applySettings('weather');
      refreshControls();
      saveSettings(settings);
      return;
    }
    if (button.dataset.m) {
      settings.mode = button.dataset.m;
      refreshControls();
      saveSettings(settings);
      return;
    }
    if (button.dataset.d) {
      settings.difficulty = button.dataset.d;
      if (actions.difficulty) actions.difficulty(settings.difficulty);
      refreshControls();
      saveSettings(settings);
      return;
    }
    if (button.dataset.tab) {
      selectTab(button.dataset.tab);
      return;
    }
    const act = button.dataset.act;
    if (act === 'settings') openPanel('settings');
    else if (act === 'controls') openPanel('controls');
    else if (act === 'close-panel') closePanel();
    else if (act === 'invert') {
      settings.invertY = !settings.invertY;
      applySettings('invertY');
      refreshControls();
      saveSettings(settings);
    } else if (act === 'music') {
      settings.music = !settings.music;
      applySettings('music');
      refreshControls();
      saveSettings(settings);
    } else if (act === 'fullscreen') toggleFullscreen();
    else if (act && actions[act as MenuActionName]) actions[act as MenuActionName]!(event);
  });
  root.addEventListener('mouseover', (event) => {
    const button = (event.target as Element).closest('button');
    if (button && event.relatedTarget && !button.contains(event.relatedTarget as Node)) {
      game.events.emit('ui:hover', {});
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.code === 'Escape' && !panel.hidden) {
      closePanel();
      event.stopPropagation();
      event.preventDefault();
    }
    if (event.code === 'Tab' && !panel.hidden) {
      // Trap focus inside the panel.
      const focusables = [...panel.querySelectorAll<HTMLElement>('button, input, select')].filter(
        (el) => el.offsetParent !== null
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        last.focus();
        event.preventDefault();
      } else if (!event.shiftKey && document.activeElement === last) {
        first.focus();
        event.preventDefault();
      }
    }
  });

  /** Enabled, visible buttons and inputs of the open panel or current screen. */
  const navigableControls = (): (HTMLButtonElement | HTMLInputElement)[] => {
    const container = panel.hidden ? root.querySelector(`.m-screen[data-s="${screen}"]`) : panel;
    return container
      ? [
          ...container.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input, select')
        ].filter((el) => !el.disabled && el.offsetParent !== null)
      : [];
  };
  function nav(dir: number): void {
    const controls = navigableControls();
    if (!controls.length) return;
    root.classList.add('pad-nav');
    let index = controls.indexOf(document.activeElement as HTMLButtonElement | HTMLInputElement);
    index =
      index < 0
        ? dir > 0
          ? 0
          : controls.length - 1
        : (index + dir + controls.length) % controls.length;
    const control = controls[index];
    try {
      control.focus({
        preventScroll: false
      });
      if (control.scrollIntoView) {
        control.scrollIntoView({
          block: 'nearest'
        });
      }
    } catch {}
    game.events.emit('ui:hover', {});
  }
  function adjust(dir: number): void {
    const active = document.activeElement as HTMLInputElement | null;
    if (active && active.tagName === 'INPUT' && active.type === 'range' && root.contains(active)) {
      const step =
        (+active.step || 1) * (active.id === 's-vol' ? 5 : active.id === 's-sens' ? 2 : 1);
      active.value = String(
        Math.min(+active.max, Math.max(+active.min, +active.value + dir * step))
      );
      active.dispatchEvent(
        new Event('input', {
          bubbles: true
        })
      );
    } else {
      nav(dir);
    }
  }
  function primary(): void {
    const button = root.querySelector<HTMLElement>(`.m-screen[data-s="${screen}"] .btn.primary`);
    if (button) button.click();
  }
  function accept(): void {
    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      active.tagName === 'BUTTON' &&
      root.contains(active) &&
      active.offsetParent !== null
    ) {
      active.click();
    } else {
      primary();
    }
  }
  root.addEventListener(
    'mousemove',
    () => {
      root.classList.toggle('pad-nav', false);
    },
    {
      passive: true
    }
  );
  const fmtTime = (seconds: number): string => {
    seconds = Math.max(0, Math.floor(seconds));
    return (
      String(Math.floor(seconds / 60)).padStart(2, '0') +
      ':' +
      String(seconds % 60).padStart(2, '0')
    );
  };
  const menu: Menu = {
    root,
    settings,
    fmtTime,
    get screen() {
      return screen;
    },
    get panelOpen() {
      return !panel.hidden;
    },
    closePanel,
    nav,
    adjust,
    accept,
    primary,
    show(next) {
      if (next === screen) return;
      screen = next;
      root.dataset.screen = next;
      closePanel();
      root.classList.toggle('open', next !== 'none');
      if (next !== 'none') {
        refreshControls();
        setTimeout(focusPrimary, 30);
      } else if (document.activeElement && root.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
    },
    locationCard(on) {
      locCard.classList.toggle('on', !!on);
    },
    setLookMode(text) {
      field('lookmode').textContent = text || '';
    },
    setDead({ time, relays, total, holdout }) {
      field('dead-time').textContent = fmtTime(time);
      field('dead-relays').textContent = `${relays}/${total}`;
      if (holdout) {
        field('dead-wave').textContent = String(holdout.waves);
        field('dead-kills').textContent = String(holdout.kills);
        field('dead-score').textContent = holdout.score.toLocaleString(getLocale());
        field('dead-best').textContent =
          holdout.best.toLocaleString(getLocale()) + (holdout.record ? ` · ${t('st.newBest')}` : '');
      }
    },
    setDebrief({ time, accuracy, kills, retries, rating }) {
      field('time').textContent = fmtTime(time);
      field('acc').textContent = accuracy == null ? '—' : Math.round(accuracy * 100) + '%';
      field('kills').textContent = String(kills);
      field('retries').textContent = String(retries);
      field('rating').textContent = rating;
    },
    applySettings
  };
  refreshControls();
  return menu;
}
