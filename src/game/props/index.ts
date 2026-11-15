// Side-effect module: registers every procedural prop builder with the prop registry
// (port fixtures register themselves on load; cargo, soft cargo and machinery are
// registered below, in the same order as the original bundle). `main.ts` imports it
// once before any prop is built; without it every prop falls back to a plain box.
import './portFixtures';
import { registerProp } from './registry';
import { registerCargoProps } from './cargo';
import { registerSoftCargoProps } from './softCargo';
import { registerMachineryProps } from './machinery';

registerCargoProps(registerProp);
registerSoftCargoProps(registerProp);
registerMachineryProps(registerProp);
