# Saltline game source

TypeScript source for the Saltline browser FPS.
It was recovered from the single minified bundle that used to live in `public/game/`:
three.js now comes from npm (`three@0.180.0`, pinned because several shaders patch
three's built-in shader chunks), and the game is bundled by the app's normal
`vite.config.ts`.

## How it runs

- `src/routes/game.tsx` renders the DOM shell (`#app`, `#view`, `#ui`, `#boot`), links the
  game styles for that route only, and lazy-loads `main.ts` on the client, then calls
  `startSaltline()`. The game code ships as its own chunk.
- The landing page (`src/components/SaltlinePlayer.tsx`) embeds `/game` in an iframe, so
  closing the player tears down the whole game (rAF loop, audio, pointer lock).
- Almost every texture, mesh and sound is generated in code. The static assets are the
  fonts in `assets/fonts/`, the guard character (`public/models/guard.glb`, see below) and
  recorded footsteps (`public/audio/steps/`: CC0 stone steps from "Fantozzi's Footsteps", see
  `LICENSE.txt`). There are only two footstep sounds: the recorded human step (player and
  guards, every surface; `audio/engine.ts` swaps it in for the synthesized `step_concrete` /
  `guard_step` once decoded) and the synthesized robot-dog `hound_step`.

## Layout

| Folder | What it does |
| --- | --- |
| `main.ts` | Boot sequence, main loop, debug/benchmark hooks |
| `core/` | `Game` context type, config and quality presets, event bus, seeded RNG, math, subsystem stubs |
| `render/` | Renderer, sky, soft shadows, post-processing chain, geometry helpers |
| `materials/` | GPU-baked surface textures, decals/labels, material library with wetness patches |
| `world/` | Collision world and nav grid (`physics.ts`), explosive barrels |
| `props/` | Prop registry plus procedural builders (containers, fixtures, cargo, machinery) |
| `level/` | Level layout: yard, shed, site office, quay edge, objectives |
| `backdrop/` | Quay crane, container ship, moored boat, skyline, gulls |
| `ground/` | Wet apron, puddles, planar reflection, sea, rain |
| `fx/` | Particles, tracers, debris, shell casings, decals |
| `audio/` | Procedural sound: DSP, weapon/world SFX, generative music, mixer and engine |
| `weapon/` | Viewmodels (rifle, pistol), procedural hands and arms, grip solver, weapon controller |
| `enemies/` | Drone ("gull") and quadruped ("hound") robots, human port-security guards (animated character model), enemy AI manager |
| `input/`, `player/` | Keyboard/mouse/touch/gamepad input, player movement |
| `session/` | Game flow (mission, holdout, difficulty, radio), hit resolution |
| `ui/` | HUD and menus |

## Conventions

- Subsystem factories take the shared `Game` context (`core/types.ts`) and return an explicit
  exported interface (`RenderSystem`, `FxSystem`, `AudioSystem`, ...).
- Prop builders register themselves through `props/index.ts`, which `main.ts` imports for
  its side effect. Without it every prop falls back to a plain box.
- World generation is deterministic: it draws from seeded RNGs in a fixed order. When editing
  generation code, keep the order of `rng()` calls unchanged, or the level changes.

## Debug URL parameters

`/game?autostart=1` skips the title screen, `?bench=1` runs the benchmark fly-through with an
FPS/error overlay, `?show=<props|hands|enemies|fx|mats|weapon|ground|backdrop|level|render>`
opens a subsystem showcase, and `?q=<low|medium|high|ultra>` forces a quality preset.
`?mode=holdout` starts Holdout instead of the mission, `?god=1` makes the player
invulnerable for QA, and `?qa=guard` stands a passive guard 11 m ahead with the view on him
(a click fires in QA mode) plus an alerted one nearby. The enemies showcase takes `&eshow=guard`
(patrol walk), `guardaim` / `guardkneel` (standing / kneeling aim) and `guarddead` (death clip).
`?rain=0` forces clear weather (the Weather setting, Rain or Clear, applies otherwise).
`?detail=0` turns off the quality-driven scene detail (`render/detail.ts`: distance culling of
small level objects, no sun shadows from out-of-bounds objects on low/medium, and on low the
backdrop's minor detail meshes and small out-of-bounds clutter hidden) for before/after checks.

## Guard character model

The guards load `public/models/guard.glb` (about 2 MB), Mixamo's "Swat Guy"
with clips from its Pro Rifle Pack (`idle`, `aim`, `walk`, `run`, `crouch`, `crouchAim` and six
death clips). `enemies/guardAsset.ts` starts loading it at boot, mounts the procedural carbine in
the right hand (calibrated from the aiming clip), and clones a skeleton and mixer per guard. If the
file fails to load, the guards fall back to the procedural rig in `enemies/guard.ts`.

The GLB was built offline from the Mixamo FBX downloads: FBXLoader in Node, materials merged
into two groups, clips trimmed (walk and run made in place), exported with GLTFExporter, then
gltf-transform with meshoptimizer (weld, simplify to about 28k triangles, quantize, meshopt
compression), with the diffuse and normal maps resized to 1024 px JPEG and embedded (before
the optimise step, so the UVs survive pruning). The balaclava's face island in the first diffuse
map is repainted with a skin tone and a mouth (painted from a texel-to-position map so the lips
land about 4.5 cm above the chin), the carbine is seated from the palm centres (grip in the right
palm, handguard on the left palm), and the albedo is lifted at load time because the source
textures are very dark. Mixamo's
terms allow the model and animations inside a game but not redistributing the raw FBX files, so
those stay out of the repository.
