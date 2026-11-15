// WebAudio engine: renders the procedural sounds (boot set synchronously, the rest incrementally
// in the background), owns the mixer graph (buses, ducking, convolution reverbs, compressor,
// clipper), voice pools, spatial loops, ambience, enemy loop tracking and the music director,
// and maps game events to sounds. Also contains an offline self-test render for QA.
import type { Game } from '../core/types';
import type { MusicDirector } from './musicDirector';
import { EVENT_SOUND_ALIASES, SOUNDS, synthSound, synthSoundIncremental } from './soundTable';
import type { IncrementalSound, RenderedSound, SoundDef } from './soundTable';
import {
  MIX,
  createMusicDirector,
  makeClipperCurve,
  masterPreGain,
  tailGainForShotGap
} from './musicDirector';
import type { WeaponMix } from './musicDirector';

/** A plain 3D point. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Sound position: `[x, y, z]` or an `{x, y, z}` object (missing components are 0). */
export type Vec3Input = readonly [number, number, number] | Partial<Vec3Like>;

/** Mixer bus names. */
export type AudioBusName = 'world' | 'near' | 'gun' | 'tail' | 'amb' | 'dry' | 'music';

/** Buses that own a pool of one-shot voices. */
type VoicePoolName = 'world' | 'near' | 'gun' | 'tail' | 'dry' | 'music';

/** Options for a one-shot sound. */
export interface PlayOptions {
  /** Variant index (default: round-robin with random skips). */
  variant?: number;
  gain?: number;
  pitch?: number;
  /** Random pitch spread (default 0.035). */
  jitter?: number;
  /** World position (world-bus sounds are spatialized when given). */
  pos?: Vec3Input | null;
  /** Panner reference distance override. */
  ref?: number;
  /** Panner rolloff override. */
  roll?: number;
  /** Start delay (s). */
  delay?: number;
  /** Surface name, remaps generic impact/step sounds. */
  surface?: string;
  /** Drop the sound instead of deferring it when not rendered yet. */
  noDefer?: boolean;
}

/** Options for a looping sound. */
export interface LoopOptions {
  /** Initial target gain (default 1). */
  gain?: number;
  pitch?: number;
  /** World position: spatializes the loop. */
  pos?: Vec3Input;
  hrtf?: boolean;
  /** Gain smoothing rate (1/s, default 6). */
  fade?: number;
  bus?: AudioBusName;
  ref?: number;
  roll?: number;
  /** Start offset into the loop (default random). */
  offset?: number;
  /** Internal: created by the engine's own enemy tracker. */
  _auto?: boolean;
}

/** Control handle of a looping sound. */
export interface LoopHandle {
  setPos(pos: Vec3Input): void;
  setGain(gain: number): void;
  setPitch(pitch: number): void;
  /** Fades out over `fade` seconds (default 0.18) and releases the loop. */
  stop(fade?: number): void;
  alive?: boolean;
}

/** A voice slot of a one-shot pool. */
export interface AudioChannel {
  g: GainNode;
  pan: PannerNode | null;
  src: AudioBufferSourceNode | null;
  /** Context time it stops sounding. */
  end: number;
  start: number;
  name: string;
  pri: number;
}

/** Engine diagnostics. */
export interface AudioEngineDebug {
  state: string;
  sampleRate: number;
  buffers: number;
  queued: number;
  genMs: number;
  bootMs: number;
  voices: number;
  loops: number;
  tracked: number;
  music: boolean;
  score: ReturnType<MusicDirector['debug']>;
  intensity: number;
  interior: number;
  gameState: string;
  reverb: [boolean, boolean];
}

/** Options of the offline self-test render. */
export interface AudioSelfTestOptions {
  seconds?: number;
  /** Place the listener inside the shed. */
  interior?: boolean;
  /** Only weapon fire, no impacts/enemies (forces intensity 1). */
  bare?: boolean;
}

/** Loudness report of the offline self-test render. */
export interface AudioSelfTestReport {
  interior: boolean;
  renderMs: number;
  steps: number;
  peak: number;
  /** Samples at or above full scale. */
  over: number;
  nan: number;
  /** RMS per half second (dB). */
  rmsDb: number[];
  shotPeakDb: number[];
  shotRmsDb: number[];
  bodyRmsDb: number[];
  troughDb: number[];
  bedRmsDb: number;
  inst: AudioEngineDebug;
}

/**
 * `game.audio`: the members every implementation (engine, silent fallback, boot stub) provides,
 * plus the optional ones only the real engine has.
 */
export interface AudioSystem {
  silent?: boolean;
  stub?: true;
  /** Per-frame update (seconds). */
  update(dt: number): void;
  /** Resumes the audio context (call from a user gesture). */
  resume(): void;
  /** Plays a one-shot sound or event alias; the engine returns whether a voice started. */
  play(name: string, opts?: PlayOptions): boolean | void;
  loop(name: string, opts?: LoopOptions): LoopHandle;
  /** Minimum music intensity 0..1. */
  setIntensity(intensity: number): void;
  setInterior(interior: number): void;
  setVolume(volume: number): void;
  /** Turns the background music on or off (off by default; fades). */
  setMusic?(on: boolean): void;
  setPaused(paused: boolean): void;
  debug?(): Partial<AudioEngineDebug> & { state: string };
  names?: string[];
  ready?: Promise<void>;
}

/** The real WebAudio engine. */
export interface AudioEngine extends AudioSystem {
  ctx: AudioContext | OfflineAudioContext;
  play(name: string, opts?: PlayOptions): boolean;
  loop(name: string, opts?: LoopOptions): LoopHandle;
  ready: Promise<void>;
  selfTest(opts?: AudioSelfTestOptions): Promise<AudioSelfTestReport>;
  music: MusicDirector;
  names: string[];
  /** Derive music intensity from combat activity (debug toggle). */
  autoIntensity: boolean;
  /** Smoothed music intensity (snapshot copied at creation by `Object.assign`). */
  readonly intensity: number;
  /** Smoothed interior amount (snapshot copied at creation by `Object.assign`). */
  readonly interior: number;
  debug(): AudioEngineDebug;
}

/** Event payload fields the audio engine reads (all optional, per event). */
export interface AudioEventPayload {
  weapon?: string;
  phase?: string;
  partial?: boolean;
  to?: string;
  from?: string;
  surface?: string;
  pos?: Partial<Vec3Like> | null;
  point?: Partial<Vec3Like> | null;
  dir?: Vec3Like | null;
  enemy?: AudioEnemyLike | null;
  part?: string;
  sprint?: boolean;
  speed?: number;
  amount?: number;
  type?: string;
  crash?: boolean;
  time?: number;
  melee?: boolean;
  size?: number;
  intensity?: number;
  state?: string;
  id?: string | number;
  index?: number;
}

/** What the engine needs to know about an enemy. */
export interface AudioEnemyLike {
  type?: string;
  alive?: boolean;
  pos?: Vec3Like | null;
}

/** The subset of `Game` the engine uses (the self-test passes a fake one). */
export interface AudioHost {
  events?: {
    on(event: string, handler: (payload: AudioEventPayload) => void): unknown;
  } | null;
  game?: { state?: string } | null;
  camera?: { matrixWorld?: { elements: ArrayLike<number> } } | null;
  enemies?: { list?: readonly AudioEnemyLike[] } | null;
  level?: {
    interiorBoxes?: readonly ({ min?: Vec3Like; max?: Vec3Like } | null)[];
    objectives?: readonly ({ id?: string | number; pos?: Vec3Like } | null)[];
  } | null;
  ground?: { isPuddle?(x: number, z: number): boolean; readonly rainLevel?: number } | null;
}

/** Narrows a position to its `[x, y, z]` tuple form. */
const isVec3Tuple = (pos: Vec3Input | null | undefined): pos is readonly [number, number, number] =>
  Array.isArray(pos);

const clampAudio = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const IMPACT_SOUND_BY_SURFACE: Record<string, string> = {
  metal: 'impact_metal',
  concrete: 'impact_concrete',
  wood: 'impact_wood',
  water: 'impact_water',
  glass: 'impact_glass',
  dirt: 'impact_concrete',
  rubber: 'impact_wood'
};

/**
 * Recorded human footsteps (CC0 "Fantozzi's Footsteps", stone set; public/audio/steps, see
 * LICENSE.txt) that replace the synthesized variants once loaded. There are only two kinds of
 * footstep in the game: this one for people (player and guards, on every surface) and the
 * synthesized `hound_step` for the robot dog. Variant v uses files[v % length].
 */
const HUMAN_STEP_FILES = ['step_0', 'step_1', 'step_2', 'step_3', 'step_4', 'step_5'];
const SAMPLE_OVERRIDES: Record<string, string[]> = {
  step_concrete: HUMAN_STEP_FILES,
  guard_step: HUMAN_STEP_FILES
};
const SAMPLE_BASE = `${(import.meta.env && import.meta.env.BASE_URL) || '/'}audio/steps/`;

/**
 * Background ambience levels (1 = the original mix). Kept low so the port is a quiet bed
 * under the fight: the sea and gulls at about a third, other distant events fainter still.
 */
const AMBIENT_MIX = { sea: 0.35, gull: 0.3, distant: 0.35 };

/** Sounds that, if not rendered yet, play once ready (within 2.5 s) instead of rendering inline. */
const PLAY_WHEN_READY_SOUNDS: ReadonlySet<string> = new Set([
  'thunder',
  'foghorn',
  'objective',
  'complete',
  'death',
  'mus_cell',
  'mus_horn',
  'mus_fill',
  'mus_hit',
  'mus_riser',
  'mus_impact',
  'explosion',
  'explosion_big',
  'rifle_tail_out',
  'rifle_tail_in',
  'pistol_tail_out',
  'pistol_tail_in',
  'gull_die',
  'hound_die',
  'relay_cut',
  'container_bang',
  'ear_ring'
]);

/** Background synthesis priority (remaining sounds follow in table order). */
const SYNTH_ORDER: readonly string[] = [
  'rifle_tail_out',
  'rifle_tail_in',
  'ir_outdoor',
  'ir_shed',
  'pistol_shot',
  'pistol_tail_out',
  'pistol_tail_in',
  'reload_magout',
  'reload_maginsert',
  'reload_magin',
  'reload_boltback',
  'reload_bolt',
  'pistol_dry',
  'pistol_magout',
  'pistol_maginsert',
  'pistol_magin',
  'pistol_slide',
  'weapon_holster',
  'weapon_draw',
  'gear_rustle',
  'shell_bounce',
  'shell_bounce_metal',
  'rain',
  'whiz',
  'impact_concrete',
  'impact_metal',
  'land',
  'jump',
  'hurt',
  'explosion',
  'explosion_big',
  'music_drone',
  'mus_cell',
  'wind',
  'impact_enemy',
  'impact_wood',
  'impact_water',
  'impact_glass',
  'ricochet',
  'gull_rotor',
  'hound_servo',
  'alert',
  'telegraph',
  'gull_fire',
  'hound_fire',
  'hound_step',
  'ui_click',
  'ui_hover',
  'sea',
  'rain_interior',
  'relay_hum',
  'gull_die',
  'hound_die',
  'ear_ring',
  'death',
  'mus_hit',
  'music_strings',
  'music_pulse',
  'music_ticks',
  'relay_cut',
  'objective',
  'mus_riser',
  'mus_impact',
  'music_drums',
  'music_brass',
  'mus_fill',
  'mus_horn',
  'thunder',
  'music_lift',
  'complete',
  'gull_cry',
  'halyard',
  'foghorn',
  'container_bang'
];

/** No-op audio used when WebAudio is unavailable. */
function createSilentAudio(): AudioSystem {
  const noop = () => {};
  const deadLoop: LoopHandle = {
    setPos: noop,
    setGain: noop,
    setPitch: noop,
    stop: noop
  };
  return {
    silent: true,
    update: noop,
    resume: noop,
    play: noop,
    loop: () => deadLoop,
    setIntensity: noop,
    setInterior: noop,
    setVolume: noop,
    setPaused: noop,
    debug: () => ({
      state: 'none'
    }),
    names: Object.keys(SOUNDS),
    ready: Promise.resolve()
  };
}

/** Creates the audio engine for the game (or a silent fallback without WebAudio). */
export async function createAudioEngine(game: Game): Promise<AudioSystem> {
  const AudioContextCtor =
    typeof window < 'u' &&
    (window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  let ctx: AudioContext | null = null;
  try {
    if (AudioContextCtor) {
      ctx = new AudioContextCtor({
        latencyHint: 'interactive'
      });
    }
  } catch {
    ctx = null;
  }
  if (ctx) return initAudioEngine(game, ctx, null);
  console.warn('[audio] WebAudio unavailable \u2014 running silent');
  return createSilentAudio();
}

/** A sound variant waiting for background synthesis. */
interface SynthJob {
  name: string;
  v: number;
  /** Buffer key `name#variant`. */
  k: string;
  steps: IncrementalSound | null;
}

/** Internal state of a looping sound. */
interface LoopVoice extends LoopHandle {
  name: string;
  alive: boolean;
  /** Voice-limit target / current (0 or 1, for the nearest-N enemy loops). */
  vT: number;
  vC: number;
  px: number;
  py: number;
  pz: number;
  /** Gain target / current. */
  gT: number;
  gC: number;
  /** Pitch target / current. */
  pT: number;
  pC: number;
  src: AudioBufferSourceNode | null;
  g: GainNode;
  pan: PannerNode | null;
  /** Gain smoothing rate. */
  rate: number;
  /** Distance to the listener (enemy loops). */
  d?: number;
}

/** Engine-side tracking of an enemy for its automatic rotor/servo loop. */
interface EnemyTracker {
  h: LoopHandle | null;
  type: 'hound' | 'gull';
  /** Last position. */
  lx: number;
  ly: number;
  lz: number;
  /** Smoothed speed. */
  sp: number;
  /** Distance to the listener. */
  d: number;
  /** Per-enemy pitch factor. */
  tune: number;
}

/** Hum loop of an objective relay. */
interface RelayHum {
  id: string | number | undefined;
  index: number;
  pos: Vec3Like;
  h: LoopHandle;
}

/** Event bus used by the self-test's fake host. */
interface SelfTestBus {
  on(event: string, handler: (payload: AudioEventPayload) => void): void;
  emit(event: string, payload: AudioEventPayload): void;
}

/**
 * Builds the engine on `ctx`. `shared` is set for the offline self-test: it reuses the live
 * engine's rendered buffers and treats the context as always running.
 */
function initAudioEngine(
  host: AudioHost,
  ctx: AudioContext | OfflineAudioContext,
  shared: { bufs: Map<string, AudioBuffer> } | null
): AudioEngine {
  const events = host.events;
  const rng = Math.random;
  const isRunning = () => (shared ? true : ctx.state === 'running');
  const buffers: Map<string, AudioBuffer> = shared ? shared.bufs : new Map();
  const readyCallbacks = new Map<string, ((buffer: AudioBuffer) => void)[]>();
  let genMs = 0;
  let bufferCount = 0;
  let bootMs = 0;

  /** Stores a rendered sound as an AudioBuffer and fires pending ready callbacks. */
  function storeBuffer(key: string, rendered: RenderedSound): AudioBuffer {
    const buffer = ctx.createBuffer(rendered.ch.length, rendered.ch[0].length, rendered.sr);
    for (let ch = 0; ch < rendered.ch.length; ch++) {
      buffer.getChannelData(ch).set(rendered.ch[ch]);
    }
    buffers.set(key, buffer);
    bufferCount++;
    const callbacks = readyCallbacks.get(key);
    if (callbacks) {
      readyCallbacks.delete(key);
      for (const callback of callbacks) {
        try {
          callback(buffer);
        } catch (error) {
          console.error('[audio] ready callback', error);
        }
      }
    }
    return buffer;
  }
  /** Impulse responses render at the context rate; everything else at its table rate. */
  const renderRateFor = (name: string) => (SOUNDS[name].ir ? ctx.sampleRate : undefined);
  /** Renders a variant synchronously. */
  function renderNow(name: string, variant: number): AudioBuffer {
    const startedAt = performance.now();
    // synthSound only returns null for unknown names; callers pass table names.
    const buffer = storeBuffer(
      name + '#' + variant,
      synthSound(name, variant, renderRateFor(name))!
    );
    genMs += performance.now() - startedAt;
    return buffer;
  }
  const queue: SynthJob[] = [];
  const seen = new Set<string>();
  for (const name of [...SYNTH_ORDER, ...Object.keys(SOUNDS)]) {
    const def = SOUNDS[name];
    if (!(!def || seen.has(name))) {
      seen.add(name);
      for (let variant = 0; variant < def.n; variant++) {
        if (!buffers.has(name + '#' + variant)) {
          if (def.boot) renderNow(name, variant);
          else {
            queue.push({
              name,
              v: variant,
              k: name + '#' + variant,
              steps: null
            });
          }
        }
      }
    }
  }
  bootMs = genMs;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  /** Background synthesis: works ~6 ms per slice, every 12 ms, until the queue is empty. */
  function pumpQueue(): void {
    const sliceStart = performance.now();
    while (queue.length) {
      const job = queue[0];
      if (buffers.has(job.k)) {
        queue.shift();
        continue;
      }
      if (!job.steps) job.steps = synthSoundIncremental(job.name, job.v, renderRateFor(job.name));
      let rendered: RenderedSound | null = null;
      try {
        // A null `steps` throws here and is reported like any synthesis failure.
        rendered = job.steps!.step();
      } catch (error) {
        console.error('[audio] synthesis failed for ' + job.k, error);
        queue.shift();
        continue;
      }
      if (rendered) {
        storeBuffer(job.k, rendered);
        queue.shift();
      }
      if (performance.now() - sliceStart > 6) break;
    }
    genMs += performance.now() - sliceStart;
    if (queue.length) setTimeout(pumpQueue, 12);
    else resolveReady();
  }
  if (shared) resolveReady();
  else setTimeout(pumpQueue, 120);

  /** Fetches the recorded samples and swaps them in for the synthesized variants. */
  async function loadSampleOverrides(): Promise<void> {
    const decoded = new Map<string, Promise<AudioBuffer | null>>();
    let swapped = 0;
    const load = (file: string) => {
      let pending = decoded.get(file);
      if (!pending) {
        pending = fetch(SAMPLE_BASE + file + '.wav')
          .then((response) => {
            if (!response.ok) throw new Error(response.status + ' ' + file);
            return response.arrayBuffer();
          })
          .then((data) => ctx.decodeAudioData(data))
          .catch((error: unknown) => {
            console.warn('[audio] sample unavailable, keeping the synthesized one:', error);
            return null;
          });
        decoded.set(file, pending);
      }
      return pending;
    };
    await Promise.all(
      Object.entries(SAMPLE_OVERRIDES).map(async ([name, files]) => {
        const def = SOUNDS[name];
        if (!def) return;
        for (let variant = 0; variant < def.n; variant++) {
          const source = await load(files[variant % files.length]);
          if (!source) continue;
          // Copy and normalise to the table peak so the mix matches the synthesized set.
          const buffer = ctx.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
          let peak = 0;
          for (let ch = 0; ch < source.numberOfChannels; ch++) {
            const data = source.getChannelData(ch);
            for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
          }
          const scale = peak > 0 ? (def.peak || 0.5) / peak : 1;
          for (let ch = 0; ch < source.numberOfChannels; ch++) {
            const from = source.getChannelData(ch);
            const to = buffer.getChannelData(ch);
            for (let i = 0; i < from.length; i++) to[i] = from[i] * scale;
          }
          buffers.set(name + '#' + variant, buffer);
          swapped++;
        }
      })
    );
    if (swapped) console.log(`[audio] recorded footsteps: ${swapped} variants`);
  }
  if (!shared) void loadSampleOverrides();
  /** Calls `callback` once `name#variant` exists, moving it to the front of the queue. */
  function whenReady(name: string, variant: number, callback: (buffer: AudioBuffer) => void): void {
    const key = name + '#' + variant;
    const existing = buffers.get(key);
    if (existing) {
      callback(existing);
      return;
    }
    if (!readyCallbacks.has(key)) readyCallbacks.set(key, []);
    readyCallbacks.get(key)!.push(callback);
    const index = queue.findIndex((job) => job.k === key);
    if (index > 0 && !queue[index].steps) {
      const [job] = queue.splice(index, 1);
      queue.splice(queue[0] && queue[0].steps ? 1 : 0, 0, job);
    }
  }

  // --- Mixer graph ---
  const makeGain = (value: number) => {
    const gain = ctx.createGain();
    gain.gain.value = value;
    return gain;
  };
  const mainIn = makeGain(1);
  const compressor = ctx.createDynamicsCompressor();
  const preClip = makeGain(masterPreGain());
  const clipper = ctx.createWaveShaper();
  const master = makeGain(MIX.master);
  compressor.threshold.value = MIX.comp.threshold;
  compressor.knee.value = MIX.comp.knee;
  compressor.ratio.value = MIX.comp.ratio;
  compressor.attack.value = MIX.comp.attack;
  compressor.release.value = MIX.comp.release;
  clipper.curve = makeClipperCurve();
  try {
    clipper.oversample = '2x';
  } catch {}
  mainIn.connect(compressor);
  compressor.connect(preClip);
  preClip.connect(clipper);
  clipper.connect(master);
  master.connect(ctx.destination);
  // Muffle low-pass (hurt / death) in front of everything but the dry and music buses.
  const muffleFilter = ctx.createBiquadFilter();
  muffleFilter.type = 'lowpass';
  muffleFilter.frequency.value = 2e4;
  muffleFilter.Q.value = 0.5;
  const pauseGain = makeGain(1);
  muffleFilter.connect(pauseGain);
  pauseGain.connect(mainIn);
  const buses: Record<AudioBusName, GainNode> = {
    world: makeGain(1.25),
    near: makeGain(1.24),
    gun: makeGain(1),
    tail: makeGain(1),
    amb: makeGain(0.767),
    dry: makeGain(1.3),
    music: makeGain(MIX.musicBus)
  };
  buses.world.connect(muffleFilter);
  buses.near.connect(muffleFilter);
  buses.gun.connect(muffleFilter);
  buses.tail.connect(muffleFilter);
  buses.dry.connect(mainIn);
  const ambDuck = makeGain(1);
  const musicDuck = makeGain(1);
  const musicLevelGain = makeGain(1);
  buses.amb.connect(ambDuck);
  ambDuck.connect(muffleFilter);
  buses.music.connect(musicLevelGain);
  musicLevelGain.connect(musicDuck);
  musicDuck.connect(mainIn);
  /** Ducks ambience and music (gunshots, explosions). */
  function duck(level: number, hold?: number, release?: number): void {
    const now = ctx.currentTime;
    const duckMix = MIX.duck;
    for (const param of [ambDuck.gain, musicDuck.gain]) {
      try {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(level, now, duckMix.attack);
        param.setTargetAtTime(1, now + (hold || duckMix.hold), release || duckMix.release);
      } catch {}
    }
  }
  // Reverb sends: outdoor and shed convolvers, crossfaded by the interior amount.
  const reverbSend = makeGain(1);
  const outdoorSend = makeGain(1);
  const indoorSend = makeGain(0);
  const outdoorReverb = ctx.createConvolver();
  const shedReverb = ctx.createConvolver();
  const outdoorReturn = makeGain(0.75);
  const shedReturn = makeGain(0.95);
  const worldSend = makeGain(0.9);
  const nearSend = makeGain(0.32);
  const gunSend = makeGain(0.07);
  const musicShedSend = makeGain(0.2);
  buses.world.connect(worldSend);
  worldSend.connect(reverbSend);
  buses.near.connect(nearSend);
  nearSend.connect(reverbSend);
  buses.gun.connect(gunSend);
  gunSend.connect(reverbSend);
  reverbSend.connect(outdoorSend);
  reverbSend.connect(indoorSend);
  outdoorSend.connect(outdoorReverb);
  indoorSend.connect(shedReverb);
  outdoorReverb.connect(outdoorReturn);
  shedReverb.connect(shedReturn);
  outdoorReturn.connect(muffleFilter);
  shedReturn.connect(muffleFilter);
  buses.music.connect(musicShedSend);
  musicShedSend.connect(shedReverb);
  whenReady('ir_outdoor', 0, (buffer) => {
    outdoorReverb.buffer = buffer;
  });
  whenReady('ir_shed', 0, (buffer) => {
    shedReverb.buffer = buffer;
  });
  function setPannerPos(panner: PannerNode, x: number, y: number, z: number): void {
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else panner.setPosition(x, y, z);
  }
  function createPanner(hrtf: boolean): PannerNode {
    const panner = ctx.createPanner();
    panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 3;
    panner.rolloffFactor = 0.6;
    panner.maxDistance = 400;
    panner.coneInnerAngle = 360;
    return panner;
  }
  const pools: Record<VoicePoolName, AudioChannel[]> = {
    world: [],
    near: [],
    gun: [],
    tail: [],
    dry: [],
    music: []
  };
  function addChannel(bus: VoicePoolName, spatial: boolean): void {
    const channel: AudioChannel = {
      g: makeGain(0),
      pan: null,
      src: null,
      end: 0,
      start: 0,
      name: '',
      pri: 0
    };
    if (spatial) {
      channel.pan = createPanner(false);
      channel.g.connect(channel.pan);
      channel.pan.connect(buses[bus]);
    } else channel.g.connect(buses[bus]);
    pools[bus].push(channel);
  }
  for (let i = 0; i < 22; i++) addChannel('world', true);
  for (let i = 0; i < 12; i++) addChannel('near', false);
  for (let i = 0; i < 18; i++) addChannel('gun', false);
  for (let i = 0; i < 12; i++) addChannel('tail', false);
  for (let i = 0; i < 8; i++) addChannel('dry', false);
  for (let i = 0; i < 3; i++) addChannel('music', false);

  // --- Mix state ---
  const listenerPos: Vec3Like = {
    x: 0,
    y: 1.7,
    z: 0
  };
  let resumeRequested = false;
  let paused = false;
  let volume = 0.9;
  let gameState = (host.game && host.game.state) || 'title';
  let interiorTarget = 0;
  let interior = 0;
  /** Intensity floor set by the game (`setIntensity`). */
  let intensityFloor = 0;
  /** Combat heat derived from events (decays over time). */
  let heat = 0;
  let intensity = 0;
  /** Muffle amount (0 clear .. 1 fully low-passed). */
  let muffle = 0;
  let musicLevel = 1;
  /** Music on/off from the settings (off by default) and its faded mix level. */
  let musicOnTarget = 0;
  let musicOn = 0;
  let pauseLevel = 1;
  let ambienceLevel = 0;
  let lastShotTime = -9;
  let lastTailShot = -9;
  let currentWeapon: WeaponMix = MIX.weapon.rifle;
  let lastImpact = -9;
  let lastRicochet = -9;
  let lastEarRing = -9;
  let lastAlert = -9;
  let unusedTimer = -9;
  let lastWhiz = -9;
  const variantCounters: Record<string, number> = {};
  const weaponVariant: Record<string, number> = {
    rifle: 0,
    pistol: 0
  };
  /** Tails whose gain is still ramping up after a fast follow-up shot. */
  const boostedTails: { ch: AudioChannel; src: AudioBufferSourceNode | null }[] = [];
  const controls = {
    autoIntensity: true
  };

  /**
   * Picks a voice slot: a free one, else steals (same-name over its `max`, else the
   * lowest priority / oldest voice if not more important than the new sound).
   */
  function pickChannel(
    pool: AudioChannel[],
    name: string,
    def: SoundDef,
    now: number
  ): AudioChannel | null {
    let free: AudioChannel | null = null;
    let sameCount = 0;
    let oldestSame: AudioChannel | null = null;
    let weakest: AudioChannel | null = null;
    for (let i = 0; i < pool.length; i++) {
      const channel = pool[i];
      if (channel.end <= now) {
        if (!free) free = channel;
        continue;
      }
      if (channel.name === name) {
        sameCount++;
        if (!oldestSame || channel.start < oldestSame.start) oldestSame = channel;
      }
      if (
        !weakest ||
        channel.pri < weakest.pri ||
        (channel.pri === weakest.pri && channel.start < weakest.start)
      ) {
        weakest = channel;
      }
    }
    if (sameCount >= (def.max || 4)) {
      if (!def.soft || !free) return oldestSame;
      // sameCount > 0 guarantees oldestSame is set.
      const victim = oldestSame!;
      try {
        victim.g.gain.cancelScheduledValues(now);
        victim.g.gain.setTargetAtTime(0, now, 0.035);
        if (victim.src) victim.src.stop(now + 0.25);
      } catch {}
      victim.end = now + 0.25;
      victim.name = '';
    }
    // `def.pri` is undefined only for loops/IRs, which never get here (undefined compares false).
    return free || (weakest && weakest.pri <= (def.pri as number) ? weakest : null);
  }
  /** Plays a one-shot; returns whether a voice was started. */
  const play = (name: string, opts?: PlayOptions): boolean => !!playSound(name, opts);
  /** Plays a one-shot and returns its voice slot (null if dropped or deferred). */
  function playSound(name: string, opts?: PlayOptions): AudioChannel | null {
    opts = opts || {};
    name = EVENT_SOUND_ALIASES[name] || name;
    if (opts.surface) {
      if (name === 'impact_concrete') name = IMPACT_SOUND_BY_SURFACE[opts.surface] || name;
    }
    const def = SOUNDS[name];
    if (!def || def.loop || def.ir || !isRunning()) return null;
    let variant = opts.variant;
    if (variant == null) {
      variant = variantCounters[name] =
        ((variantCounters[name] || 0) + 1 + (def.n > 2 && rng() < 0.3 ? 1 : 0)) % def.n;
    } else variant %= def.n;
    let buffer = buffers.get(name + '#' + variant);
    if (!buffer) {
      if (opts.noDefer && PLAY_WHEN_READY_SOUNDS.has(name)) return null;
      if (PLAY_WHEN_READY_SOUNDS.has(name)) {
        const requestedAt = ctx.currentTime;
        const deferredName = name;
        const deferredOpts = opts;
        const deferredVariant = variant;
        whenReady(name, variant, () => {
          if (ctx.currentTime - requestedAt < 2.5) {
            play(
              deferredName,
              Object.assign({}, deferredOpts, {
                variant: deferredVariant
              })
            );
          }
        });
        return null;
      }
      buffer = renderNow(name, variant);
    }
    const now = ctx.currentTime;
    const pos = opts.pos;
    const spatial = !!pos && def.bus === 'world';
    // Every one-shot in the table has a voice-pool bus.
    const pool = spatial
      ? pools.world
      : pools[(def.bus === 'world' ? 'near' : def.bus) as VoicePoolName];
    const channel = pickChannel(pool, name, def, now);
    if (!channel) return null;
    let when = now + (opts.delay || 0);
    const gainParam = channel.g.gain;
    gainParam.cancelScheduledValues(now);
    if (channel.end > now && channel.src) {
      gainParam.setTargetAtTime(0, now, 0.004);
      try {
        channel.src.stop(now + 0.025);
      } catch {}
      when = Math.max(when, now + 0.025);
    }
    const jitter = opts.jitter != null ? opts.jitter : 0.035;
    const rate = clampAudio((opts.pitch || 1) * (1 + (rng() * 2 - 1) * jitter), 0.25, 4);
    gainParam.setValueAtTime((opts.gain != null ? opts.gain : 1) * (1 - rng() * 0.08), when);
    if (spatial) {
      const point: Partial<Vec3Like> = isVec3Tuple(pos)
        ? {
            x: pos[0],
            y: pos[1],
            z: pos[2]
          }
        : pos!;
      // Spatial voices come from the 'world' pool, whose slots all have panners.
      const panner = channel.pan!;
      setPannerPos(panner, point.x || 0, point.y || 0, point.z || 0);
      panner.refDistance = opts.ref || def.ref || 3;
      panner.rolloffFactor = opts.roll != null ? opts.roll : def.roll != null ? def.roll : 0.6;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(channel.g);
    source.onended = () => {
      try {
        source.disconnect();
      } catch {}
    };
    source.start(when);
    channel.src = source;
    channel.start = when;
    channel.end = when + buffer.duration / rate + 0.03;
    channel.name = name;
    channel.pri = def.pri || 0;
    return channel;
  }

  // --- Loops ---
  const activeLoops = new Set<LoopVoice>();
  /** Enemy rotor/servo loops created by the enemy modules themselves. */
  const enemyLoops = new Set<LoopVoice>();
  const noop = () => {};
  /** Once enemies drive their own loops, the engine's automatic tracker is disabled. */
  let enemiesOwnLoops = false;
  const deadLoop: LoopHandle = {
    setPos: noop,
    setGain: noop,
    setPitch: noop,
    stop: noop,
    alive: false
  };
  /** Starts a looping sound (positional if `opts.pos`); gain/pitch are smoothed in `update`. */
  function loop(name: string, opts?: LoopOptions): LoopHandle {
    opts = opts || {};
    const def = SOUNDS[name];
    if (!def || !def.loop) return deadLoop;
    const isEnemyLoop = (name === 'gull_rotor' || name === 'hound_servo') && !opts._auto;
    if (isEnemyLoop && !opts.hrtf) {
      opts = Object.assign(
        {
          hrtf: true
        },
        opts
      );
    }
    const loopOpts = opts;
    const voice: LoopVoice = {
      name,
      alive: true,
      vT: 1,
      vC: 1,
      px: 0,
      py: 0,
      pz: 0,
      gT: loopOpts.gain != null ? loopOpts.gain : 1,
      gC: 0,
      pT: loopOpts.pitch || 1,
      pC: loopOpts.pitch || 1,
      src: null,
      g: makeGain(0),
      pan: null,
      rate: loopOpts.fade || 6,
      setPos: noop,
      setGain: noop,
      setPitch: noop,
      stop: noop
    };
    let output: AudioNode = voice.g;
    if (loopOpts.pos) {
      voice.pan = createPanner(!!loopOpts.hrtf);
      voice.pan.refDistance = loopOpts.ref || def.ref || 3;
      voice.pan.rolloffFactor =
        loopOpts.roll != null ? loopOpts.roll : def.roll != null ? def.roll : 0.6;
      voice.g.connect(voice.pan);
      output = voice.pan;
    }
    output.connect(buses[loopOpts.bus || (loopOpts.pos ? 'world' : def.music ? 'music' : 'amb')]);
    voice.setPos = (pos) => {
      if (voice.pan && pos) {
        if (isVec3Tuple(pos)) {
          voice.px = pos[0];
          voice.py = pos[1];
          voice.pz = pos[2];
        } else {
          voice.px = pos.x || 0;
          voice.py = pos.y || 0;
          voice.pz = pos.z || 0;
        }
        if (Number.isFinite(voice.px + voice.py + voice.pz)) {
          setPannerPos(voice.pan, voice.px, voice.py, voice.pz);
        }
      }
    };
    voice.setGain = (gain) => {
      voice.gT = Math.max(0, +gain || 0);
    };
    voice.setPitch = (pitch) => {
      voice.pT = clampAudio(+pitch || 1, 0.25, 4);
    };
    voice.stop = (fade) => {
      if (!voice.alive) return;
      voice.alive = false;
      activeLoops.delete(voice);
      enemyLoops.delete(voice);
      const fadeTime = fade ?? 0.18;
      const now = ctx.currentTime;
      try {
        voice.g.gain.setValueAtTime(voice.gC, now);
        voice.g.gain.linearRampToValueAtTime(0, now + fadeTime);
        if (voice.src) voice.src.stop(now + fadeTime + 0.03);
      } catch {}
      setTimeout(
        () => {
          try {
            if (voice.src) voice.src.disconnect();
            voice.g.disconnect();
            if (voice.pan) voice.pan.disconnect();
          } catch {}
        },
        (fadeTime + 0.3) * 1e3
      );
    };
    if (loopOpts.pos) voice.setPos(loopOpts.pos);
    whenReady(name, 0, (buffer) => {
      if (!voice.alive) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.playbackRate.value = voice.pC;
      source.connect(voice.g);
      source.start(0, loopOpts.offset != null ? loopOpts.offset : rng() * buffer.duration);
      voice.src = source;
    });
    activeLoops.add(voice);
    if (isEnemyLoop) {
      enemyLoops.add(voice);
      if (!enemiesOwnLoops) {
        enemiesOwnLoops = true;
        for (const enemy of [...trackedEnemies.keys()]) untrackEnemy(enemy);
      }
    }
    return voice;
  }
  const director = createMusicDirector({
    ctx,
    out: buses.music,
    bufs: buffers,
    whenReady,
    running: isRunning,
    rnd: rng
  });
  function unusedHook(): void {}

  // --- Ambience ---
  const ambienceLoops = {
    rain: loop('rain', {
      gain: 0,
      fade: 2
    }),
    rainIn: loop('rain_interior', {
      gain: 0,
      fade: 2
    }),
    wind: loop('wind', {
      gain: 0,
      fade: 2
    }),
    sea: loop('sea', {
      gain: 0,
      pos: [33, -1, 0],
      fade: 2,
      bus: 'amb'
    })
  };
  let wind = 0.4;
  let windTarget = 0.4;
  let windTimer = 2;
  /** Countdown (s) to the next distant ambient event of each kind. */
  const ambientTimers = {
    fog: 14 + rng() * 14,
    gull: 5 + rng() * 8,
    hal: 4 + rng() * 6,
    bang: 20 + rng() * 25
  };
  /** Distant foghorns, gull cries, halyard clinks and container bangs. */
  function updateAmbientEvents(dt: number, level: number): void {
    const outdoor = 1 - 0.7 * interior;
    if ((ambientTimers.fog -= dt) <= 0) {
      ambientTimers.fog = 70 + rng() * 50;
      const z = listenerPos.z + (rng() * 2 - 1) * 250;
      play('foghorn', {
        pos: [listenerPos.x + 320, 8, z],
        ref: 400,
        gain: 0.34 * AMBIENT_MIX.distant * level * outdoor,
        pitch: rng() < 0.3 ? 0.89 : 1,
        jitter: 0.01
      });
    }
    if ((ambientTimers.gull -= dt) <= 0) {
      ambientTimers.gull = 18 + rng() * 24;
      const angle = rng() * 6.283;
      const dist = 35 + rng() * 50;
      play('gull_cry', {
        pos: [
          listenerPos.x + Math.cos(angle) * dist,
          14 + rng() * 18,
          listenerPos.z + Math.sin(angle) * dist
        ],
        ref: dist,
        roll: 1,
        gain: (0.16 + rng() * 0.16) * AMBIENT_MIX.gull * level * outdoor,
        jitter: 0.1
      });
    }
    if ((ambientTimers.hal -= dt) <= 0) {
      ambientTimers.hal = 14 + rng() * 20;
      play('halyard', {
        pos: [29 + rng() * 8, 3 + rng() * 6, -8 + rng() * 32],
        ref: 16,
        roll: 0.5,
        gain: (0.3 + rng() * 0.3) * AMBIENT_MIX.distant * level * outdoor,
        jitter: 0.08
      });
    }
    if ((ambientTimers.bang -= dt) <= 0) {
      ambientTimers.bang = 50 + rng() * 50;
      const angle = 1.6 + rng() * 3.2;
      play('container_bang', {
        pos: [listenerPos.x + Math.cos(angle) * 150, 4, listenerPos.z + Math.sin(angle) * 150],
        ref: 150,
        gain: (0.2 + rng() * 0.16) * AMBIENT_MIX.distant * level * outdoor,
        jitter: 0.12
      });
    }
  }

  // --- Automatic enemy loops (used until enemies create their own) ---
  const trackedEnemies = new Map<AudioEnemyLike, EnemyTracker>();
  let trackTimer = 0;
  function trackEnemy(enemy: AudioEnemyLike | null | undefined): void {
    if (!enemy || enemiesOwnLoops || trackedEnemies.has(enemy) || enemy.alive === false) return;
    // Human guards have no motor loop.
    if (enemy.type === 'guard') return;
    trackedEnemies.set(enemy, {
      h: null,
      type: enemy.type === 'hound' ? 'hound' : 'gull',
      lx: enemy.pos ? enemy.pos.x : 0,
      ly: enemy.pos ? enemy.pos.y : 0,
      lz: enemy.pos ? enemy.pos.z : 0,
      sp: 0,
      d: 1e9,
      tune: 0.96 + rng() * 0.1
    });
  }
  function untrackEnemy(enemy: AudioEnemyLike): void {
    const tracker = trackedEnemies.get(enemy);
    if (tracker) {
      if (tracker.h) tracker.h.stop(0.12);
      trackedEnemies.delete(enemy);
    }
  }
  const nearestLoops: LoopVoice[] = [];
  const nearestTrackers: EnemyTracker[] = [];
  /** Keeps only the 6 nearest enemy loops (within 90 m) audible and follows enemy motion. */
  function updateEnemyLoops(dt: number): void {
    trackTimer -= dt;
    if (trackTimer <= 0 && enemiesOwnLoops) {
      trackTimer = 0.25;
      nearestLoops.length = 0;
      for (const voice of enemyLoops) {
        voice.d = Math.hypot(
          voice.px - listenerPos.x,
          voice.py - listenerPos.y,
          voice.pz - listenerPos.z
        );
        nearestLoops.push(voice);
      }
      // Every entry got `d` just above.
      nearestLoops.sort((a, b) => a.d! - b.d!);
      for (let i = 0; i < nearestLoops.length; i++) {
        nearestLoops[i].vT = i < 6 && nearestLoops[i].d! < 90 ? 1 : 0;
      }
    }
    if (trackTimer <= 0) {
      trackTimer = 0.25;
      const list = host.enemies && host.enemies.list;
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
          const enemy = list[i];
          if (enemy && enemy.alive !== false && !trackedEnemies.has(enemy)) trackEnemy(enemy);
        }
      }
      nearestTrackers.length = 0;
      for (const [enemy, tracker] of trackedEnemies) {
        if (enemy.alive === false || (Array.isArray(list) && list.indexOf(enemy) < 0)) {
          untrackEnemy(enemy);
          continue;
        }
        const pos = enemy.pos;
        if (pos) {
          tracker.d = Math.hypot(
            pos.x - listenerPos.x,
            pos.y - listenerPos.y,
            pos.z - listenerPos.z
          );
          nearestTrackers.push(tracker);
        }
      }
      nearestTrackers.sort((a, b) => a.d - b.d);
      for (let i = 0; i < nearestTrackers.length; i++) {
        const tracker = nearestTrackers[i];
        const audible = i < 6 && tracker.d < 90;
        if (audible && !tracker.h) {
          tracker.h = loop(tracker.type === 'gull' ? 'gull_rotor' : 'hound_servo', {
            pos: [tracker.lx, tracker.ly, tracker.lz],
            gain: 0,
            hrtf: true,
            fade: 5,
            _auto: true
          });
        } else if (!audible && tracker.h) {
          tracker.h.stop(0.25);
          tracker.h = null;
        }
      }
    }
    for (const [enemy, tracker] of trackedEnemies) {
      const pos = enemy.pos;
      if (pos) {
        if (dt > 0) {
          const speed = Math.hypot(pos.x - tracker.lx, pos.y - tracker.ly, pos.z - tracker.lz) / dt;
          tracker.sp += (Math.min(speed, 30) - tracker.sp) * Math.min(1, dt * 5);
        }
        tracker.lx = pos.x;
        tracker.ly = pos.y;
        tracker.lz = pos.z;
        if (tracker.h) {
          tracker.h.setPos(pos);
          if (tracker.type === 'gull') {
            tracker.h.setGain(1);
            tracker.h.setPitch(tracker.tune * (0.94 + 0.3 * clampAudio(tracker.sp / 10, 0, 1)));
          } else {
            const motion = clampAudio(tracker.sp / 3, 0, 1);
            tracker.h.setGain(0.3 + 0.5 * motion);
            tracker.h.setPitch(tracker.tune * (0.88 + 0.3 * motion));
          }
        }
      }
    }
  }

  // --- Objective relay hums ---
  let relayHums: RelayHum[] = [];
  function startRelayHums(): void {
    for (const hum of relayHums) hum.h.stop(0.2);
    relayHums = [];
    const objectives = host.level && host.level.objectives;
    if (Array.isArray(objectives)) {
      objectives.forEach((objective, index) => {
        if (objective && objective.pos) {
          relayHums.push({
            id: objective.id,
            index,
            pos: {
              x: objective.pos.x,
              y: (objective.pos.y || 0) + 1.2,
              z: objective.pos.z
            },
            h: loop('relay_hum', {
              pos: [objective.pos.x, (objective.pos.y || 0) + 1.2, objective.pos.z],
              gain: 0.9
            })
          });
        }
      });
    }
  }
  /** Stops the hum of a completed relay and plays the cut sound there. */
  function cutRelay(payload: AudioEventPayload): void {
    payload = payload || {};
    const target = payload;
    let index = relayHums.findIndex((hum) => target.id != null && hum.id === target.id);
    if (index < 0 && target.index != null) {
      index = relayHums.findIndex((hum) => hum.index === target.index);
    }
    if (index >= 0) {
      const hum = relayHums[index];
      hum.h.stop(0.08);
      relayHums.splice(index, 1);
      play('relay_cut', {
        pos: hum.pos,
        gain: 1
      });
    } else {
      play('relay_cut', {
        gain: 0.8
      });
    }
  }

  // --- Weapons ---
  /** `pos` if it is a usable `{x: number, ...}` point, else null. */
  const asVec3 = (value: Partial<Vec3Like> | null | undefined): Vec3Like | null =>
    value && typeof value.x == 'number' ? (value as Vec3Like) : null;
  const weaponOf = (payload: AudioEventPayload) =>
    payload && payload.weapon === 'pistol' ? 'pistol' : 'rifle';
  /** Gunshot: shot variant, outdoor/indoor tails (quieter during rapid fire) and ducking. */
  function fireWeapon(weapon: string): void {
    const weaponMix = MIX.weapon[weapon];
    const now = ctx.currentTime;
    currentWeapon = weaponMix;
    lastShotTime = now;
    weaponVariant[weapon] = (weaponVariant[weapon] + 1 + (rng() < 0.25 ? 1 : 0)) % weaponMix.n;
    playSound(weaponMix.shot, {
      variant: weaponVariant[weapon],
      gain: weaponMix.gain,
      jitter: 0.012
    });
    for (const boosted of boostedTails) {
      if (boosted.ch.src === boosted.src) {
        try {
          boosted.ch.g.gain.cancelScheduledValues(now);
        } catch {}
      }
    }
    boostedTails.length = 0;
    const interiorMix = interior;
    const gapGain = tailGainForShotGap(now - lastTailShot);
    const playTail = (name: string, level: number) => {
      if (level < 0.05) return;
      const fullGain = weaponMix.tail * level;
      const channel = playSound(name, {
        gain: fullGain * gapGain,
        jitter: 0.02,
        noDefer: true
      });
      if (channel && gapGain < 0.999) {
        try {
          channel.g.gain.setTargetAtTime(fullGain, channel.start + MIX.tailBoostAfter, 0.03);
        } catch {}
        boostedTails.push({
          ch: channel,
          src: channel.src
        });
      }
    };
    playTail(weaponMix.tailOut, Math.cos((interiorMix * Math.PI) / 2));
    playTail(weaponMix.tailIn, Math.sin((interiorMix * Math.PI) / 2));
    lastTailShot = now;
    duck(weaponMix.duck);
    if (heat > 0.3) heat = Math.min(1, heat + 0.015);
  }
  /** Subscribes to a game event; handler errors are logged. */
  const on = (event: string, handler: (payload: AudioEventPayload) => void) => {
    if (events && events.on) {
      events.on(event, (payload) => {
        try {
          handler(payload || {});
        } catch (error) {
          console.error('[audio] ' + event, error);
        }
      });
    }
  };
  on('weapon:fire', (payload) => {
    if (isRunning()) fireWeapon(weaponOf(payload));
  });
  on('weapon:dry', (payload) =>
    play(weaponOf(payload) === 'pistol' ? 'pistol_dry' : 'rifle_dry', {
      gain: 1,
      jitter: 0.02
    })
  );
  const RELOAD_SOUNDS: Record<string, Record<string, string>> = {
    rifle: {
      magout: 'reload_magout',
      maginsert: 'reload_maginsert',
      magin: 'reload_magin',
      boltback: 'reload_boltback',
      bolt: 'reload_bolt',
      slide: 'reload_bolt'
    },
    pistol: {
      magout: 'pistol_magout',
      maginsert: 'pistol_maginsert',
      magin: 'pistol_magin',
      boltback: 'pistol_slide',
      bolt: 'pistol_slide',
      slide: 'pistol_slide'
    }
  };
  on('weapon:reload', (payload) => {
    const weapon = weaponOf(payload);
    const phase = payload.phase;
    const sound = RELOAD_SOUNDS[weapon][phase as string];
    if (phase === 'start') {
      play('gear_rustle', {
        variant: 0,
        gain: 0.9,
        pitch: weapon === 'pistol' ? 1.12 : 1
      });
    } else if (phase === 'done') {
      play('gear_rustle', {
        variant: 1,
        gain: 0.6,
        pitch: weapon === 'pistol' ? 1.12 : 1
      });
    } else if (phase === 'boltback' && weapon === 'rifle') {
      play(sound, {
        variant: payload.partial ? 1 : 0,
        gain: payload.partial ? 0.6 : 1,
        jitter: 0.02
      });
    } else if (sound) {
      play(sound, {
        gain: 1,
        jitter: 0.02
      });
    }
  });
  on('weapon:switch', (payload) => {
    const toPistol = payload.to === 'pistol';
    const fromPistol = payload.from === 'pistol';
    if (payload.phase === 'holster') {
      play('weapon_holster', {
        gain: fromPistol ? 0.75 : 1,
        pitch: fromPistol ? 1.18 : 1
      });
    } else if (payload.phase === 'draw') {
      play('weapon_draw', {
        gain: toPistol ? 0.8 : 1,
        pitch: toPistol ? 1.15 : 1
      });
    }
  });
  on('weapon:melee', () =>
    play('jump', {
      gain: 0.9,
      pitch: 1.2
    })
  );
  // Spent-casing bounces are deliberately silent: the brass tinkle after every shot read as a
  // wind chime over the gunfire (the shell_bounce sounds stay in the table, unused).
  on('impact', (payload) => {
    const now = ctx.currentTime;
    if (now - lastImpact < 0.022) return;
    lastImpact = now;
    const point = asVec3(payload.point);
    const surface = payload.surface;
    if (payload.enemy && payload.enemy.type === 'guard') {
      play('impact_flesh', {
        pos: point,
        gain: payload.part === 'weak' ? 1 : 0.85,
        pitch: payload.part === 'weak' ? 1.15 : 1,
        jitter: 0.05
      });
      return;
    }
    if (payload.enemy) {
      play('impact_enemy', {
        pos: point,
        gain: payload.part === 'weak' ? 1 : 0.85,
        pitch: payload.part === 'weak' ? 1.25 : 1
      });
      return;
    }
    // Enemy bullets passing close to the listener: whiz at the closest point of the ray.
    if (
      payload.from === 'enemy' &&
      point &&
      payload.dir &&
      typeof payload.dir.x == 'number' &&
      now - lastWhiz > 0.09
    ) {
      const dir = payload.dir;
      const lenSq = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z || 1;
      const along =
        ((listenerPos.x - point.x) * dir.x +
          (listenerPos.y - point.y) * dir.y +
          (listenerPos.z - point.z) * dir.z) /
        lenSq;
      if (along < -1.5) {
        const cx = point.x + dir.x * along;
        const cy = point.y + dir.y * along;
        const cz = point.z + dir.z * along;
        const dist = Math.hypot(listenerPos.x - cx, listenerPos.y - cy, listenerPos.z - cz);
        if (dist < 3.2) {
          lastWhiz = now;
          play('whiz', {
            pos: {
              x: cx,
              y: cy,
              z: cz
            },
            gain: clampAudio(1.15 - dist / 3.5, 0.3, 1),
            jitter: 0.1
          });
        }
      }
    }
    play(IMPACT_SOUND_BY_SURFACE[surface as string] || 'impact_concrete', {
      pos: point,
      gain: payload.from === 'enemy' ? 0.8 : 0.9,
      pitch: surface === 'dirt' ? 0.8 : surface === 'rubber' ? 0.7 : 1,
      jitter: 0.07
    });
    if (
      now - lastRicochet > 0.22 &&
      ((surface === 'metal' && rng() < 0.24) || (surface === 'concrete' && rng() < 0.07))
    ) {
      lastRicochet = now;
      play('ricochet', {
        pos: point,
        gain: 0.75,
        delay: 0.012,
        jitter: 0.12
      });
    }
  });
  on('player:step', (payload) => {
    // One human footstep everywhere (no per-surface variants or splash layers).
    play('step_concrete', {
      gain: payload.sprint ? 0.75 : 0.55,
      pitch: payload.sprint ? 1.03 : 1,
      jitter: 0.03
    });
  });
  on('player:jump', () =>
    play('jump', {
      gain: 0.8
    })
  );
  on('player:land', (payload) => {
    // Math.abs coerces like Number(), so Number() keeps undefined -> NaN -> 4.
    const gain = clampAudio(0.35 + (Math.abs(Number(payload.speed)) || 4) / 10, 0.35, 1);
    play('land', {
      gain
    });
  });
  on('player:hit', (payload) => {
    const amount = Number(payload.amount) || 10;
    const now = ctx.currentTime;
    play('hurt', {
      gain: clampAudio(0.5 + amount / 40, 0.5, 1),
      jitter: 0.08
    });
    if (amount >= 6 && now - lastEarRing > 1.8) {
      lastEarRing = now;
      play('ear_ring', {
        gain: clampAudio(amount / 28, 0.3, 1),
        jitter: 0.02
      });
    }
    muffle = Math.max(muffle, clampAudio(amount / 40, 0.2, 0.7));
    heat = Math.min(1, Math.max(heat, 0.6) + 0.15);
  });
  on('player:dead', () => {
    director.death();
    muffle = 1;
  });
  on('enemy:spawn', (payload) => trackEnemy(payload.enemy));
  on('enemy:alert', (payload) => {
    heat = Math.max(heat, 0.6);
    const now = ctx.currentTime;
    if (now - lastAlert < 0.12) return;
    lastAlert = now;
    const enemy = payload.enemy || {};
    if (enemy.type === 'guard') {
      play('guard_radio', {
        pos: asVec3(enemy.pos) || asVec3(payload.pos),
        variant: 0,
        gain: 0.85
      });
      return;
    }
    play('alert', {
      pos: asVec3(enemy.pos) || asVec3(payload.pos),
      variant: enemy.type === 'hound' ? 1 : 0,
      gain: 0.9
    });
  });
  on('enemy:fire', (payload) => {
    const type = payload.type || (payload.enemy && payload.enemy.type);
    const pos = asVec3(payload.pos) || (payload.enemy && asVec3(payload.enemy.pos));
    play(type === 'guard' ? 'guard_fire' : type === 'hound' ? 'hound_fire' : 'gull_fire', {
      pos,
      gain: 1,
      jitter: 0.04
    });
    heat = Math.min(1, Math.max(heat, 0.6) + 0.05);
  });
  on('enemy:step', (payload) => {
    if (payload.type === 'guard') {
      // Guard death falls are part of `guard_die`; only footsteps here.
      if (!payload.crash) {
        play('guard_step', {
          pos: asVec3(payload.pos),
          gain: clampAudio(0.45 + (Number(payload.speed) || 1.5) * 0.1, 0.45, 0.9),
          // Same human footstep as the player, a touch lower for boots and kit.
          pitch: 0.95,
          jitter: 0.03
        });
      }
      return;
    }
    if (payload.crash) {
      play('hound_step', {
        pos: asVec3(payload.pos),
        gain: 1,
        pitch: 0.72
      });
      play('impact_metal', {
        pos: asVec3(payload.pos),
        gain: 0.8,
        pitch: 0.55
      });
      return;
    }
    if (payload.type !== 'gull') {
      play('hound_step', {
        pos: asVec3(payload.pos),
        gain: clampAudio(0.6 + (Number(payload.speed) || 2) * 0.1, 0.6, 1),
        jitter: 0.06
      });
    }
  });
  on('enemy:telegraph', (payload) => {
    const enemy = payload.enemy || {};
    const type = payload.type || enemy.type;
    const windup = clampAudio(Number(payload.time) || 0.55, 0.15, 1.5);
    if (type === 'guard') {
      play('guard_ready', {
        pos: asVec3(payload.pos) || asVec3(enemy.pos),
        gain: 0.9,
        jitter: 0.05
      });
      heat = Math.max(heat, 0.6);
      return;
    }
    play('telegraph', {
      pos: asVec3(payload.pos) || asVec3(enemy.pos),
      variant: type === 'hound' ? 1 : 0,
      pitch: 0.55 / windup,
      gain: payload.melee ? 0.7 : 1,
      jitter: 0
    });
    heat = Math.max(heat, 0.6);
  });
  on('enemy:melee', (payload) => {
    const pos = asVec3(payload.pos) || (payload.enemy && asVec3(payload.enemy.pos));
    play('hound_step', {
      pos,
      gain: 1,
      pitch: 0.8
    });
    play('impact_metal', {
      pos,
      gain: 0.9,
      pitch: 0.7
    });
    play('hurt', {
      gain: 0.6
    });
  });
  on('enemy:killed', (payload) => {
    const enemy = payload.enemy;
    const type = payload.type || (enemy && enemy.type);
    const pos = asVec3(payload.pos) || (enemy && asVec3(enemy.pos));
    if (enemy) untrackEnemy(enemy);
    play(type === 'guard' ? 'guard_die' : type === 'hound' ? 'hound_die' : 'gull_die', {
      pos,
      gain: 1,
      jitter: 0.05
    });
  });
  on('enemy:support', (payload) => {
    const pos = asVec3(payload.pos) || (payload.enemy && asVec3(payload.enemy.pos));
    play('guard_radio', {
      pos,
      variant: 1,
      gain: 1
    });
    heat = Math.min(1, Math.max(heat, 0.7) + 0.1);
  });
  on('explosion', (payload) => {
    const size = clampAudio(Number(payload.size) || 1, 0.3, 3);
    const pos = asVec3(payload.pos);
    const big = size >= 1.3;
    const playSmall = () =>
      play('explosion', {
        pos,
        gain: clampAudio(0.42 + 0.4 * size, 0.5, 1),
        pitch: clampAudio(1.26 - 0.22 * size, 0.82, 1.2),
        jitter: 0.04
      });
    // The big explosion falls back to the small one if it is not rendered yet.
    if (!(
      big &&
      playSound('explosion_big', {
        pos,
        gain: clampAudio(0.7 + 0.18 * size, 0.9, 1.2),
        pitch: clampAudio(1.13 - 0.075 * size, 0.92, 1.04),
        jitter: 0.03,
        ref: 12 + 3 * size,
        noDefer: true
      })
    )) {
      playSmall();
    }
    if (pos) {
      const dist = Math.hypot(pos.x - listenerPos.x, pos.y - listenerPos.y, pos.z - listenerPos.z);
      muffle = Math.max(muffle, clampAudio((1 - (dist - 5) / 10) * (big ? 1 : 0.7), 0, 0.8));
    }
    heat = Math.max(heat, 0.6);
    musicLevel = Math.min(musicLevel, big ? 0.3 : 0.45);
    duck(big ? 0.4 : 0.6, big ? 0.4 : 0.15, big ? 0.45 : 0.2);
  });
  on('objective:done', (payload) => {
    cutRelay(payload);
    director.relay();
  });
  on('objective:all', () => director.finalRun());
  const onComplete = () => director.complete();
  on('extraction:reached', onComplete);
  on('thunder', (payload) => {
    const strength = clampAudio(payload.intensity != null ? +payload.intensity : 0.6, 0.1, 1);
    play('thunder', {
      variant: strength > 0.6 ? 1 : 0,
      delay: 0.5 + (1 - strength) * 2 + rng() * 0.6,
      gain: 0.35 + 0.65 * strength,
      jitter: 0.1
    });
  });
  on('ui:click', () => play('ui_click'));
  on('ui:hover', () => play('ui_hover'));
  on('game:state', (payload) => {
    const previous = gameState;
    gameState = payload.state || gameState;
    director.state(gameState, previous);
    if (gameState === 'playing' && previous !== 'paused') {
      heat = 0;
      muffle = 0;
      startRelayHums();
      for (const enemy of [...trackedEnemies.keys()]) {
        if (enemy.alive === false) untrackEnemy(enemy);
      }
    }
    if (gameState === 'complete') onComplete();
    if (gameState === 'paused') paused = true;
    else if (previous === 'paused') paused = false;
  });

  // --- Context resume / visibility ---
  function resume(): void {
    resumeRequested = true;
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      try {
        const pending = ctx.resume();
        if (pending && pending.catch) pending.catch(() => {});
      } catch {}
    }
  }
  if (typeof window < 'u' && !shared) {
    const gestureEvents = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
    const onGesture = () => {
      resume();
      if (isRunning()) {
        for (const type of gestureEvents) window.removeEventListener(type, onGesture, true);
      }
    };
    for (const type of gestureEvents) {
      window.addEventListener(type, onGesture, {
        capture: true,
        passive: true
      });
    }
    // Without `shared` this is always the live AudioContext.
    const liveCtx = ctx as AudioContext;
    document.addEventListener('visibilitychange', () => {
      try {
        if (document.hidden) liveCtx.suspend();
        else if (resumeRequested) liveCtx.resume();
      } catch {}
    });
  }

  /** Per-frame update: listener, interior/reverb blend, ambience, enemy loops, music, loops. */
  function update(dt: number): void {
    dt = Math.min(Math.max(+dt || 0, 0), 0.25);
    const camera = host.camera;
    const listener = ctx.listener;
    if (camera && camera.matrixWorld) {
      const m = camera.matrixWorld.elements;
      listenerPos.x = m[12];
      listenerPos.y = m[13];
      listenerPos.z = m[14];
      if (Number.isFinite(listenerPos.x + listenerPos.y + listenerPos.z + m[8] + m[4])) {
        if (listener.positionX) {
          listener.positionX.value = listenerPos.x;
          listener.positionY.value = listenerPos.y;
          listener.positionZ.value = listenerPos.z;
          listener.forwardX.value = -m[8];
          listener.forwardY.value = -m[9];
          listener.forwardZ.value = -m[10];
          listener.upX.value = m[4];
          listener.upY.value = m[5];
          listener.upZ.value = m[6];
        } else {
          listener.setPosition(listenerPos.x, listenerPos.y, listenerPos.z);
          listener.setOrientation(-m[8], -m[9], -m[10], m[4], m[5], m[6]);
        }
      }
    }
    const boxes = host.level && host.level.interiorBoxes;
    if (Array.isArray(boxes) && boxes.length) {
      let inside = 0;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (
          box &&
          box.min &&
          box.max &&
          listenerPos.x > box.min.x &&
          listenerPos.x < box.max.x &&
          listenerPos.y > box.min.y - 0.5 &&
          listenerPos.y < box.max.y &&
          listenerPos.z > box.min.z &&
          listenerPos.z < box.max.z
        ) {
          inside = 1;
          break;
        }
      }
      interiorTarget = inside;
    }
    const ease = (rate: number) => 1 - Math.exp(-dt * rate);
    interior += (interiorTarget - interior) * ease(3);
    outdoorSend.gain.value = 1 - 0.9 * interior;
    indoorSend.gain.value = interior;
    if (!isRunning()) return;
    const active = gameState === 'playing' || gameState === 'intro';
    ambienceLevel +=
      ((paused ? 0 : gameState === 'title' ? 0.6 : gameState === 'dead' ? 0.7 : 1) -
        ambienceLevel) *
      ease(1.2);
    pauseLevel += ((paused ? 0 : 1) - pauseLevel) * ease(12);
    pauseGain.gain.value = pauseLevel;
    muffle += ((gameState === 'dead' ? 0.85 : 0) - muffle) * ease(gameState === 'dead' ? 3 : 0.9);
    muffleFilter.frequency.value = 2e4 * Math.pow(0.03, clampAudio(muffle, 0, 1));
    master.gain.value = volume;
    if ((windTimer -= dt) <= 0) {
      windTimer = 3 + rng() * 6;
      windTarget = 0.12 + rng() * 0.88;
    }
    wind += (windTarget - wind) * ease(0.5);
    const rainMix =
      host.ground && typeof host.ground.rainLevel === 'number'
        ? Math.min(1, host.ground.rainLevel / 0.6)
        : 1;
    ambienceLoops.rain.setGain(ambienceLevel * rainMix * (1 - 0.93 * interior) * 0.95);
    ambienceLoops.rainIn.setGain(ambienceLevel * rainMix * interior * 0.95);
    // Wind is muted: the port read as too busy. Sea stays as a faint bed.
    ambienceLoops.wind.setGain(0);
    ambienceLoops.wind.setPitch(0.9 + 0.25 * wind);
    ambienceLoops.sea.setGain(ambienceLevel * (1 - 0.5 * interior) * AMBIENT_MIX.sea);
    ambienceLoops.sea.setPos([33, -1, clampAudio(listenerPos.z, -28, 26)]);
    if (!paused && (active || gameState === 'title' || gameState === 'complete')) {
      updateAmbientEvents(dt, gameState === 'title' ? 0.7 : 1);
    }
    if (!paused) updateEnemyLoops(dt);
    heat = Math.max(0, heat - dt * (trackedEnemies.size ? 0.045 : 0.14));
    const threat =
      active || paused
        ? Math.max(intensityFloor, controls.autoIntensity ? Math.max(0.15, heat) : 0)
        : 0;
    intensity += (threat - intensity) * ease(2);
    musicLevel += (1 - musicLevel) * ease(3.5);
    musicOn += (musicOnTarget - musicOn) * ease(2.5);
    if (Math.abs(musicOnTarget - musicOn) < 0.001) musicOn = musicOnTarget;
    musicLevelGain.gain.value = musicLevel * musicOn * (paused ? 0.45 : 1);
    director.update(dt, intensity, threat);
    for (const voice of activeLoops) {
      voice.vC += (voice.vT - voice.vC) * ease(4);
      voice.gC += (voice.gT * voice.vC - voice.gC) * ease(voice.rate);
      voice.g.gain.value = voice.gC;
      if (voice.src && Math.abs(voice.pT - voice.pC) > 1e-4) {
        voice.pC += (voice.pT - voice.pC) * ease(8);
        voice.src.playbackRate.value = voice.pC;
      }
    }
  }

  /**
   * Offline QA render: replays a scripted fight (steps, rifle/pistol fire, reloads, enemies,
   * explosions, a hit, a relay) through a second engine on an OfflineAudioContext and reports
   * peak / RMS statistics.
   */
  async function selfTest(opts?: AudioSelfTestOptions): Promise<AudioSelfTestReport> {
    opts = opts || {};
    await ready;
    const testOpts = opts;
    const sampleRate = ctx.sampleRate;
    const seconds = testOpts.seconds || 10;
    const offline = new OfflineAudioContext(2, sampleRate * seconds, sampleRate);
    const handlers = new Map<string, ((payload: AudioEventPayload) => void)[]>();
    const bus: SelfTestBus = {
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
      emit(event, payload) {
        for (const handler of handlers.get(event) || []) handler(payload);
      }
    };
    const cameraMatrix = new Float32Array(16);
    cameraMatrix[0] = cameraMatrix[5] = cameraMatrix[10] = cameraMatrix[15] = 1;
    cameraMatrix[13] = 1.7;
    const testEnemies: AudioEnemyLike[] = [
      {
        type: 'gull',
        alive: true,
        pos: {
          x: 6,
          y: 4,
          z: -9
        }
      },
      {
        type: 'hound',
        alive: true,
        pos: {
          x: -8,
          y: 0,
          z: -14
        }
      },
      {
        type: 'gull',
        alive: true,
        pos: {
          x: 0,
          y: 5,
          z: -30
        }
      }
    ];
    const everywhere = {
      min: {
        x: -99,
        y: -9,
        z: -99
      },
      max: {
        x: 99,
        y: 99,
        z: 99
      }
    };
    const enemyList: AudioEnemyLike[] = [];
    const testHost = {
      events: bus,
      params: {},
      camera: {
        matrixWorld: {
          elements: cameraMatrix
        }
      },
      enemies: {
        list: enemyList
      },
      level: {
        interiorBoxes: testOpts.interior
          ? [everywhere]
          : [
              {
                min: {
                  x: 500,
                  y: 0,
                  z: 500
                },
                max: {
                  x: 501,
                  y: 1,
                  z: 501
                }
              }
            ],
        objectives: [
          {
            id: 'A',
            pos: {
              x: 4,
              y: 0,
              z: 3
            }
          }
        ]
      }
    };
    const engine = initAudioEngine(testHost, offline, {
      bufs: buffers
    });
    const step = 0.02;
    let steps = 0;
    /** Emits the scripted events of step `i` (at `i * step` seconds). */
    const runScript = (i: number) => {
      const t = i * step;
      if (i === 0) {
        bus.emit('game:state', {
          state: 'playing'
        });
        if (testOpts.bare) {
          engine.setIntensity(1);
          engine.music.snap();
        }
      }
      if (t < 3 && i % 23 === 0) {
        bus.emit('player:step', {
          surface: 'concrete',
          sprint: false
        });
      }
      if (i === 150) {
        for (const enemy of testEnemies) {
          enemyList.push(enemy);
          bus.emit('enemy:spawn', {
            enemy
          });
        }
        bus.emit('enemy:alert', {
          enemy: testEnemies[0]
        });
        engine.setIntensity(1);
      }
      if (i >= 150 && i < 198 && i % 4 === 2) {
        bus.emit('weapon:fire', {
          weapon: 'rifle'
        });
        if (!testOpts.bare) {
          bus.emit('impact', {
            point: {
              x: 4,
              y: 1,
              z: -12
            },
            surface: i % 8 ? 'metal' : 'concrete',
            from: 'player'
          });
          bus.emit('shell:bounce', {
            pos: {
              x: 0.6,
              y: 0,
              z: 0.2
            },
            surface: i % 3 ? 'concrete' : 'metal'
          });
        }
      }
      if (i >= 225 && i < 275 && i % 10 === 5) {
        bus.emit('weapon:fire', {
          weapon: 'pistol'
        });
      }
      if (i === 276) {
        bus.emit('weapon:dry', {
          weapon: 'pistol'
        });
      }
      {
        const phases = ['start', 'magout', 'maginsert', 'magin', 'boltback', 'bolt', 'done'];
        const phaseIndex = (i - 280) / 4;
        if (
          phaseIndex >= 0 &&
          phaseIndex < phases.length &&
          phaseIndex === Math.floor(phaseIndex)
        ) {
          bus.emit('weapon:reload', {
            phase: phases[phaseIndex],
            weapon: 'rifle',
            empty: true
          } as AudioEventPayload);
        }
      }
      if (i === 312) {
        bus.emit('weapon:switch', {
          from: 'rifle',
          to: 'pistol',
          phase: 'holster'
        });
      }
      if (i === 322) {
        bus.emit('weapon:switch', {
          from: 'rifle',
          to: 'pistol',
          phase: 'draw'
        });
      }
      if (t >= 4 && t < 6.6 && !testOpts.bare) {
        if (i % 13 === 0) {
          bus.emit('enemy:fire', {
            enemy: testEnemies[0],
            pos: testEnemies[0].pos,
            type: 'gull'
          });
        }
        if (i % 17 === 0) {
          bus.emit('enemy:fire', {
            enemy: testEnemies[1],
            pos: testEnemies[1].pos,
            type: 'hound'
          });
        }
        if (i % 25 === 0) {
          bus.emit('enemy:step', {
            pos: testEnemies[1].pos,
            type: 'hound'
          });
        }
      }
      if (i === 330) {
        bus.emit('explosion', {
          pos: {
            x: 3,
            y: 0,
            z: -7
          },
          size: 2
        });
      }
      if (i === 345) {
        bus.emit('explosion', {
          pos: {
            x: -6,
            y: 3,
            z: -9
          },
          size: 0.9
        });
      }
      if (i === 350) {
        bus.emit('player:hit', {
          amount: 20
        });
      }
      if (i === 360) {
        testEnemies[0].alive = false;
        bus.emit('enemy:killed', {
          enemy: testEnemies[0],
          pos: testEnemies[0].pos,
          type: 'gull'
        });
      }
      if (i === 400) {
        bus.emit('objective:done', {
          id: 'A',
          index: 0,
          total: 3
        } as AudioEventPayload);
        engine.setIntensity(0.15);
      }
    };
    for (let i = 1; i * step < seconds - 0.01; i++) {
      offline.suspend(i * step).then(() => {
        runScript(i);
        engine.update(step);
        steps++;
        offline.resume();
      });
    }
    runScript(0);
    engine.update(step);
    const renderStart = performance.now();
    const rendered = await offline.startRendering();
    const renderMs = performance.now() - renderStart;
    const report: AudioSelfTestReport = {
      interior: !!testOpts.interior,
      renderMs: Math.round(renderMs),
      steps,
      peak: 0,
      over: 0,
      nan: 0,
      rmsDb: [],
      shotPeakDb: [],
      shotRmsDb: [],
      bodyRmsDb: [],
      troughDb: [],
      bedRmsDb: 0,
      inst: engine.debug()
    };
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    const block = Math.round(sampleRate / 2);
    for (let b = 0; b * block < left.length; b++) {
      let energy = 0;
      for (let i = b * block; i < (b + 1) * block && i < left.length; i++) {
        const l = left[i];
        const r = right[i];
        if (!(Math.abs(l) < 1e9) || !(Math.abs(r) < 1e9)) report.nan++;
        const peak = Math.max(Math.abs(l), Math.abs(r));
        if (peak > report.peak) report.peak = peak;
        if (peak >= 0.999) report.over++;
        energy += l * l + r * r;
      }
      report.rmsDb.push(+(10 * Math.log10(energy / (2 * block) + 1e-12)).toFixed(1));
    }
    // The 12 rifle shots fire every 80 ms from 3.004 s.
    for (let shot = 0; shot < 12; shot++) {
      const from = Math.round((3.004 + shot * 0.08) * sampleRate);
      const to = from + Math.round(0.076 * sampleRate);
      let peak = 0;
      let energy = 0;
      for (let i = from; i < to && i < left.length; i++) {
        const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
        if (v > peak) peak = v;
        energy += left[i] * left[i];
      }
      report.shotPeakDb.push(+(20 * Math.log10(peak + 1e-9)).toFixed(1));
      report.shotRmsDb.push(+(10 * Math.log10(energy / (to - from) + 1e-12)).toFixed(1));
      const rmsDbOf = (start: number, end: number) => {
        let sum = 0;
        for (let i = start; i < end && i < left.length; i++) sum += left[i] * left[i];
        return +(10 * Math.log10(sum / (end - start) + 1e-12)).toFixed(1);
      };
      report.bodyRmsDb.push(rmsDbOf(from, from + Math.round(0.05 * sampleRate)));
      report.troughDb.push(
        rmsDbOf(from + Math.round(0.051 * sampleRate), from + Math.round(0.076 * sampleRate))
      );
    }
    {
      let energy = 0;
      const from = Math.round(2 * sampleRate);
      const to = Math.round(2.95 * sampleRate);
      for (let i = from; i < to; i++) energy += left[i] * left[i];
      report.bedRmsDb = +(10 * Math.log10(energy / (to - from) + 1e-12)).toFixed(1);
    }
    report.peak = +report.peak.toFixed(3);
    return report;
  }

  return Object.assign(controls, {
    ctx,
    resume,
    play,
    loop,
    update,
    ready,
    selfTest,
    music: director,
    setIntensity(value: number) {
      intensityFloor = clampAudio(+value || 0, 0, 1);
    },
    setInterior(value: number) {
      interiorTarget = clampAudio(+value || 0, 0, 1);
    },
    setVolume(value: number) {
      volume = clampAudio(+value, 0, 1);
      if (!Number.isFinite(volume)) volume = 0.9;
      master.gain.value = volume;
    },
    setMusic(on: boolean) {
      musicOnTarget = on ? 1 : 0;
    },
    setPaused(value: boolean) {
      paused = !!value;
    },
    names: Object.keys(SOUNDS).filter((name) => !SOUNDS[name].ir),
    // Note: Object.assign copies these getters' values once (they read 0 at creation).
    get intensity() {
      return intensity;
    },
    get interior() {
      return interior;
    },
    debug(): AudioEngineDebug {
      let voices = 0;
      const now = ctx.currentTime;
      for (const bus in pools) {
        for (const channel of pools[bus as VoicePoolName]) if (channel.end > now) voices++;
      }
      return {
        state: ctx.state,
        sampleRate: ctx.sampleRate,
        buffers: bufferCount,
        queued: queue.length,
        genMs: Math.round(genMs),
        bootMs: Math.round(bootMs),
        voices,
        loops: activeLoops.size,
        tracked: trackedEnemies.size,
        music: director.on,
        score: director.debug(),
        intensity: +intensity.toFixed(2),
        interior: +interior.toFixed(2),
        gameState,
        reverb: [!!outdoorReverb.buffer, !!shedReverb.buffer]
      };
    }
  });
}
