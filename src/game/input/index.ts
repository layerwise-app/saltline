/**
 * Player input: keyboard + mouse (pointer lock, with a "drag / screen edge"
 * fallback when the lock is unavailable), on-screen touch controls (virtual
 * stick, look drag and buttons) and gamepads (standard mapping, aim assist
 * hook, rumble and menu navigation). Everything is folded into one
 * `InputState` that the player, weapon and game flow poll each frame.
 */
import { t } from '../i18n';
import type { Game } from '../core/types';

/** Keyboard `KeyboardEvent.code` -> action name. */
const KEY_BINDINGS: Record<string, string | undefined> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyC: 'crouch',
  ControlLeft: 'crouch',
  ControlRight: 'crouch',
  KeyR: 'reload',
  KeyE: 'interact',
  KeyF: 'melee',
  KeyV: 'melee',
  Escape: 'pause',
  KeyP: 'pause',
  KeyQ: 'swap',
  Digit1: 'weapon1',
  Digit2: 'weapon2',
  Numpad1: 'weapon1',
  Numpad2: 'weapon2',
  Enter: 'fire',
  NumpadEnter: 'fire',
  ArrowLeft: 'turnL',
  ArrowRight: 'turnR',
  ArrowUp: 'turnU',
  ArrowDown: 'turnD',
  KeyJ: 'turnL',
  KeyL: 'turnR',
  KeyI: 'turnU',
  KeyK: 'turnD'
};
const MOUSE_LOOK_SCALE = 0.0021;
const TOUCH_LOOK_SCALE = 0.0052;
const KEY_TURN_RATE = 2.1;
const PAD_LOOK_RATE = 2.9;
const PAD_LOOK_BOOST_MULT = 1.75;
const PAD_LOOK_BOOST_RAMP_SECS = 0.45;
const TOUCH_STICK_RADIUS_PX = 58;
/** Actions that still report while gameplay input is off (menus). */
const ACTIONS_ALLOWED_UNLOCKED: Record<string, number | undefined> = {
  pause: 1
};

/** Which device last produced input. */
export type InputDevice = 'kbm' | 'pad' | 'touch';
/** How looking works: pointer lock, drag/screen-edge fallback, or touch. */
export type LookMode = 'lock' | 'drag' | 'touch';
/** One-shot menu navigation events produced by a gamepad. */
export type UiNavEvent = 'accept' | 'back' | 'start' | 'up' | 'down' | 'left' | 'right';

/**
 * Per-frame input state (`game.input`). Optional members are absent on the
 * showcase stub created by `main.ts`.
 */
export interface InputState {
  /** Movement in -1..1 (x = strafe right, y = forward). */
  move: { x: number; y: number };
  /** Accumulated look delta in radians since the last `endFrame()`. */
  look: { dx: number; dy: number };
  fire: boolean;
  ads: boolean;
  sprint: boolean;
  crouch: boolean;
  /** Pointer lock is active. */
  locked: boolean;
  /** Touch controls are active. */
  touch: boolean;
  gamepad?: boolean;
  sensitivity: number;
  invertY?: boolean;
  mode?: LookMode;
  device?: InputDevice;
  /** Gamepad aim-assist look multiplier (written by the game flow). */
  assist?: number;
  padName?: string;
  /** True if a gamepad menu-navigation event happened this frame. */
  uiPressed?(event: UiNavEvent): boolean;
  /** Gamepad rumble (only while the pad is the active device). */
  rumble?(strong?: number, weak?: number, durationMs?: number): void;
  /** Action is held (only while gameplay input is on, except `pause`). */
  down(action: string): boolean;
  /** Action went down this frame (only while gameplay input is on, except `pause`). */
  pressed(action: string): boolean;
  update(dt: number): void;
  /** Clears per-frame state (pressed actions, look delta). */
  endFrame(): void;
  requestLock(): void;
  exitLock(): void;
  /** Turns gameplay input on/off (off releases everything held). */
  setGameplay?(on: boolean): void;
  /** Shows the touch USE button / maps the pad X button to interact. */
  setPrompt?(on: unknown): void;
  onModeChange?(listener: (mode: LookMode) => void): void;
  /** Human-readable description of the current look mode. */
  describeMode?(): string;
}

type InputSource = 'key' | 'mouse' | 'touch' | 'pad';
type TouchButtonName = 'fire' | 'ads' | 'reload' | 'swap' | 'jump' | 'interact' | 'pause';

interface TouchUi {
  root: HTMLElement;
  stick: HTMLElement;
  nub: HTMLElement;
  btn: Record<TouchButtonName, HTMLElement>;
}

/** Creates the input system and installs its DOM listeners. */
export function createInput(game: Game): InputState {
  const canvas: HTMLElement =
    (game.renderer && game.renderer.domElement) || document.getElementById('view')!;
  const uiRoot = document.getElementById('ui')!;
  /** Actions currently held by any source. */
  const held = new Set<string>();
  /** Actions that went down this frame. */
  const pressedThisFrame = new Set<string>();
  const sources: Record<InputSource, Set<string>> = {
    key: new Set(),
    mouse: new Set(),
    touch: new Set(),
    pad: new Set()
  };
  let gameplayOn = false;
  let lockEverSucceeded = false;
  let lockRequestedAt = 0;
  let lockFailures = 0;
  let mouseButtons = 0;
  const modeListeners: ((mode: LookMode) => void)[] = [];
  const uiPressedSet = new Set<UiNavEvent>();
  let promptOn = false;

  function setDevice(device: InputDevice): void {
    if (input.device !== device) {
      input.device = device;
      try {
        document.documentElement.dataset.device = device;
      } catch {}
      game.events.emit('input:device', {
        device
      });
    }
  }

  const input: Required<InputState> = {
    move: {
      x: 0,
      y: 0
    },
    look: {
      dx: 0,
      dy: 0
    },
    fire: false,
    ads: false,
    sprint: false,
    crouch: false,
    locked: false,
    touch: false,
    gamepad: false,
    sensitivity: 1,
    invertY: false,
    mode: 'lock',
    device: 'kbm',
    assist: 1,
    padName: '',
    uiPressed(event) {
      return uiPressedSet.has(event);
    },
    rumble,
    down(action) {
      return held.has(action) && (gameplayOn || ACTIONS_ALLOWED_UNLOCKED[action] === 1);
    },
    pressed(action) {
      return pressedThisFrame.has(action) && (gameplayOn || ACTIONS_ALLOWED_UNLOCKED[action] === 1);
    },
    update,
    endFrame,
    requestLock,
    exitLock,
    setGameplay(on) {
      on = !!on;
      if (on !== gameplayOn) {
        gameplayOn = on;
        if (!on) releaseAll();
        if (touchUi) touchUi.root.classList.toggle('on', on && input.touch);
      }
    },
    setPrompt(on) {
      promptOn = !!on;
      if (touchUi) touchUi.btn.interact.classList.toggle('on', !!on);
    },
    onModeChange(listener) {
      modeListeners.push(listener);
    },
    describeMode() {
      return input.mode === 'touch'
        ? t('input.touch')
        : input.device === 'pad'
          ? t('input.pad')
          : input.mode === 'drag'
            ? t('input.drag')
            : input.locked
              ? t('input.locked')
              : t('input.click');
    }
  };

  function setMode(mode: LookMode): void {
    if (input.mode !== mode) {
      input.mode = mode;
      for (const listener of modeListeners) {
        try {
          listener(mode);
        } catch (err) {
          console.error(err);
        }
      }
    }
  }

  /** Marks `action` as held / released by `source`; an action stays held while any source holds it. */
  function setSource(
    source: InputSource,
    action: string | null | undefined,
    isDown: boolean
  ): void {
    if (!action) return;
    const set = sources[source];
    if (isDown) {
      if (set.has(action)) return;
      set.add(action);
      if (!held.has(action)) {
        held.add(action);
        pressedThisFrame.add(action);
      }
    } else {
      if (!set.delete(action)) return;
      if (
        !sources.key.has(action) &&
        !sources.mouse.has(action) &&
        !sources.touch.has(action) &&
        !sources.pad.has(action)
      ) {
        held.delete(action);
      }
    }
  }

  function releaseAll(): void {
    for (const name in sources) sources[name as InputSource].clear();
    held.clear();
    mouseButtons = 0;
    adsToggled = false;
    if (touchUi) {
      touchUi.btn.ads.classList.remove('active');
      resetStick();
      lookTouchId = -1;
      fireTouchId = -1;
    }
  }

  addEventListener('keydown', (event) => {
    const action = KEY_BINDINGS[event.code];
    if (!action) return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
    )
      return;
    if (
      target &&
      target.tagName === 'BUTTON' &&
      (event.code === 'Space' || event.code === 'Enter' || event.code === 'NumpadEnter')
    )
      return;
    if (
      gameplayOn &&
      (event.code === 'Space' || event.code.startsWith('Arrow') || event.code === 'ControlLeft')
    ) {
      event.preventDefault();
    }
    if (!event.repeat) {
      setDevice('kbm');
      setSource('key', action, true);
    }
  });
  addEventListener('keyup', (event) => {
    setSource('key', KEY_BINDINGS[event.code], false);
  });
  addEventListener('blur', () => {
    releaseAll();
  });

  const mouseButtonAction = (button: number): string | null =>
    button === 0 ? 'fire' : button === 2 ? 'ads' : button === 1 ? 'melee' : null;
  // QA (`?qa=`): automation that only dispatches an untrusted `click` (no mousedown) fires a
  // short burst, so weapon -> combat -> enemy hits can be exercised without a real mouse.
  let qaFireT = 0;
  if (game.params.qa) {
    canvas.addEventListener('click', (event) => {
      if (!event.isTrusted && gameplayOn) qaFireT = 0.2;
    });
  }
  canvas.addEventListener('mousedown', (event) => {
    // Ignore the synthetic mouse events that follow a touch.
    if (input.touch && performance.now() - lastTouchAt < 800) return;
    if (!gameplayOn) return;
    setDevice('kbm');
    if (!input.locked && input.mode === 'lock') requestLock();
    mouseButtons |= 1 << event.button;
    setSource('mouse', mouseButtonAction(event.button), true);
    event.preventDefault();
  });
  addEventListener('mouseup', (event) => {
    mouseButtons &= ~(1 << event.button);
    setSource('mouse', mouseButtonAction(event.button), false);
  });

  let lastWheelAt = 0;
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!gameplayOn) return;
      event.preventDefault();
      const now = performance.now();
      if (now - lastWheelAt < 280 || Math.abs(event.deltaY) < 1) return;
      lastWheelAt = now;
      pressedThisFrame.add('swap');
    },
    {
      passive: false
    }
  );
  addEventListener('contextmenu', (event) => {
    if (event.target === canvas || gameplayOn) event.preventDefault();
  });
  addEventListener('mousemove', (event) => {
    if (!gameplayOn) return;
    if (!input.locked) {
      pointerX = event.clientX / Math.max(1, innerWidth);
      pointerY = event.clientY / Math.max(1, innerHeight);
      pointerInside = true;
    }
    if (input.touch && !input.locked) return;
    const dx = event.movementX || 0;
    const dy = event.movementY || 0;
    // Some browsers report huge jumps right after locking.
    if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return;
    if (dx || dy) setDevice('kbm');
    input.look.dx += dx * MOUSE_LOOK_SCALE * input.sensitivity;
    input.look.dy += dy * MOUSE_LOOK_SCALE * input.sensitivity * (input.invertY ? -1 : 1);
  });
  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
    if (input.locked) {
      lockEverSucceeded = true;
      lockRequestedAt = 0;
      lockFailures = 0;
      if (!input.touch) setMode('lock');
    } else {
      sources.mouse.clear();
      held.delete('fire');
      held.delete('ads');
      for (const action of sources.key) held.add(action);
      mouseButtons = 0;
    }
    game.events.emit('input:lock', {
      locked: input.locked
    });
  });
  document.addEventListener('pointerlockerror', () => onLockFailed());

  /** Last mouse position (0..1) for screen-edge turning in drag mode. */
  let pointerX = 0.5;
  let pointerY = 0.5;
  let pointerInside = false;
  document.addEventListener('mouseleave', () => {
    pointerInside = false;
  });

  function onLockFailed(): void {
    lockRequestedAt = 0;
    if (!(input.locked || input.touch)) {
      lockFailures++;
      if (!lockEverSucceeded) setMode('drag');
    }
  }

  function requestLock(): void {
    if (input.touch || input.locked) return;
    if (!canvas.requestPointerLock) {
      onLockFailed();
      return;
    }
    try {
      lockRequestedAt = performance.now();
      const result: Promise<void> | undefined = canvas.requestPointerLock();
      if (result && result.catch) result.catch(() => onLockFailed());
    } catch {
      onLockFailed();
    }
    try {
      canvas.focus({
        preventScroll: true
      });
    } catch {}
  }

  function exitLock(): void {
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {}
  }

  let touchUi: TouchUi | null = null;
  let lastTouchAt = 0;
  let stickTouchId = -1;
  let stickOriginX = 0;
  let stickOriginY = 0;
  let stickX = 0;
  let stickY = 0;
  let lookTouchId = -1;
  let lookTouchX = 0;
  let lookTouchY = 0;
  let fireTouchId = -1;
  let fireTouchX = 0;
  let fireTouchY = 0;
  let adsToggled = false;

  function buildTouchUi(): TouchUi {
    const root = document.createElement('div');
    root.className = 'touch';
    root.innerHTML =
      `<div class="t-stick"><i class="t-ring"></i><i class="t-nub"></i></div><button class="t-btn t-fire" data-a="fire" aria-label="${t('t.fire')}"><span>${t('t.fire')}</span></button><button class="t-btn t-ads" data-a="ads" aria-label="${t('t.aim')}"><span>${t('t.aim')}</span></button><button class="t-btn t-reload" data-a="reload" aria-label="${t('t.reload')}"><span>${t('t.reload')}</span></button><button class="t-btn t-swap" data-a="swap" aria-label="${t('t.swapAria')}"><span>${t('t.swap')}</span></button><button class="t-btn t-jump" data-a="jump" aria-label="${t('t.jump')}"><span>${t('t.jump')}</span></button><button class="t-btn t-interact" data-a="interact" aria-label="${t('t.interact')}"><span>${t('t.use')}</span></button><button class="t-btn t-pause" data-a="pause" aria-label="${t('t.pause')}"><span>II</span></button>`;
    uiRoot.appendChild(root);
    const find = (selector: string) => root.querySelector<HTMLElement>(selector)!;
    const ui: TouchUi = {
      root,
      stick: find('.t-stick'),
      nub: find('.t-nub'),
      btn: {
        fire: find('.t-fire'),
        ads: find('.t-ads'),
        reload: find('.t-reload'),
        swap: find('.t-swap'),
        jump: find('.t-jump'),
        interact: find('.t-interact'),
        pause: find('.t-pause')
      }
    };
    for (const key in ui.btn) {
      const name = key as TouchButtonName;
      const button = ui.btn[name];
      button.addEventListener(
        'touchstart',
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          lastTouchAt = performance.now();
          const touch = event.changedTouches[0];
          if (name === 'ads') {
            adsToggled = !adsToggled;
            button.classList.toggle('active', adsToggled);
            return;
          }
          if (name === 'fire') {
            fireTouchId = touch.identifier;
            fireTouchX = touch.clientX;
            fireTouchY = touch.clientY;
          }
          button.classList.add('active');
          setSource('touch', name, true);
        },
        {
          passive: false
        }
      );
      const onRelease = (event: TouchEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (name !== 'ads') {
          if (name === 'fire') {
            let found = false;
            for (const touch of event.changedTouches) {
              if (touch.identifier === fireTouchId) found = true;
            }
            if (!found) return;
            fireTouchId = -1;
          }
          button.classList.remove('active');
          setSource('touch', name, false);
        }
      };
      button.addEventListener('touchend', onRelease, {
        passive: false
      });
      button.addEventListener('touchcancel', onRelease, {
        passive: false
      });
      // Dragging the FIRE button also looks around.
      button.addEventListener(
        'touchmove',
        (event) => {
          event.preventDefault();
          if (name === 'fire') {
            for (const touch of event.changedTouches) {
              if (touch.identifier === fireTouchId) {
                addTouchLook(touch.clientX - fireTouchX, touch.clientY - fireTouchY);
                fireTouchX = touch.clientX;
                fireTouchY = touch.clientY;
              }
            }
          }
        },
        {
          passive: false
        }
      );
      button.addEventListener('contextmenu', (event) => event.preventDefault());
    }
    return ui;
  }

  function addTouchLook(dx: number, dy: number): void {
    input.look.dx += dx * TOUCH_LOOK_SCALE * input.sensitivity;
    input.look.dy += dy * TOUCH_LOOK_SCALE * input.sensitivity * (input.invertY ? -1 : 1);
  }

  /** Switches to touch controls on the first touch. */
  function enableTouch(): void {
    if (input.touch) return;
    input.touch = true;
    exitLock();
    if (!touchUi) touchUi = buildTouchUi();
    touchUi.root.classList.toggle('on', gameplayOn);
    document.documentElement.classList.add('is-touch');
    setMode('touch');
    setDevice('touch');
  }

  function resetStick(): void {
    stickTouchId = -1;
    stickX = stickY = 0;
    if (touchUi) touchUi.stick.classList.remove('on');
  }

  addEventListener(
    'touchstart',
    () => {
      lastTouchAt = performance.now();
      enableTouch();
    },
    {
      passive: true,
      capture: true
    }
  );
  canvas.addEventListener(
    'touchstart',
    (event) => {
      event.preventDefault();
      if (!gameplayOn) return;
      for (const touch of event.changedTouches) {
        if (touch.clientX < innerWidth * 0.45 && stickTouchId < 0) {
          // Left side: a floating move stick appears under the thumb.
          stickTouchId = touch.identifier;
          stickOriginX = touch.clientX;
          stickOriginY = touch.clientY;
          stickX = stickY = 0;
          if (touchUi) {
            touchUi.stick.style.transform = `translate3d(${stickOriginX}px,${stickOriginY}px,0)`;
            touchUi.nub.style.transform = 'translate3d(0,0,0)';
            touchUi.stick.classList.add('on');
          }
        } else if (lookTouchId < 0) {
          lookTouchId = touch.identifier;
          lookTouchX = touch.clientX;
          lookTouchY = touch.clientY;
        }
      }
    },
    {
      passive: false
    }
  );
  canvas.addEventListener(
    'touchmove',
    (event) => {
      event.preventDefault();
      if (!gameplayOn) return;
      for (const touch of event.changedTouches) {
        if (touch.identifier === stickTouchId) {
          let dx = touch.clientX - stickOriginX;
          let dy = touch.clientY - stickOriginY;
          const dist = Math.hypot(dx, dy);
          if (dist > TOUCH_STICK_RADIUS_PX) {
            dx *= TOUCH_STICK_RADIUS_PX / dist;
            dy *= TOUCH_STICK_RADIUS_PX / dist;
          }
          stickX = dx / TOUCH_STICK_RADIUS_PX;
          stickY = -dy / TOUCH_STICK_RADIUS_PX;
          if (touchUi) {
            touchUi.nub.style.transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0)`;
          }
        } else if (touch.identifier === lookTouchId) {
          addTouchLook(touch.clientX - lookTouchX, touch.clientY - lookTouchY);
          lookTouchX = touch.clientX;
          lookTouchY = touch.clientY;
        }
      }
    },
    {
      passive: false
    }
  );
  const onCanvasTouchEnd = (event: TouchEvent) => {
    for (const touch of event.changedTouches) {
      if (touch.identifier === stickTouchId) resetStick();
      else if (touch.identifier === lookTouchId) lookTouchId = -1;
    }
  };
  canvas.addEventListener('touchend', onCanvasTouchEnd, {
    passive: false
  });
  canvas.addEventListener('touchcancel', onCanvasTouchEnd, {
    passive: false
  });

  /** Gamepad (standard mapping) button indices per action. */
  const PAD_ACTION_BUTTONS: Record<string, number[]> = {
    jump: [0],
    crouch: [1, 4],
    swap: [3, 12, 13],
    melee: [5, 11],
    ads: [6],
    fire: [7],
    pause: [9],
    weapon1: [14],
    weapon2: [15]
  };
  /** Gamepad button index -> menu navigation event (only while gameplay input is off). */
  const PAD_UI_BUTTONS: Record<number, UiNavEvent | undefined> = {
    0: 'accept',
    1: 'back',
    9: 'start',
    12: 'up',
    13: 'down',
    14: 'left',
    15: 'right'
  };
  let gamepadsSupported = typeof navigator < 'u' && !!navigator.getGamepads;
  let padMoveX = 0;
  let padMoveY = 0;
  let activePad: Gamepad | null = null;
  let lookBoost = 0;
  let padSprintLatched = false;
  /** What the X button does for the current press ('interact' near a relay, else 'reload'). */
  let padXAction = '';
  const padButtonState = new Uint8Array(20);
  let menuStickDirY = 0;
  let menuRepeatAt = 0;
  let menuStickDirX = 0;
  const deadzone = (value: number, zone = 0.14): number => {
    const abs = Math.abs(value);
    return abs < zone ? 0 : (Math.sign(value) * (abs - zone)) / (1 - zone);
  };
  const isButtonDown = (button: GamepadButton | undefined): boolean =>
    !!button && (button.pressed || button.value > 0.35);

  addEventListener('gamepadconnected', (event) => {
    gamepadsSupported = true;
    input.padName = (event.gamepad && event.gamepad.id) || 'gamepad';
    game.events.emit('input:pad', {
      connected: true,
      name: input.padName
    });
  });
  addEventListener('gamepaddisconnected', () => {
    game.events.emit('input:pad', {
      connected: false
    });
  });

  /** First connected standard-mapping pad, else the first usable one. */
  function findGamepad(): Gamepad | null {
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      gamepadsSupported = false;
      return null;
    }
    let fallback: Gamepad | null = null;
    for (let i = 0; pads && i < pads.length; i++) {
      const pad = pads[i];
      if (!(!pad || !pad.connected || pad.buttons.length < 10 || pad.axes.length < 4)) {
        if (pad.mapping === 'standard') return pad;
        if (!fallback) fallback = pad;
      }
    }
    return fallback;
  }

  function disconnectPad(): void {
    input.gamepad = false;
    activePad = null;
    padSprintLatched = false;
    padXAction = '';
    padButtonState.fill(0);
    for (const action of [...sources.pad]) setSource('pad', action, false);
    if (input.device === 'pad') setDevice('kbm');
  }

  function pollGamepad(dt: number): void {
    padMoveX = padMoveY = 0;
    uiPressedSet.clear();
    if (!gamepadsSupported) return;
    const pad = findGamepad();
    if (!pad) {
      if (input.gamepad) disconnectPad();
      return;
    }
    activePad = pad;
    input.gamepad = true;
    const leftX = deadzone(pad.axes[0] || 0);
    const leftY = deadzone(pad.axes[1] || 0);
    const rightX = deadzone(pad.axes[2] || 0);
    const rightY = deadzone(pad.axes[3] || 0);
    let active = !!(leftX || leftY || rightX || rightY);
    padMoveX = leftX;
    padMoveY = -leftY;
    if (gameplayOn) {
      const magnitude = Math.min(1, Math.hypot(rightX, rightY));
      // Holding the stick at full tilt ramps up a turn boost.
      lookBoost =
        magnitude > 0.92
          ? Math.min(1, lookBoost + dt / PAD_LOOK_BOOST_RAMP_SECS)
          : Math.max(0, lookBoost - dt * 6);
      const curve =
        magnitude > 0
          ? (0.25 * magnitude + 0.75 * magnitude * magnitude * magnitude) / magnitude
          : 0;
      const rate =
        PAD_LOOK_RATE *
        (1 + (PAD_LOOK_BOOST_MULT - 1) * lookBoost) *
        curve *
        input.assist *
        input.sensitivity *
        dt;
      input.look.dx += rightX * rate;
      input.look.dy += rightY * rate * 0.62 * (input.invertY ? -1 : 1);
      if (isButtonDown(pad.buttons[10])) padSprintLatched = true;
      if (padMoveY < 0.55) padSprintLatched = false;
    } else {
      padSprintLatched = false;
    }
    for (let b = 0; b < pad.buttons.length && b < 20; b++) {
      const down = isButtonDown(pad.buttons[b]) ? 1 : 0;
      if (down && !padButtonState[b]) {
        active = true;
        const uiEvent = PAD_UI_BUTTONS[b];
        if (!gameplayOn && uiEvent) uiPressedSet.add(uiEvent);
      }
      padButtonState[b] = down;
    }
    const xDown = isButtonDown(pad.buttons[2]);
    if (xDown && !padXAction) padXAction = promptOn ? 'interact' : 'reload';
    setSource('pad', 'interact', xDown && padXAction === 'interact');
    setSource('pad', 'reload', xDown && padXAction === 'reload');
    if (!xDown) padXAction = '';
    for (const action in PAD_ACTION_BUTTONS) {
      const buttons = PAD_ACTION_BUTTONS[action];
      let down = false;
      for (let j = 0; j < buttons.length; j++) {
        if (isButtonDown(pad.buttons[buttons[j]])) down = true;
      }
      setSource('pad', action, down);
    }
    setSource('pad', 'sprint', padSprintLatched);
    if (!gameplayOn) {
      // Left stick navigates menus, with key-repeat style timing.
      const dirY = Math.abs(leftY) > 0.6 ? Math.sign(leftY) : 0;
      const now = performance.now();
      if (dirY !== menuStickDirY) {
        menuStickDirY = dirY;
        menuRepeatAt = now + 380;
        if (dirY) uiPressedSet.add(dirY < 0 ? 'up' : 'down');
      } else if (dirY && now > menuRepeatAt) {
        menuRepeatAt = now + 170;
        uiPressedSet.add(dirY < 0 ? 'up' : 'down');
      }
      const dirX = Math.abs(leftX) > 0.6 ? Math.sign(leftX) : 0;
      if (dirX !== menuStickDirX) {
        menuStickDirX = dirX;
        if (dirX) uiPressedSet.add(dirX < 0 ? 'left' : 'right');
      }
    }
    if (active) setDevice('pad');
  }

  function rumble(strong = 0.5, weak = 0.5, durationMs = 80): void {
    if (input.device !== 'pad' || !activePad) return;
    try {
      const actuator = activePad.vibrationActuator;
      if (actuator && actuator.playEffect) {
        const result = actuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration: durationMs,
          strongMagnitude: Math.min(1, strong),
          weakMagnitude: Math.min(1, weak)
        });
        if (result && result.catch) result.catch(() => {});
      }
    } catch {}
  }

  function update(dt: number): void {
    pollGamepad(dt);
    // A lock request that never resolved counts as a failure.
    if (lockRequestedAt && performance.now() - lockRequestedAt > 1200 && !input.locked) {
      onLockFailed();
    }
    if (
      gameplayOn &&
      pointerInside &&
      !input.locked &&
      !input.touch &&
      input.device === 'kbm' &&
      (input.mode === 'drag' || lockRequestedAt === 0)
    ) {
      // Without pointer lock, resting the mouse near a screen edge keeps turning.
      const edgeX =
        pointerX < 0.12
          ? -(0.12 - pointerX) / 0.12
          : pointerX > 0.88
            ? (pointerX - 0.88) / 0.12
            : 0;
      const edgeY =
        pointerY < 0.1 ? -(0.1 - pointerY) / 0.1 : pointerY > 0.9 ? (pointerY - 0.9) / 0.1 : 0;
      input.look.dx += edgeX * 2.4 * dt * input.sensitivity;
      input.look.dy += edgeY * 1.2 * dt * input.sensitivity * (input.invertY ? -1 : 1);
    }
    let moveX = 0;
    let moveY = 0;
    let sprint = false;
    if (gameplayOn) {
      moveX = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      moveY = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0);
      sprint = held.has('sprint');
      if (stickTouchId >= 0) {
        moveX += stickX;
        moveY += stickY;
        if (Math.hypot(stickX, stickY) > 0.93 && stickY > 0.8) sprint = true;
      }
      moveX += padMoveX;
      moveY += padMoveY;
      const length = Math.hypot(moveX, moveY);
      if (length > 1) {
        moveX /= length;
        moveY /= length;
      }
      const turnX = (held.has('turnR') ? 1 : 0) - (held.has('turnL') ? 1 : 0);
      const turnY = (held.has('turnD') ? 1 : 0) - (held.has('turnU') ? 1 : 0);
      if (turnX) input.look.dx += turnX * KEY_TURN_RATE * dt;
      if (turnY) input.look.dy += turnY * KEY_TURN_RATE * 0.6 * dt;
    }
    input.move.x = moveX;
    input.move.y = moveY;
    if (qaFireT > 0) qaFireT -= dt;
    input.fire = gameplayOn && (held.has('fire') || qaFireT > 0);
    input.ads = gameplayOn && (held.has('ads') || adsToggled);
    input.sprint = gameplayOn && sprint;
    input.crouch = gameplayOn && held.has('crouch');
  }

  function endFrame(): void {
    pressedThisFrame.clear();
    input.look.dx = 0;
    input.look.dy = 0;
  }
  return input;
}
