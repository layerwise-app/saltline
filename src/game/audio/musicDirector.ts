// Mix constants (bus gains, compressor, weapon/tail routing) and the adaptive music director:
// it runs the looping music stems, crossfades them by combat intensity, and schedules
// bar-quantized phrases, fills, hits, risers/impacts and stings on top.
import { MUSIC } from './music';
import { MUSIC_LOOP_NAMES } from './sfxWorld';

/** Per-weapon sound routing and levels. */
export interface WeaponMix {
  shot: string;
  /** Number of shot variants. */
  n: number;
  gain: number;
  tailOut: string;
  tailIn: string;
  tail: number;
  duck: number;
  shellPitch: number;
}

/** Master compressor settings (dB / ratio / seconds, as on `DynamicsCompressorNode`). */
export interface CompressorSettings {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}

/** Global mix configuration. */
export interface MixConfig {
  comp: CompressorSettings;
  preGain: number;
  master: number;
  musicBus: number;
  weapon: Record<string, WeaponMix>;
  /** Ambience/music ducking envelope on gunshots. */
  duck: { attack: number; hold: number; release: number };
  tailBoostAfter: number;
  music: {
    trim: number;
    layers: Record<string, number>;
    cell: number;
    horn: number;
    fill: number;
    hit: number;
    riser: number;
    impact: number;
    relay: number;
    death: number;
    complete: number;
    xfade: number;
    relayDuck: number;
    preImpactDip: number;
    riserMin: number;
    riserMinAfterRelay: number;
    riserCooldown: number;
    cadenceLen: number;
  };
}

export const MIX: MixConfig = {
  comp: {
    threshold: -3,
    knee: 6,
    ratio: 2,
    attack: 0.01,
    release: 0.12
  },
  preGain: 1,
  master: 0.9,
  musicBus: 0.73,
  weapon: {
    rifle: {
      shot: 'rifle_shot',
      n: 5,
      gain: 1.12,
      tailOut: 'rifle_tail_out',
      tailIn: 'rifle_tail_in',
      tail: 1.12,
      duck: 0.45,
      shellPitch: 1
    },
    pistol: {
      shot: 'pistol_shot',
      n: 4,
      gain: 1.12,
      tailOut: 'pistol_tail_out',
      tailIn: 'pistol_tail_in',
      tail: 1.12,
      duck: 0.5,
      shellPitch: 1.22
    }
  },
  duck: {
    attack: 0.012,
    hold: 0.085,
    release: 0.1
  },
  tailBoostAfter: 0.105,
  music: {
    trim: 0.92,
    layers: {
      music_drone: 1,
      music_strings: 1,
      music_pulse: 1,
      music_ticks: 1,
      music_drums: 1,
      music_brass: 1,
      music_lift: 1
    },
    cell: 0.8,
    horn: 0.7,
    fill: 0.55,
    hit: 0.42,
    riser: 0.9,
    impact: 0.75,
    relay: 0.9,
    death: 0.9,
    complete: 0.9,
    xfade: 0.5,
    relayDuck: 0.4,
    preImpactDip: 0.45,
    riserMin: 1.25,
    riserMinAfterRelay: 2.6,
    riserCooldown: 25,
    cadenceLen: 11.5
  }
};

/** Gain for a reverb tail given the time since the previous shot (dense fire -> quieter tails). */
export function tailGainForShotGap(gap: number): number {
  return gap >= 0.45 ? 1 : 0.4 + (0.6 * Math.max(0, gap)) / 0.45;
}

/** Linear up to 0.6, then a tanh knee towards 1. */
function softKneeClip(x: number): number {
  const mag = Math.abs(x);
  return Math.sign(x) * (mag <= 0.6 ? mag : 0.6 + 0.4 * Math.tanh((mag - 0.6) / 0.4));
}

const CLIPPER_DRIVE = 4;

/** WaveShaper curve for the master soft clipper (input range scaled by `CLIPPER_DRIVE`). */
export function makeClipperCurve(size = 4097): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++)
    curve[i] = softKneeClip(((i / (size - 1)) * 2 - 1) * CLIPPER_DRIVE);
  return curve;
}

/** Static model of the WebAudio compressor curve, used to derive its makeup gain. */
function modelCompressor(comp: CompressorSettings): {
  saturate: (x: number) => number;
  makeup: number;
} {
  const dbToLin = (db: number) => Math.pow(10, db / 20);
  const linToDb = (lin: number) => (lin > 0 ? 20 * Math.log10(lin) : -1e3);
  const threshold = dbToLin(comp.threshold);
  const kneeEndDb = comp.threshold + comp.knee;
  const kneeEnd = dbToLin(kneeEndDb);
  const slope = 1 / comp.ratio;
  const kneeCurve = (x: number, k: number) =>
    x < threshold ? x : threshold + (1 - Math.exp(-k * (x - threshold))) / k;
  const kneeSlope = (x: number, k: number) => {
    if (x < threshold) return 1;
    const x2 = x * 1.001;
    return (linToDb(kneeCurve(x2, k)) - linToDb(kneeCurve(x, k))) / (linToDb(x2) - linToDb(x));
  };
  let lo = 0.1;
  let hi = 1e4;
  let k = 5;
  if (comp.knee > 0) {
    // Bisect (geometrically) the knee sharpness so the slope at the knee end matches the ratio.
    for (let iter = 0; iter < 15; iter++) {
      if (kneeSlope(kneeEnd, k) < slope) hi = k;
      else lo = k;
      k = Math.sqrt(lo * hi);
    }
  }
  const kneeEndOutDb = linToDb(kneeCurve(kneeEnd, k));
  const saturate = (x: number) =>
    x < kneeEnd ? kneeCurve(x, k) : dbToLin(kneeEndOutDb + slope * (linToDb(x) - kneeEndDb));
  return {
    saturate,
    makeup: Math.pow(1 / saturate(1), 0.6)
  };
}

/** Gain in front of the master clipper that compensates compressor makeup and clipper drive. */
export function masterPreGain(): number {
  return MIX.preGain / (modelCompressor(MIX.comp).makeup * CLIPPER_DRIVE);
}

const clampMix = (x: number, min: number, max: number): number => Math.min(max, Math.max(min, x));
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clampMix((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
const DIRECTOR_BAR = MUSIC.bar;
const DIRECTOR_BEAT = MUSIC.beat;

/** Inputs to `computeMusicLayerGains` besides the music state and intensity. */
interface LayerGainOpts {
  /** 0 while a riser/impact gate holds the upper layers back. */
  gate?: number;
  final?: boolean;
  /** Seconds since the completion cadence started, or null. */
  after?: number | null;
}

const EMPTY_LAYER_OPTS: LayerGainOpts = {};

/** Target gain of every music stem for a music state and intensity (0..1). */
function computeMusicLayerGains(
  live: string,
  intensity: number,
  opts: LayerGainOpts = EMPTY_LAYER_OPTS,
  out: Record<string, number> = {}
): Record<string, number> {
  const layerTrims = MIX.music.layers;
  for (const name of MUSIC_LOOP_NAMES) out[name] = 0;
  if (live === 'title' || live === 'intro') out.music_drone = 0.95;
  else if (live === 'dead') out.music_drone = 0.4;
  else if (live === 'complete') {
    out.music_drone = opts.after == null || opts.after > MIX.music.cadenceLen ? 0.7 : 0;
  } else {
    const mid = smoothstep(0.3, 0.6, intensity);
    const high = smoothstep(0.7, 0.95, intensity) * (opts.gate == null ? 1 : opts.gate);
    const final = opts.final ? high : 0;
    out.music_drone = 1 - 0.15 * mid - 0.15 * high - 0.2 * final;
    out.music_strings = mid * (0.85 + 0.15 * high);
    out.music_pulse = mid * (0.8 + 0.2 * high) * (1 - 0.2 * final);
    out.music_ticks = mid * (0.7 + 0.3 * high);
    out.music_drums = high;
    out.music_brass = high * (1 - 0.15 * final);
    out.music_lift = final;
  }
  for (const name of MUSIC_LOOP_NAMES) out[name] *= layerTrims[name] * MIX.music.trim;
  return out;
}

/** Dependencies the audio engine hands to the music director. */
export interface MusicDirectorOptions {
  ctx: BaseAudioContext;
  /** Music bus input. */
  out: AudioNode;
  /** Rendered buffers keyed by `name#variant`. */
  bufs: ReadonlyMap<string, AudioBuffer>;
  /** Calls `cb` once `name#variant` is rendered (prioritizing it in the synth queue). */
  whenReady: (name: string, variant: number, cb: (buf: AudioBuffer) => void) => void;
  /** Whether the audio context is running. */
  running: () => boolean;
  rnd?: () => number;
}

/** A looping music stem. */
interface MusicLayer {
  g: GainNode;
  s: AudioBufferSourceNode;
  /** Current target gain (-1 = unknown, forces the next update). */
  t: number;
  /** Ignore gain updates until this context time. */
  hold: number;
}

/** Kind of a one-shot music voice. */
type MusicVoiceKind = 'phrase' | 'wave' | 'sting' | 'fill' | 'hit' | (string & {});

/** A scheduled one-shot music voice (phrase, sting, riser ...). */
interface MusicVoice {
  s: AudioBufferSourceNode;
  g: GainNode;
  name: string;
  kind: MusicVoiceKind;
  /** Context time it ends (or is faded out by). */
  end: number;
  gain: number;
}

interface PlayVoiceOpts {
  /** Start offset into the buffer (s). */
  offset?: number;
  fadeIn?: number;
  kind?: MusicVoiceKind;
}

/** A pending riser -> impact "wave" (drums/brass come in at `Ti`). */
interface MusicWave {
  /** Impact time. */
  Ti: number;
  voices: (MusicVoice | null)[];
}

/** Snapshot for the debug overlay. */
export interface MusicDirectorDebug {
  on: boolean;
  t0: number;
  bar: number;
  live: string;
  tier: number;
  final: boolean;
  gate: number;
  plan: string;
  voices: number;
  layers: Record<string, number | null>;
}

/** The adaptive music director returned by `createMusicDirector`. */
export interface MusicDirector {
  /** Whether the stems have started. */
  readonly on: boolean;
  /** Game state changed (`title`, `intro`, `playing`, `dead`, `complete`, `paused`). */
  state(next: string, prev?: string): void;
  /** An objective relay was cut: sting + duck. */
  relay(): void;
  /** Final run started (all objectives done). */
  finalRun(): void;
  death(): void;
  complete(): void;
  /** Re-arms the director right away (debug). */
  snap(): void;
  /** Per-frame update with smoothed intensity and raw threat level (0..1). */
  update(dt: number, intensity: number, threat: number): void;
  debug(): MusicDirectorDebug;
}

/** Internal director state. */
interface DirectorStatus {
  on: boolean;
  /** Context time of bar 0 of the stems. */
  t0: number;
  layers: Record<string, MusicLayer>;
  /** Index of the next bar to schedule. */
  nextBar: number;
  /** Current music state. */
  live: string;
  tier: number;
  final: boolean;
  gate: number;
  gateT: number;
  wave: MusicWave | null;
  lastImpact: number;
  armed: boolean;
  plan: string;
  cycle: number;
  quiet: number;
  lastFill: number;
  duckUntil: number;
  muteUntil: number;
  completeT: number;
  lastSting: number;
  lastRelay: number;
  voices: MusicVoice[];
  bars: number;
}

/** Creates the adaptive music director on top of the engine's music bus. */
export function createMusicDirector(options: MusicDirectorOptions): MusicDirector {
  const { ctx, out, bufs, whenReady, running } = options;
  const rng = options.rnd || Math.random;
  const mix = MIX.music;
  const status: DirectorStatus = {
    on: false,
    t0: 0,
    layers: {},
    nextBar: 0,
    live: 'title',
    tier: 0,
    final: false,
    gate: 1,
    gateT: -1,
    wave: null,
    lastImpact: -99,
    armed: false,
    plan: 'rest',
    cycle: 0,
    quiet: 0,
    lastFill: -1,
    duckUntil: -1,
    muteUntil: -1,
    completeT: -1,
    lastSting: -99,
    lastRelay: -99,
    voices: [],
    bars: 0
  };
  const getBuffer = (name: string, variant = 0) => bufs.get(name + '#' + variant);
  const noop = () => {};

  /** Starts a looping stem in phase with the others (the first one defines `t0`). */
  function startLayer(name: string, now: number): void {
    const buffer = getBuffer(name);
    if (!buffer) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(out);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    const when = now + 0.06;
    let offset = 0;
    if (status.on) {
      offset = (((when - status.t0) % buffer.duration) + buffer.duration) % buffer.duration;
    } else {
      status.on = true;
      status.t0 = when;
      status.nextBar = 0;
    }
    source.start(when, offset);
    status.layers[name] = {
      g: gain,
      s: source,
      t: 0,
      hold: -1
    };
  }

  /** Glides a stem to `target` unless held or already there. */
  function setLayerGain(layer: MusicLayer, target: number, now: number, tau: number): void {
    if (
      !(now < layer.hold) &&
      !(Math.abs(target - layer.t) < 0.004 && !(target === 0 && layer.t !== 0))
    ) {
      layer.t = target;
      try {
        layer.g.gain.setTargetAtTime(target, now, tau);
      } catch {
        layer.g.gain.value = target;
      }
    }
  }

  const layerOpts: { gate: number; final: boolean; after: number | null } = {
    gate: 1,
    final: false,
    after: null
  };
  const layerGains: Record<string, number> = {};
  const currentLayerGains = (intensity: number, now: number) => {
    layerOpts.gate = status.gate;
    layerOpts.final = status.final;
    layerOpts.after = status.completeT >= 0 ? now - status.completeT : null;
    return computeMusicLayerGains(status.live, intensity, layerOpts, layerGains);
  };

  /** Schedules a one-shot music voice; null if not rendered yet (then requests it) or muted. */
  function playVoice(
    name: string,
    variant: number,
    when: number,
    gainValue: number,
    opts: PlayVoiceOpts = {}
  ): MusicVoice | null {
    const buffer = getBuffer(name, variant);
    if (!buffer) {
      whenReady(name, variant, noop);
      return null;
    }
    if (!running()) return null;
    const now = ctx.currentTime;
    when = Math.max(when, now);
    gainValue *= mix.trim;
    const gain = ctx.createGain();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(out);
    if (opts.fadeIn) {
      try {
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(gainValue, when + opts.fadeIn);
      } catch {
        gain.gain.value = gainValue;
      }
    } else gain.gain.value = gainValue;
    const voice: MusicVoice = {
      s: source,
      g: gain,
      name,
      kind: opts.kind || 'phrase',
      end: when + buffer.duration - (opts.offset || 0),
      gain: gainValue
    };
    source.onended = () => {
      try {
        source.disconnect();
        gain.disconnect();
      } catch {}
    };
    source.start(when, opts.offset || 0);
    status.voices.push(voice);
    return voice;
  }

  /** Fades out (and stops) playing voices matching `filter` (all if null). */
  function fadeVoices(filter: ((voice: MusicVoice) => boolean) | null, fadeTime: number): void {
    const now = ctx.currentTime;
    for (const voice of status.voices) {
      if (!(voice.end <= now || (filter && !filter(voice)))) {
        try {
          voice.g.gain.cancelScheduledValues(now);
          voice.g.gain.setTargetAtTime(0, now, fadeTime / 3);
          voice.s.stop(now + fadeTime);
        } catch {}
        voice.end = now + fadeTime;
      }
    }
  }

  /** Plays a sting now if rendered, otherwise as soon as it is (if within 1.5 s). */
  function playSting(
    name: string,
    when: number,
    gainValue: number,
    kind: MusicVoiceKind
  ): MusicVoice | null {
    if (getBuffer(name)) {
      return playVoice(name, 0, when, gainValue, {
        kind
      });
    }
    const requestedAt = ctx.currentTime;
    whenReady(name, 0, () => {
      if (ctx.currentTime - requestedAt < 1.5) {
        playVoice(name, 0, ctx.currentTime + 0.03, gainValue, {
          kind
        });
      }
    });
    return null;
  }

  /** Next grid line (relative to `t0`) at least `delay` after `now`. */
  const quantize = (now: number, delay: number, grid: number) =>
    status.on ? status.t0 + Math.ceil((now + delay - status.t0) / grid - 1e-9) * grid : now + delay;

  /** Schedules a riser -> impact on the next bar line and gates the upper stems until then. */
  function armWave(now: number, _intensity: number, force: boolean): void {
    if (
      !status.on ||
      !getBuffer('mus_impact') ||
      (!force && now - status.lastImpact < mix.riserCooldown)
    ) {
      status.gate = 1;
      return;
    }
    const lead = now - status.lastRelay < 1.5 ? mix.riserMinAfterRelay : mix.riserMin;
    const impactTime = quantize(now, lead, DIRECTOR_BAR);
    status.gate = 0;
    status.gateT = impactTime;
    status.lastImpact = impactTime;
    status.muteUntil = Math.max(status.muteUntil, impactTime + 0.2);
    const wave: MusicWave = {
      Ti: impactTime,
      voices: []
    };
    if (getBuffer('mus_riser')) {
      const riserStart = Math.max(now + 0.02, impactTime - MUSIC.riserPeak);
      wave.voices.push(
        playVoice('mus_riser', 0, riserStart, mix.riser, {
          offset: MUSIC.riserPeak - (impactTime - riserStart),
          fadeIn: 0.1,
          kind: 'wave'
        })
      );
    }
    wave.voices.push(
      playVoice('mus_impact', 0, impactTime, mix.impact, {
        kind: 'wave'
      })
    );
    const fullGains = computeMusicLayerGains('playing', 1, {
      gate: 1,
      final: status.final
    });
    const duck = now < status.duckUntil ? mix.relayDuck : 1;
    for (const name of MUSIC_LOOP_NAMES) {
      const layer = status.layers[name];
      if (layer) {
        try {
          layer.g.gain.cancelScheduledValues(now);
          if (duck < 1 && layer.t > 0.01) {
            layer.g.gain.setTargetAtTime(Math.max(0, layer.t) * duck, now, 0.2);
          }
          if (layer.t > 0.01) {
            layer.g.gain.setTargetAtTime(
              layer.t * Math.min(duck, mix.preImpactDip),
              impactTime - 0.5,
              0.12
            );
          }
          layer.g.gain.setTargetAtTime(fullGains[name], impactTime - 0.03, 0.008);
        } catch {}
        layer.t = fullGains[name];
        layer.hold = impactTime + 0.25;
      }
    }
    status.wave = wave;
    status.armed = true;
  }

  /** Cancels a pending wave: fades its voices and releases the stems. */
  function cancelWave(now: number): void {
    if (status.wave) {
      for (const voice of status.wave.voices) {
        if (voice) {
          try {
            voice.g.gain.cancelScheduledValues(now);
            voice.g.gain.setTargetAtTime(0, now, 0.08);
            voice.s.stop(now + 0.3);
          } catch {}
          voice.end = now + 0.3;
        }
      }
      for (const name of MUSIC_LOOP_NAMES) {
        const layer = status.layers[name];
        if (layer) {
          try {
            layer.g.gain.cancelScheduledValues(now);
          } catch {}
          layer.hold = -1;
          layer.t = -1;
        }
      }
      status.wave = null;
      status.gate = 1;
      status.lastImpact = -99;
      status.armed = false;
    }
  }

  /** Resets the per-run form state. */
  function resetForm(): void {
    status.final = false;
    status.gate = 1;
    status.gateT = -1;
    status.wave = null;
    status.armed = false;
    status.completeT = -1;
    status.duckUntil = -1;
    status.muteUntil = -1;
    status.lastImpact = -99;
    status.plan = 'rest';
    status.quiet = 0;
  }

  const director: MusicDirector = {
    get on() {
      return status.on;
    },
    state(next, prev) {
      if (next === 'paused') return;
      const previousLive = status.live;
      status.live = next;
      if (prev === 'paused' && previousLive === next) return;
      const now = ctx.currentTime;
      if (next === 'playing' || next === 'intro' || next === 'title') {
        if (!(next === 'playing' && previousLive === 'intro')) {
          cancelWave(now);
          resetForm();
          fadeVoices((voice) => voice.kind !== 'phrase', 0.5);
        }
      }
    },
    relay() {
      if (!running()) return;
      const now = ctx.currentTime;
      if (now - status.lastRelay < 1) return;
      const when = quantize(now, 0.15, DIRECTOR_BEAT);
      status.lastRelay = now;
      fadeVoices((voice) => voice.kind === 'phrase', 0.4);
      playSting('objective', when, mix.relay, 'sting');
      status.duckUntil = when + 3.4;
      status.muteUntil = Math.max(status.muteUntil, when + 4.2);
    },
    finalRun() {
      if (status.final) return;
      status.final = true;
      if (!running() || !status.on) return;
      const now = ctx.currentTime;
      if (status.wave) cancelWave(now);
      armWave(now, 1, true);
    },
    death() {
      if (!running()) return;
      const now = ctx.currentTime;
      if (now - status.lastSting < 1) return;
      status.lastSting = now;
      cancelWave(now);
      fadeVoices(null, 0.25);
      playSting('death', now + 0.02, mix.death, 'sting');
    },
    complete() {
      if (!running()) return;
      const now = ctx.currentTime;
      if (now - status.lastSting < 6) return;
      status.lastSting = now;
      cancelWave(now);
      fadeVoices(null, 0.35);
      const when = quantize(now, 0.15, DIRECTOR_BEAT);
      status.completeT = when;
      playSting('complete', when, mix.complete, 'sting');
    },
    snap() {
      status.gate = 1;
      status.lastImpact = ctx.currentTime;
      status.armed = true;
    },
    update(_dt, intensity, threat) {
      if (!running()) return;
      const now = ctx.currentTime;
      if (!status.on) {
        if (getBuffer('music_drone')) startLayer('music_drone', now);
        else return;
      }
      for (const name of MUSIC_LOOP_NAMES) {
        if (!status.layers[name] && getBuffer(name)) startLayer(name, now);
      }
      const playing = status.live === 'playing';
      // Tier with hysteresis: 0 calm, 1 engaged, 2 heavy combat.
      const tier = playing
        ? threat >= 0.8 || (status.tier === 2 && threat >= 0.68)
          ? 2
          : threat >= 0.4 || (status.tier >= 1 && threat >= 0.32)
            ? 1
            : 0
        : 0;
      if (tier === 2 && status.tier < 2 && !status.wave && status.gate === 1) {
        armWave(now, intensity, false);
      } else if (tier < 2 && status.wave && now < status.wave.Ti - 0.6 && !status.final) {
        cancelWave(now);
      }
      status.tier = tier;
      if (status.wave && now >= status.wave.Ti) {
        status.gate = 1;
        status.wave = null;
      }
      const gains = currentLayerGains(intensity, now);
      const duck = now < status.duckUntil ? mix.relayDuck : 1;
      const cadence =
        status.live === 'dead' ||
        (status.live === 'complete' &&
          status.completeT >= 0 &&
          now - status.completeT < mix.cadenceLen);
      for (const name of MUSIC_LOOP_NAMES) {
        const layer = status.layers[name];
        if (layer) {
          setLayerGain(layer, gains[name] * duck, now, cadence ? 0.22 : duck < 1 ? 0.2 : mix.xfade);
        }
      }
      while (status.t0 + status.nextBar * DIRECTOR_BAR - now < 0.4) {
        const barTime = status.t0 + status.nextBar * DIRECTOR_BAR;
        if (barTime > now + 0.03) scheduleBar(status.nextBar, barTime, tier, now);
        status.nextBar++;
      }
      if (status.voices.length > 24 || (status.voices.length && status.voices[0].end < now)) {
        status.voices = status.voices.filter((voice) => voice.end > now);
      }
    },
    debug() {
      const layers: Record<string, number | null> = {};
      for (const name of MUSIC_LOOP_NAMES) {
        layers[name] = status.layers[name] ? +status.layers[name].t.toFixed(3) : null;
      }
      return {
        on: status.on,
        t0: status.t0,
        bar: status.nextBar,
        live: status.live,
        tier: status.tier,
        final: status.final,
        gate: status.gate,
        plan: status.plan,
        voices: status.voices.length,
        layers
      };
    }
  };
  const playCell = (variant: number, when: number, gainValue: number) =>
    playVoice('mus_cell', variant, when, gainValue);
  const playHorn = (variant: number, when: number, gainValue: number) =>
    playVoice('mus_horn', variant, when, gainValue);

  /**
   * Schedules the phrase content of one bar. The 8-bar cycle picks a `plan` on bar 0
   * (call / answer / full ...), then cells or horns land on even bars, plus fills and hits.
   */
  function scheduleBar(barIndex: number, barTime: number, tier: number, _now: number): void {
    const barInCycle = barIndex % 8;
    const live = status.live;
    if (live === 'dead') return;
    if (barTime < status.muteUntil) {
      if (barInCycle === 0) status.plan = 'rest';
      return;
    }
    if (live === 'complete') {
      if (status.completeT >= 0 && barTime - status.completeT < mix.cadenceLen + 2) return;
      if (barInCycle === 0 && rng() < 0.6) playCell(0, barTime, mix.cell * 0.8);
      return;
    }
    if (barInCycle === 0) {
      const roll = rng();
      status.cycle++;
      if (live === 'title' || live === 'intro') {
        status.plan = getBuffer('mus_cell', 3) && status.plan !== 'full' ? 'full' : 'rest';
      } else if (tier === 0) {
        status.plan =
          status.quiet >= 1
            ? roll < 0.5
              ? 'call'
              : roll < 0.8
                ? 'full call'
                : 'answer'
            : roll < 0.3
              ? 'call'
              : roll < 0.48
                ? 'full call'
                : roll < 0.62
                  ? 'tail'
                  : roll < 0.72
                    ? 'answer'
                    : 'rest';
      } else if (tier === 1) {
        status.plan = roll < 0.4 ? 'call' : roll < 0.55 ? 'tail' : 'rest';
      } else if (status.armed || status.final) {
        status.plan = status.armed || status.cycle % 2 ? 'full' : 'call';
        status.armed = false;
      } else {
        status.plan = ['rest', 'full call', 'rest', 'full'][status.cycle % 4];
      }
      status.quiet = status.plan === 'rest' ? status.quiet + 1 : 0;
    }
    const plan = status.plan;
    const phrase = barInCycle >> 1;
    const phraseBar =
      (barInCycle & 1) === 0 &&
      (plan === 'full' ||
        (plan === 'call' && phrase === 0) ||
        (plan === 'full call' && phrase < 2) ||
        (plan === 'tail' && phrase === 3) ||
        (plan === 'answer' && phrase >= 2));
    if (tier === 2 && status.gate === 1) {
      if (phraseBar) playHorn(phrase, barTime, mix.horn);
      const fillChance = status.final ? [0.6, 1] : [0.3, 0.8];
      if (
        (barInCycle === 3 && rng() < fillChance[0]) ||
        (barInCycle === 7 && rng() < fillChance[1])
      ) {
        let fill = Math.floor(rng() * 3);
        if (fill === status.lastFill) fill = (fill + 1) % 3;
        status.lastFill = fill;
        playVoice('mus_fill', fill, barTime, mix.fill, {
          kind: 'fill'
        });
      }
      return;
    }
    if (tier !== 2) {
      if (phraseBar) {
        playCell(
          phrase,
          barTime,
          live === 'title' || live === 'intro' ? mix.cell : tier === 1 ? mix.cell * 0.85 : mix.cell
        );
      }
      if (!phraseBar) {
        if (live === 'title' || live === 'intro') {
          if (barInCycle === 5 && rng() < 0.5) {
            playVoice('mus_hit', 0, barTime, mix.hit * 0.8, {
              kind: 'hit'
            });
          }
        } else if (tier === 0) {
          if ((barInCycle === 4 || barInCycle === 1) && rng() < (barInCycle === 4 ? 0.5 : 0.2)) {
            playVoice('mus_hit', rng() < 0.5 ? 0 : 1, barTime, mix.hit * (0.7 + 0.3 * rng()), {
              kind: 'hit'
            });
          }
        } else if (tier === 1 && (barInCycle === 0 || (barInCycle === 4 && rng() < 0.4))) {
          playVoice('mus_hit', barInCycle === 0 ? 0 : 1, barTime, mix.hit * 0.85, {
            kind: 'hit'
          });
        }
      }
    }
  }
  return director;
}
