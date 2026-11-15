// Drifter animation set, keyframed by hand. See rig.js for the pose format.
// Numbers are metres / degrees in model space (+Z forward, +X = character's left, +Y up).
import * as THREE from "three";
import { mirrorPose } from "./rig.js";

// ------------------------------------------------------------------ helpers
const RA = { x: 0.155, z: -0.03 };          // rest ankle (left; right is mirrored)
const L = (x, y, z, o = {}) => ({ p: [x - RA.x, y, z - RA.z], ...o });     // left ankle at absolute x/z, y = lift above the floor
const R = (x, y, z, o = {}) => ({ p: [x + RA.x, y, z - RA.z], ...o });
const H = (x, y, z, o = {}) => ({ p: [x, y, z], cs: 0, ...o });   // wrist target, model / world space
const C = (x, y, z, o = {}) => ({ p: [x, y, z], cs: 1, ...o });   // wrist target, rides with the chest (blends smoothly with H)
const HIPS_Y = 0.92;
const lerp = (a, b, t) => a + (b - a) * t;
const ss = (t) => t * t * (3 - 2 * t);
const deep = (o) => JSON.parse(JSON.stringify(o));
const mix = (a, b) => Object.assign(deep(a), deep(b));

// relaxed standing pose: knees soft, feet under the hips, arms hanging with a little bend
const STAND = {
  hips: [0, -0.025, 0], hipsRot: [0, 0, 0], torso: [3, 0, 0], neck: [0, 0, 0], headAbs: [2, 0, 0], lClav: [0, 0, 0], rClav: [0, 0, 0],
  lFoot: L(0.115, 0, 0, { yaw: 7 }), rFoot: R(-0.115, 0, 0, { yaw: -7 }),
  lHand: C(0.232, 0.895, 0.035, { aim: [0, 0, 1], fing: [-0.05, -1, 0.08] }), rHand: C(-0.232, 0.895, 0.035, { aim: [0, 0, 1], fing: [0.05, -1, 0.08] }),
  lGrip: 0.35, rGrip: 0.35,
};
// foot pivots: an ankle given a contact point and a foot pitch (heel strike pivots on the heel, toe-off on the ball)
function anklePivot(zc, theta) {   // zc = where the ankle sits when the foot is flat; returns {y lift, z}
  const r = theta * Math.PI / 180;
  if (theta < 0) {     // toes up, heel on the floor
    const hy = 0.10, hz = 0.06; return { y: hy * Math.cos(r) - hz * Math.sin(r) - 0.10, z: zc - 0.06 + hy * Math.sin(r) + hz * Math.cos(r) };
  }
  const by = 0.065, bz = -0.115;   // ball -> ankle
  return { y: 0.035 + by * Math.cos(r) - bz * Math.sin(r) - 0.10, z: zc + 0.115 + by * Math.sin(r) + bz * Math.cos(r) };
}

// ------------------------------------------------------------------ gait generator (walk / sprint / pipe walk)
// Feet follow real ground contact: heel strike -> flat -> roll onto the ball -> swing. While a foot is on the
// floor it slides back at exactly the travel speed, so in-game the planted foot does not skate.
function gait(o) {
  const T = o.T, v = 2 * o.step / T, a = v * o.duty * T / 2, N = o.n || 24;
  const footAt = (ph) => {
    ph = ((ph % 1) + 1) % 1;
    if (ph < o.duty) {
      const s = ph / o.duty, zc = a - 2 * a * s + o.zOff;
      let th = 0;
      if (s < o.heelEnd) th = -o.heel * (1 - ss(s / o.heelEnd));
      else if (s > o.ballStart) th = o.toe * Math.pow((s - o.ballStart) / (1 - o.ballStart), 1.6);
      const k = anklePivot(zc, th); return { y: k.y, z: k.z, pitch: th, toe: th > 0 ? -th : 0 };
    }
    const s = (ph - o.duty) / (1 - o.duty);
    const A = anklePivot(-a + o.zOff, o.toe), B = anklePivot(a + o.zOff, -o.heel);
    const e = ss(s);
    const pitch = lerp(o.toe, -o.heel, ss(Math.min(1, s * 1.25))) + o.swingPitch * Math.sin(Math.PI * s);
    return { y: lerp(A.y, B.y, s) + o.lift * Math.sin(Math.PI * Math.pow(s, 0.85)), z: lerp(A.z, B.z, e), pitch, toe: -o.toe * (1 - ss(Math.min(1, s * 2))) };
  };
  const keys = [];
  for (let i = 0; i < N; i++) {
    const ph = i / N, t = ph * T, c2 = Math.cos(2 * Math.PI * ph), c4 = Math.cos(4 * Math.PI * (ph - o.bobPhase));
    const lf = footAt(ph), rf = footAt(ph + 0.5);
    const yaw = -o.yaw * c2;
    const k = {
      t, hips: [o.sway * Math.cos(2 * Math.PI * (ph - o.duty / 2)), o.hipsY - o.bob * c4, 0], hipsRot: [o.hipsPitch, yaw, o.roll * Math.sin(2 * Math.PI * ph)],
      torso: [o.lean, -yaw * o.counter, 0], neck: [0, 0, 0], headAbs: [o.head ?? 2, 0, 0], lClav: [0, o.clav * c2, 0], rClav: [0, o.clav * c2, 0],
      lFoot: L(o.width, lf.y, lf.z, { pitch: lf.pitch, toe: lf.toe, yaw: 5 }), rFoot: R(-o.width, rf.y, rf.z, { pitch: rf.pitch, toe: rf.toe, yaw: -5 }),
      lGrip: o.grip, rGrip: o.grip,
    };
    // arms swing opposite the legs (left arm forward when the right foot is forward)
    const sw = (side) => {
      const sgn = side === "l" ? 1 : -1, f = -sgn * c2;      // +1 = forward
      const z = o.armZ0 + o.armZ * f, y = o.armY + o.armLift * Math.max(0, f) - o.armDrop * Math.max(0, -f);
      return C(sgn * (o.armX - o.armIn * Math.max(0, f)), y, z, { aim: [0, f > 0 ? 0.6 : 0.2, 1], fing: [-sgn * 0.1, -0.6 + 0.6 * Math.max(0, f) * o.bend, 0.5 * Math.max(0, f) * o.bend + 0.1], elbow: [sgn * 0.5, -0.3, -1] });
    };
    k.lHand = sw("l"); k.rHand = sw("r");
    if (o.pipe) { k.rHand = deep(PIPE_HOLD_R); k.rGrip = 1; }
    keys.push(k);
  }
  return { keys, dur: T, loop: true, speed: v };
}
// pipe held low and ready in the right hand (chest space so it rides with the torso)
const PIPE_HOLD_R = C(-0.215, 1.0, 0.2, { aim: [0.2, 0.7, 0.7], fing: [0.2, 0, 1], elbow: [-0.6, -0.4, -1] });

// ------------------------------------------------------------------ clip catalogue
export function buildClips(rig, gltfAnims, model) {
  const LIB = {};
  const add = (spec, meta = {}) => {
    const r = rig.bake(spec);
    LIB[spec.name] = { clip: r.clip, rm: r.rm, warn: r.warn, loop: !!spec.loop, speed: spec.speed, ...meta };
  };
  const src = Object.fromEntries((gltfAnims || []).map((c) => [c.name, c]));

  // ================================================================ LOCOMOTION
  add({
    name: "Idle", dur: 4, loop: true, keys: [
      { t: 0, ...STAND },
      { t: 1.0, ...mix(STAND, { upper: [-2, 0, 0], lClav: [0, 0, 3], rClav: [0, 0, -3], hips: [0.008, -0.022, 0], headAbs: [1, 4, 0] }) },
      { t: 2.0, ...mix(STAND, { hips: [0.018, -0.03, 0], hipsRot: [0, 0, -1.5], torso: [3, 0, 1], headAbs: [3, 7, -1] }) },
      { t: 3.0, ...mix(STAND, { upper: [-2, 0, 0], lClav: [0, 0, 3], rClav: [0, 0, -3], hips: [0.008, -0.022, 0], headAbs: [1, -3, 0] }) },
    ],
  }, { group: "Locomotion", desc: "Breathing idle: weight drifts between the feet, chest rises, the head looks around a little. Feet never move." });

  const WALK = { T: 1.04, step: 0.52, duty: 0.6, lift: 0.07, hipsY: -0.045, bob: 0.018, bobPhase: 0.0, sway: 0.022, yaw: 6, counter: 1.3,
    hipsPitch: 0, roll: 2, lean: 4, clav: 2, width: 0.1, zOff: 0.02, heel: 16, toe: 32, heelEnd: 0.16, ballStart: 0.55, swingPitch: -6,
    armX: 0.225, armIn: 0.02, armZ0: 0.03, armZ: 0.13, armY: 0.9, armLift: 0.05, armDrop: 0.0, bend: 0.5, grip: 0.35 };
  add({ name: "Walking", ...gait(WALK) }, { group: "Locomotion", desc: "Heel strike, roll, push off the ball. Planted feet slide back at exactly the walk speed (1.0 m/s), so nothing skates." });

  const SPRINT = { T: 0.56, step: 1.6, duty: 0.24, lift: 0.3, hipsY: -0.075, bob: 0.025, bobPhase: 0.12, sway: 0.01, yaw: 10, counter: 1.4,
    hipsPitch: 6, roll: 2, lean: 16, clav: 6, width: 0.07, zOff: 0.06, heel: 0, toe: 40, heelEnd: 0.05, ballStart: 0.3, swingPitch: -10,
    armX: 0.2, armIn: 0.06, armZ0: 0.0, armZ: 0.28, armY: 1.02, armLift: 0.2, armDrop: 0.06, bend: 1, grip: 0.7, n: 20 };
  const sp = gait(SPRINT);
  // the sprint lands on the forefoot: lift the contact so the heel never touches
  add({ name: "Sprint", ...sp }, { group: "Locomotion", desc: "Forefoot sprint: big knee drive, strong arm pump, body leaning into the run." });

  add({ name: "Pipe_Walk", ...gait({ ...WALK, pipe: true }) }, { group: "Pipe", pipe: true, desc: "Walk with the pipe held ready in the right hand." });

  // ================================================================ AIR
  const CROUCH = mix(STAND, { hips: [0, -0.2, 0.03], torso: [18, 0, 0], headAbs: [-4, 0, 0], lFoot: L(0.12, 0, 0, { yaw: 7 }), rFoot: R(-0.12, 0, 0, { yaw: -7 }) });
  const AIR = mix(STAND, {
    hips: [0, 0.02, 0], torso: [6, 0, 0], headAbs: [4, 0, 0],
    lFoot: L(0.12, 0.3, 0.1, { pitch: 20, knee: [0.1, 0, 1] }), rFoot: R(-0.12, 0.16, -0.12, { pitch: 30 }),
    lHand: C(0.36, 1.18, 0.12, { aim: [0, 0.3, 1], fing: [0.4, -0.6, 0.3] }), rHand: C(-0.38, 1.14, 0.0, { aim: [0, 0.3, 1], fing: [-0.4, -0.6, 0.2] }),
    lClav: [0, 0, 8], rClav: [0, 0, -8], lGrip: 0.3, rGrip: 0.3,
  });
  add({
    name: "Jump", dur: 0.5, keys: [
      { t: 0, ...mix(CROUCH, { lHand: C(0.25, 0.92, -0.2, { aim: [0, 0, 1], fing: [0, -1, -0.3] }), rHand: C(-0.25, 0.92, -0.2, { aim: [0, 0, 1], fing: [0, -1, -0.3] }) }) },
      { t: 0.1, ...mix(STAND, { hips: [0, 0.06, 0.03], torso: [8, 0, 0], lFoot: L(0.11, 0.04, -0.04, { pitch: 45 }), rFoot: R(-0.11, 0.02, -0.04, { pitch: 45 }),
        lHand: C(0.28, 1.35, 0.25, { aim: [0, 0.4, 1], fing: [0, 0.2, 1] }), rHand: C(-0.28, 1.35, 0.25, { aim: [0, 0.4, 1], fing: [0, 0.2, 1] }), lClav: [0, 0, 10], rClav: [0, 0, -10] }) },
      { t: 0.3, ...mix(AIR, { lFoot: L(0.12, 0.36, 0.14, { pitch: 15, knee: [0.1, 0, 1] }), rFoot: R(-0.12, 0.2, -0.1, { pitch: 30 }) }) },
      { t: 0.5, ...AIR },
    ],
  }, { group: "Air", desc: "Take-off: drive up through the toes, arms swing up, then tuck the lead knee. Hands off to the fall pose." });
  add({
    name: "Fall", dur: 1.2, loop: true, keys: [
      { t: 0, ...AIR },
      { t: 0.6, ...mix(AIR, { lFoot: L(0.12, 0.2, 0.0, { pitch: 25 }), rFoot: R(-0.12, 0.24, 0.02, { pitch: 22, knee: [-0.1, 0, 1] }),
        lHand: C(0.38, 1.22, 0.04, { aim: [0, 0.3, 1], fing: [0.4, -0.6, 0.2] }), rHand: C(-0.36, 1.2, 0.1, { aim: [0, 0.3, 1], fing: [-0.4, -0.6, 0.3] }), torso: [4, 0, 1] }) },
    ],
  }, { group: "Air", desc: "Airborne loop: legs cycle slowly, arms out for balance, ready to land." });
  const LANDED = mix(CROUCH, { hips: [0, -0.3, 0.02], torso: [26, 0, 0], lFoot: L(0.13, 0, 0.02, { yaw: 8 }), rFoot: R(-0.13, 0, -0.02, { yaw: -8 }),
    lHand: C(0.27, 0.95, 0.3, { aim: [0, 0.2, 1], fing: [0, -1, 0.4] }), rHand: C(-0.27, 0.95, 0.3, { aim: [0, 0.2, 1], fing: [0, -1, 0.4] }), headAbs: [-2, 0, 0] });
  add({
    name: "Land", dur: 0.55, keys: [
      { t: 0, ...mix(AIR, { lFoot: L(0.13, 0.04, 0.02, { pitch: 20 }), rFoot: R(-0.13, 0.04, -0.02, { pitch: 20 }) }) },
      { t: 0.09, ...LANDED },
      { t: 0.2, ...mix(LANDED, { hips: [0, -0.26, 0.02] }) },
      { t: 0.55, ...STAND },
    ],
  }, { group: "Air", desc: "Hard landing: toes touch first, knees and hips absorb, then stand." });
  // forward roll (in place, the controller carries the speed). Hips pitch through a full turn; tucked feet are
  // placed in the hips frame and converted to model space so the whole clip uses one space (no pops).
  const rollFoot = (hy, hz, pitch, tuck, x) => {
    const r = pitch * Math.PI / 180, ly = -0.8 + 0.42 * tuck, lz = 0.3 * tuck;
    const y = HIPS_Y + hy + ly * Math.cos(r) - lz * Math.sin(r), z = hz + ly * Math.sin(r) + lz * Math.cos(r);
    return { y: Math.max(0, y - 0.1), z, pitch: pitch + 20 * tuck };
  };
  const ROLL = (t, pitch, hy, hz, tuck) => {
    const lf = rollFoot(hy, hz, pitch, tuck), rf = rollFoot(hy, hz, pitch, tuck * 0.95);
    return {
      t, hips: [0, hy, hz], hipsRot: [pitch, 0, 0], torso: [20 + 45 * tuck, 0, 0], neck: [30 * tuck, 0, 0], head: [25 * tuck, 0, 0],
      lClav: [0, 0, 0], rClav: [0, 0, 0],
      lFoot: L(0.11, lf.y, lf.z, { pitch: lf.pitch, knee: [0.1, 0, 1] }), rFoot: R(-0.11, rf.y, rf.z, { pitch: rf.pitch, knee: [-0.1, 0, 1] }),
      lHand: C(0.2, 1.0 + 0.1 * tuck, 0.35, { aim: [0, 0, 1], fing: [0, -1, 0.5] }), rHand: C(-0.2, 1.0 + 0.1 * tuck, 0.35, { aim: [0, 0, 1], fing: [0, -1, 0.5] }), lGrip: 0.4, rGrip: 0.4,
    };
  };
  add({
    name: "Roll_Land", dur: 0.85, keys: [
      { ...LANDED, t: 0, head: [0, 0, 0], neck: [0, 0, 0], hipsRot: [10, 0, 0] },
      { ...ROLL(0.12, 55, -0.42, 0.22, 0.6), lFoot: L(0.11, 0.02, 0.1, { pitch: 30 }), rFoot: R(-0.11, 0.02, 0.06, { pitch: 35 }) },
      ROLL(0.3, 160, -0.2, 0.12, 1),
      ROLL(0.48, 260, -0.5, 0.02, 1),
      { ...ROLL(0.62, 335, -0.42, -0.02, 0.8), lFoot: L(0.11, 0.0, 0.08, { pitch: 0 }), rFoot: R(-0.11, 0.0, 0.05, { pitch: 0 }) },
      { ...STAND, t: 0.85, hipsRot: [360, 0, 0], head: [0, 0, 0], neck: [0, 0, 0] },
    ].map((k) => { delete k.headAbs; return k; }),
  }, { group: "Air", desc: "Drop roll: tuck, roll over the shoulder, come up on the feet. Carries momentum in the game." });

  // ================================================================ PARKOUR
  // Vault: low obstacle 0.9 m high, near face 0.8 m ahead, 0.7 m deep. Left hand plants, legs pass to the right.
  const VB = { z0: 0.8, z1: 1.5, h: 0.9 };
  add({
    name: "Vault", dur: 0.78, world: true, keys: [
      { t: 0, root: [0, 0, 0], ...mix(STAND, { hips: [0, HIPS_Y - 0.1, 0.05], torso: [14, 0, 0], lFoot: L(0.09, 0, 0.0, { pitch: 10 }), rFoot: R(-0.09, 0.12, -0.25, { pitch: 30 }),
        lHand: H(0.22, 1.0, 0.0, { aim: [0, 0.3, 1], fing: [0, -0.7, 0.6] }), rHand: H(-0.22, 1.05, 0.25, { aim: [0, 0.3, 1], fing: [0, -0.7, 0.6] }) }) },
      { t: 0.14, root: [0, 0, 0.5], ...mix(STAND, { hips: [0, HIPS_Y + 0.02, 0.5], torso: [24, 0, 0], lFoot: L(0.09, 0.02, 0.2, { pitch: 45 }), rFoot: R(-0.12, 0.3, 0.55, { pitch: 10, knee: [-0.2, 0.3, 1] }),
        lHand: H(0.16, VB.h + 0.08, 1.0, { aim: [-0.3, 0, 1], fing: [0, -0.3, 1] }), rHand: H(-0.25, 1.15, 0.6, { aim: [0, 0.3, 1], fing: [0, -0.5, 0.8] }) }) },
      { t: 0.27, root: [0, 0, 1.0], ...mix(STAND, { hips: [-0.12, VB.h + 0.42, 1.0], hipsRot: [0, -25, -15], torso: [10, 20, 8], lFoot: L(-0.2, VB.h + 0.1, 0.9, { pitch: 30, knee: [-0.6, 0.4, 0.5] }), rFoot: R(-0.42, VB.h + 0.14, 1.15, { pitch: 20, knee: [-0.6, 0.4, 0.6] }),
        lHand: H(0.12, VB.h + 0.03, 1.08, { aim: [-1, 0, 0.2], fing: [0, -0.2, 1] }), rHand: H(-0.42, 1.45, 1.05, { aim: [0, 0.3, 1], fing: [-0.5, 0, 0.6] }) }) },
      { t: 0.4, root: [0, 0, 1.55], ...mix(STAND, { hips: [-0.1, VB.h + 0.25, 1.55], hipsRot: [0, -15, -8], torso: [4, 10, 4], lFoot: L(-0.05, 0.42, 1.85, { pitch: 10 }), rFoot: R(-0.25, 0.3, 1.95, { pitch: 5 }),
        lHand: H(0.3, 1.35, 1.35, { aim: [0, 0.3, 1], fing: [0.3, -0.3, 0.6] }), rHand: H(-0.4, 1.3, 1.6, { aim: [0, 0.3, 1], fing: [-0.4, -0.3, 0.6] }) }) },
      { t: 0.53, root: [0, 0, 2.05], ...mix(STAND, { hips: [-0.04, HIPS_Y - 0.14, 2.05], hipsRot: [0, -5, 0], torso: [16, 0, 0], lFoot: L(0.06, 0.12, 1.95, { pitch: 20 }), rFoot: R(-0.1, 0, 2.18, { pitch: 0 }),
        lHand: H(0.28, 1.1, 2.15, { aim: [0, 0.3, 1], fing: [0, -0.6, 0.6] }), rHand: H(-0.26, 1.05, 1.95, { aim: [0, 0.3, 1], fing: [0, -0.6, 0.6] }) }) },
      { t: 0.66, root: [0, 0, 2.45], ...mix(STAND, { hips: [0, HIPS_Y - 0.08, 2.48], torso: [12, 0, 0], lFoot: L(0.09, 0.0, 2.68, { pitch: -10 }), rFoot: R(-0.09, 0.06, 2.22, { pitch: 35 }),
        lHand: H(0.24, 1.0, 2.35, { aim: [0, 0.3, 1], fing: [0, -0.6, 0.6] }), rHand: H(-0.24, 1.02, 2.62, { aim: [0, 0.3, 1], fing: [0, -0.6, 0.6] }) }) },
      { t: 0.78, root: [0, 0, 2.75], ...mix(STAND, { hips: [0, HIPS_Y - 0.07, 2.8], torso: [12, 0, 0], lFoot: L(0.09, 0.0, 2.68, { pitch: 20 }), rFoot: R(-0.09, 0.14, 2.75, { pitch: 30 }),
        lHand: H(0.24, 1.02, 2.9, { aim: [0, 0.3, 1], fing: [0, -0.6, 0.6] }), rHand: H(-0.24, 1.0, 2.7, { aim: [0, 0.3, 1], fing: [0, -0.6, 0.6] }) }) },
    ],
  }, { group: "Parkour", props: [{ box: [0, VB.h / 2, (VB.z0 + VB.z1) / 2, 3, VB.h, VB.z1 - VB.z0] }], focus: [0, 0.9, 1.3], dist: 5.5,
    desc: "Speed vault over a waist-high block: left hand plants on top, legs swing past on the right, land running." });

  add({
    name: "Slide", dur: 1.0, keys: [
      { t: 0, ...mix(STAND, { hips: [0, -0.1, 0.05], torso: [12, 0, 0], lFoot: L(0.09, 0, 0.1, { pitch: 10 }), rFoot: R(-0.09, 0.1, -0.2, { pitch: 30 }),
        lHand: C(0.22, 0.98, -0.05), rHand: C(-0.22, 1.0, 0.2) }) },
      { t: 0.14, ...mix(STAND, { hips: [0, -0.42, -0.05], hipsRot: [-10, 10, 0], torso: [-6, -10, 0], lFoot: L(0.16, 0.02, -0.05, { pitch: 30, knee: [0.6, 0.3, 1] }), rFoot: R(-0.1, 0.12, 0.45, { pitch: -20 }),
        lHand: C(0.32, 0.9, -0.15), rHand: C(-0.3, 1.15, 0.3) }) },
      { t: 0.28, ...mix(STAND, { hips: [0, -0.7, -0.05], hipsRot: [-22, 12, 0], torso: [-4, -10, 0], headAbs: [10, -6, 0], lFoot: L(0.06, 0.02, 0.32, { pitch: -10, yaw: 40, knee: [1, 0.6, 0.4] }), rFoot: R(-0.1, 0.04, 0.72, { pitch: -45 }),
        lHand: H(0.36, 0.22, -0.28, { aim: [0, 0, 1], fing: [0.4, -1, -0.3] }), rHand: C(-0.28, 1.2, 0.32, { aim: [0, 0.4, 1], fing: [0, 0, 1] }), lGrip: 0.15 }) },
      { t: 0.68, ...mix(STAND, { hips: [0, -0.7, -0.03], hipsRot: [-22, 12, 0], torso: [-2, -10, 0], headAbs: [10, -6, 0], lFoot: L(0.06, 0.02, 0.32, { pitch: -10, yaw: 40, knee: [1, 0.6, 0.4] }), rFoot: R(-0.1, 0.04, 0.72, { pitch: -45 }),
        lHand: H(0.36, 0.2, -0.26, { aim: [0, 0, 1], fing: [0.4, -1, -0.3] }), rHand: C(-0.28, 1.18, 0.34, { aim: [0, 0.4, 1], fing: [0, 0, 1] }), lGrip: 0.15 }) },
      { t: 0.84, ...mix(STAND, { hips: [0, -0.32, 0.12], torso: [24, 0, 0], lFoot: L(0.1, 0, 0.0, { pitch: 20 }), rFoot: R(-0.1, 0, 0.32, { pitch: 0 }),
        lHand: C(0.25, 1.0, 0.2), rHand: C(-0.25, 1.0, 0.25) }) },
      { t: 1.0, ...mix(STAND, { hips: [0, -0.1, 0.05], torso: [12, 0, 0], lFoot: L(0.09, 0.08, 0.05, { pitch: 25 }), rFoot: R(-0.09, 0, 0.22, { pitch: 5 }),
        lHand: C(0.22, 1.0, 0.15), rHand: C(-0.22, 0.98, -0.05) }) },
    ],
  }, { group: "Parkour", desc: "Baseball slide: drop low, lead leg straight, trailing hand skims the floor, spring back up into the run." });

  // Mantle onto a chest-high block (1.5 m), near face 0.45 m ahead.
  const MB = { z0: 0.45, h: 1.5 };
  const grabL = { aim: [-1, 0, 0], fing: [0, 0.25, 1] }, grabR = { aim: [1, 0, 0], fing: [0, 0.25, 1] };
  // authored for a near face at z0 = 0.45 (box) / 0.6 (wall): later keys shift with the real distance
  const shiftZ = (spec, dz) => {
    if (Math.abs(dz) < 1e-4) return spec;
    spec.keys.forEach((k, i) => {
      if (i === 0) return;
      const sh = (a) => { if (a) a[2] += dz; };
      sh(k.root); sh(k.hips); for (const n of ["lHand", "rHand", "lFoot", "rFoot"]) if (k[n] && !k[n].cs) sh(k[n].p);
    });
    return spec;
  };
  const boxClimbSpec = (MB, name = "Climb_Box") => shiftZ(boxClimbSpecRaw({ ...MB, z0: 0.45 }, name), MB.z0 - 0.45);
  const wallSpec = (WB, name = "Wall_Climb") => shiftZ(wallSpecRaw({ ...WB, z0: 0.6 }, name), WB.z0 - 0.6);
  const boxClimbSpecRaw = (MB, name) => ({
    name, dur: 1.15, world: true, keys: [
      { t: 0, root: [0, 0, 0], ...mix(CROUCH, { hips: [0, HIPS_Y - 0.15, 0.04], lHand: H(0.24, 1.15, 0.2, { aim: [0, 0.4, 1], fing: [0, 0.2, 1] }), rHand: H(-0.24, 1.15, 0.2, { aim: [0, 0.4, 1], fing: [0, 0.2, 1] }) }) },
      { t: 0.16, root: [0, 0.1, 0.05], ...mix(STAND, { hips: [0, HIPS_Y + 0.12, 0.05], torso: [10, 0, 0], lFoot: L(0.11, 0.08, 0.0, { pitch: 40 }), rFoot: R(-0.11, 0.2, 0.15, { pitch: 20 }),
        lHand: H(0.21, MB.h + 0.0, MB.z0 + 0.05, grabL), rHand: H(-0.21, MB.h + 0.0, MB.z0 + 0.05, grabR), lClav: [0, 0, 14], rClav: [0, 0, -14], lGrip: 0.6, rGrip: 0.6 }) },
      { t: 0.36, root: [0, 0.6, 0.12], ...mix(STAND, { hips: [0, MB.h - 0.1, 0.12], torso: [22, 0, 0], lFoot: L(0.12, 0.5, 0.3, { pitch: 0 }), rFoot: R(-0.12, 0.35, 0.2, { pitch: 20 }),
        lHand: H(0.21, MB.h - 0.01, MB.z0 + 0.05, { ...grabL, elbow: [0.4, -0.3, -1] }), rHand: H(-0.21, MB.h - 0.01, MB.z0 + 0.05, { ...grabR, elbow: [-0.4, -0.3, -1] }), lGrip: 0.6, rGrip: 0.6 }) },
      { t: 0.56, root: [0, 1.1, 0.3], ...mix(STAND, { hips: [0, MB.h + 0.32, 0.32], torso: [48, 0, 0], headAbs: [10, 0, 0], lFoot: L(0.12, 0.85, 0.32, { pitch: 30 }), rFoot: R(-0.1, MB.h, MB.z0 + 0.22, { pitch: 35, knee: [0, 0.6, 1] }),
        lHand: H(0.22, MB.h + 0.02, MB.z0 + 0.12, { aim: [-0.3, 0, 1], fing: [0.3, -1, 0.3], elbow: [0.4, 0.2, -1] }), rHand: H(-0.22, MB.h + 0.02, MB.z0 + 0.12, { aim: [0.3, 0, 1], fing: [-0.3, -1, 0.3], elbow: [-0.4, 0.2, -1] }), lGrip: 0.2, rGrip: 0.2 }) },
      { t: 0.8, root: [0, MB.h, 0.55], ...mix(STAND, { hips: [0, MB.h + 0.64, 0.6], torso: [28, 0, 0], lFoot: L(0.11, MB.h + 0.12, MB.z0 + 0.2, { pitch: 30 }), rFoot: R(-0.1, MB.h, MB.z0 + 0.25, { pitch: 0 }),
        lHand: H(0.26, MB.h + 0.8, 0.75, { aim: [0, 0.3, 1], fing: [0, -0.8, 0.4] }), rHand: H(-0.26, MB.h + 0.78, 0.78, { aim: [0, 0.3, 1], fing: [0, -0.8, 0.4] }) }) },
      { t: 1.15, root: [0, MB.h, 0.82], ...mix(STAND, { hips: [0, MB.h + HIPS_Y - 0.03, 0.82], lFoot: L(0.115, MB.h, 0.82, { yaw: 7 }), rFoot: R(-0.115, MB.h, 0.8, { yaw: -7 }),
        lHand: H(0.232, MB.h + 0.895, 0.86, { aim: [0, 0, 1], fing: [-0.05, -1, 0.08] }), rHand: H(-0.232, MB.h + 0.895, 0.84, { aim: [0, 0, 1], fing: [0.05, -1, 0.08] }) }) },
    ],
  });
  add(boxClimbSpec(MB), { group: "Parkour", props: [{ box: [0, MB.h / 2, MB.z0 + 1, 3, MB.h, 2] }], focus: [0, 1.4, 0.6], dist: 5,
    desc: "Mantle: hop, hands catch the edge, walk the feet up, knee onto the top, stand. Hands stay pinned to the edge." });

  // ---------------------------------------------------------------- ledge hang (edge 0.24 m in front of the root, top 1.66 m above it)
  const EDGE = { z: 0.24, y: 1.66 };
  const HANG = mix(STAND, {
    hips: [0, -0.07, -0.03], hipsRot: [4, 0, 0], torso: [6, 0, 0], headAbs: [-12, 0, 0], lClav: [0, 0, 18], rClav: [0, 0, -18],
    lHand: H(0.21, EDGE.y - 0.015, EDGE.z - 0.015, { ...grabL, elbow: [0.5, -0.4, -1] }), rHand: H(-0.21, EDGE.y - 0.015, EDGE.z - 0.015, { ...grabR, elbow: [-0.5, -0.4, -1] }),
    lFoot: L(0.12, -0.02, 0.1, { pitch: 30, knee: [0.1, 0, 1] }), rFoot: R(-0.12, 0.04, 0.12, { pitch: 25, knee: [-0.1, 0, 1] }), lGrip: 0.62, rGrip: 0.62,
  });
  const hangProps = [{ box: [0, EDGE.y / 2, EDGE.z + 1, 3, EDGE.y, 2] }];
  add({
    name: "Hang_Idle", dur: 2.4, loop: true, keys: [
      { t: 0, ...HANG },
      { t: 1.2, ...mix(HANG, { hips: [0.01, -0.075, -0.02], torso: [7, 0, 0.6], lFoot: L(0.12, 0.0, 0.11, { pitch: 28 }), rFoot: R(-0.12, 0.02, 0.1, { pitch: 30 }), headAbs: [-10, 5, 0] }) },
    ],
  }, { group: "Ledge", props: hangProps, focus: [0, 1.2, 0.3], dist: 4, hang: EDGE,
    desc: "Hanging from a ledge: fingers over the top, chest just off the wall, toes resting on it. Nothing goes through the block." });
  {
    const N = 16, T = 1.0, travel = 0.5, duty = 0.55, keys = [];   // shimmy left at 0.5 m/s
    for (let i = 0; i < N; i++) {
      const ph = i / N;
      const hand = (side, off) => {
        let q = ((ph + off) % 1 + 1) % 1, x, y = 0;
        if (q < duty) x = travel / 2 - travel * (q / duty); else { const s = (q - duty) / (1 - duty); x = -travel / 2 + travel * ss(s); y = 0.06 * Math.sin(Math.PI * s); }
        return { x: (side === "l" ? 0.24 : -0.24) + x, y };
      };
      const lh = hand("l", 0), rh = hand("r", 0.5);
      const shift = 0.05 * Math.sin(2 * Math.PI * ph);
      const foot = (side, off) => { const q = ((ph + off) % 1 + 1) % 1; return { x: (side === "l" ? 0.12 : -0.12) + 0.1 * Math.cos(2 * Math.PI * q), y: 0.04 * Math.max(0, Math.sin(2 * Math.PI * q)) }; };
      const lf = foot("l", 0.1), rf = foot("r", 0.6);
      keys.push({ t: ph * T, ...mix(HANG, {
        hips: [shift, -0.035 + 0.015 * Math.cos(4 * Math.PI * ph), -0.03], hipsRot: [4, 0, -3 * Math.sin(2 * Math.PI * ph)], torso: [6, 0, 3 * Math.sin(2 * Math.PI * ph)],
        lHand: H(lh.x, EDGE.y - 0.015 + lh.y, EDGE.z - 0.015, { ...grabL, elbow: [0.5, -0.4, -1] }), rHand: H(rh.x, EDGE.y - 0.015 + rh.y, EDGE.z - 0.015, { ...grabR, elbow: [-0.5, -0.4, -1] }),
        lGrip: lh.y > 0.01 ? 0.3 : 0.62, rGrip: rh.y > 0.01 ? 0.3 : 0.62,
        lFoot: L(lf.x, -0.02 + lf.y, 0.1, { pitch: 30 }), rFoot: R(rf.x, 0.02 + rf.y, 0.12, { pitch: 25 }),
      }) });
    }
    add({ name: "Shimmy_L", dur: T, loop: true, keys }, { group: "Ledge", props: hangProps, focus: [0, 1.2, 0.3], dist: 4, speed: travel / T, hang: EDGE,
      desc: "Shimmy left, hand over hand. Each hand slides back at the travel speed while it grips, so the grip stays fixed on the ledge." });
    add({ name: "Shimmy_R", dur: T, loop: true, keys: keys.map((k) => ({ t: k.t, ...mirrorPose(k) })) }, { group: "Ledge", props: hangProps, focus: [0, 1.2, 0.3], dist: 4, speed: travel / T, hang: EDGE,
      desc: "Mirror of the left shimmy." });
  }
  // climb up from the hang onto the ledge (world space: the ledge is fixed, the body moves over it)
  add({
    name: "Climb_Up", dur: 1.3, world: true, keys: [
      { t: 0, root: [0, 0, 0], ...HANG, hips: [0, HIPS_Y - 0.07, -0.03] },
      { t: 0.32, root: [0, 0.35, 0], ...mix(HANG, { hips: [0, HIPS_Y + 0.33, 0.0], torso: [14, 0, 0], headAbs: [-5, 0, 0], lClav: [0, 0, 6], rClav: [0, 0, -6],
        lHand: H(0.21, EDGE.y - 0.015, EDGE.z - 0.015, { ...grabL, elbow: [0.5, -0.6, -1] }), rHand: H(-0.21, EDGE.y - 0.015, EDGE.z - 0.015, { ...grabR, elbow: [-0.5, -0.6, -1] }),
        lFoot: L(0.12, 0.45, 0.13, { pitch: 10, knee: [0.1, 0.2, 1] }), rFoot: R(-0.12, 0.3, 0.14, { pitch: 25 }) }) },
      { t: 0.6, root: [0, 0.9, 0.12], ...mix(HANG, { hips: [0, EDGE.y + 0.2, 0.12], torso: [42, 0, 0], headAbs: [12, 0, 0], lClav: [0, 0, 0], rClav: [0, 0, 0],
        lHand: H(0.22, EDGE.y + 0.02, EDGE.z + 0.06, { aim: [-0.3, 0, 1], fing: [0.3, -1, 0.3], elbow: [0.4, 0.2, -1] }), rHand: H(-0.22, EDGE.y + 0.02, EDGE.z + 0.06, { aim: [0.3, 0, 1], fing: [-0.3, -1, 0.3], elbow: [-0.4, 0.2, -1] }),
        lFoot: L(0.12, 0.75, 0.15, { pitch: 20 }), rFoot: R(-0.1, EDGE.y + 0.04, EDGE.z + 0.2, { pitch: 40, knee: [0, 0.7, 1] }), lGrip: 0.2, rGrip: 0.2 }) },
      { t: 0.88, root: [0, EDGE.y, 0.38], ...mix(STAND, { hips: [0, EDGE.y + 0.6, 0.4], torso: [30, 0, 0], headAbs: [6, 0, 0],
        lHand: H(0.27, EDGE.y + 0.78, 0.55, { aim: [0, 0.3, 1], fing: [0, -0.8, 0.4] }), rHand: H(-0.27, EDGE.y + 0.76, 0.58, { aim: [0, 0.3, 1], fing: [0, -0.8, 0.4] }),
        lFoot: L(0.11, EDGE.y + 0.1, EDGE.z + 0.1, { pitch: 35 }), rFoot: R(-0.1, EDGE.y, EDGE.z + 0.24, { pitch: 0 }) }) },
      { t: 1.3, root: [0, EDGE.y, EDGE.z + 0.38], ...mix(STAND, { hips: [0, EDGE.y + HIPS_Y - 0.025, EDGE.z + 0.38],
        lHand: H(0.232, EDGE.y + 0.895, EDGE.z + 0.42, { aim: [0, 0, 1], fing: [-0.05, -1, 0.08] }), rHand: H(-0.232, EDGE.y + 0.895, EDGE.z + 0.42, { aim: [0, 0, 1], fing: [0.05, -1, 0.08] }),
        lFoot: L(0.115, EDGE.y, EDGE.z + 0.4, { yaw: 7 }), rFoot: R(-0.115, EDGE.y, EDGE.z + 0.38, { yaw: -7 }) }) },
    ],
  }, { group: "Ledge", props: hangProps, focus: [0, 1.7, 0.4], dist: 4.6, hang: EDGE,
    desc: "Climb up from the hang: pull, walk the feet up the wall, knee onto the top, push up and stand. Hands stay on the edge until the body is over it." });

  // Wall climb: run up a 3.2 m wall, one kick off the wall face, catch the top, pull over.
  const WB = { z0: 0.6, h: 3.2 };
  const wallSpecRaw = (WB, name) => ({
    name, dur: 1.6, world: true, keys: [
      { t: 0, root: [0, 0, 0], ...mix(STAND, { hips: [0, HIPS_Y - 0.1, 0.05], torso: [14, 0, 0], lFoot: L(0.09, 0, 0.05, { pitch: 10 }), rFoot: R(-0.09, 0.12, -0.25, { pitch: 30 }),
        lHand: H(0.22, 1.0, -0.05), rHand: H(-0.22, 1.05, 0.25) }) },
      { t: 0.16, root: [0, 0.4, 0.2], ...mix(STAND, { hips: [0, HIPS_Y + 0.35, 0.22], torso: [4, 0, 0], lFoot: L(0.09, 0.15, 0.0, { pitch: 50 }), rFoot: R(-0.1, 0.75, WB.z0 - 0.14, { pitch: -60, knee: [0, 0.5, 1] }),
        lHand: H(0.25, 1.75, 0.35, { aim: [0, 0.6, 1], fing: [0, 1, 0.2] }), rHand: H(-0.28, 1.2, 0.0) }) },
      { t: 0.34, root: [0, 1.2, 0.25], ...mix(STAND, { hips: [0, 2.05, 0.25], torso: [6, 0, 0], lFoot: L(0.1, 0.9, 0.1, { pitch: 30, knee: [0.1, 0.3, 1] }), rFoot: R(-0.1, 0.95, WB.z0 - 0.14, { pitch: -50, knee: [0, 0.3, 1] }),
        lHand: H(0.21, WB.h - 0.02, WB.z0 + 0.03, grabL), rHand: H(-0.21, WB.h - 0.02, WB.z0 + 0.03, grabR), lClav: [0, 0, 16], rClav: [0, 0, -16], lGrip: 0.6, rGrip: 0.6 }) },
      { t: 0.62, root: [0, 1.75, 0.3], ...mix(STAND, { hips: [0, WB.h - 0.2, 0.3], torso: [26, 0, 0], lFoot: L(0.12, 1.75, WB.z0 - 0.15, { pitch: -20 }), rFoot: R(-0.12, 1.5, 0.4, { pitch: 20 }),
        lHand: H(0.21, WB.h - 0.02, WB.z0 + 0.03, { ...grabL, elbow: [0.4, -0.3, -1] }), rHand: H(-0.21, WB.h - 0.02, WB.z0 + 0.03, { ...grabR, elbow: [-0.4, -0.3, -1] }), lGrip: 0.6, rGrip: 0.6 }) },
      { t: 0.9, root: [0, 2.6, 0.45], ...mix(STAND, { hips: [0, WB.h + 0.3, 0.45], torso: [48, 0, 0], headAbs: [10, 0, 0], lFoot: L(0.12, 2.45, 0.5, { pitch: 30 }), rFoot: R(-0.1, WB.h, WB.z0 + 0.22, { pitch: 35, knee: [0, 0.6, 1] }),
        lHand: H(0.22, WB.h + 0.02, WB.z0 + 0.12, { aim: [-0.3, 0, 1], fing: [0.3, -1, 0.3], elbow: [0.4, 0.2, -1] }), rHand: H(-0.22, WB.h + 0.02, WB.z0 + 0.12, { aim: [0.3, 0, 1], fing: [-0.3, -1, 0.3], elbow: [-0.4, 0.2, -1] }), lGrip: 0.2, rGrip: 0.2 }) },
      { t: 1.18, root: [0, WB.h, 0.75], ...mix(STAND, { hips: [0, WB.h + 0.62, 0.8], torso: [28, 0, 0], lFoot: L(0.11, WB.h + 0.12, WB.z0 + 0.2, { pitch: 30 }), rFoot: R(-0.1, WB.h, WB.z0 + 0.25, { pitch: 0 }),
        lHand: H(0.26, WB.h + 0.8, 0.95, { aim: [0, 0.3, 1], fing: [0, -0.8, 0.4] }), rHand: H(-0.26, WB.h + 0.78, 0.98, { aim: [0, 0.3, 1], fing: [0, -0.8, 0.4] }) }) },
      { t: 1.6, root: [0, WB.h, 1.0], ...mix(STAND, { hips: [0, WB.h + HIPS_Y - 0.025, 1.0], lFoot: L(0.115, WB.h, 1.02, { yaw: 7 }), rFoot: R(-0.115, WB.h, 1.0, { yaw: -7 }),
        lHand: H(0.232, WB.h + 0.895, 1.04, { aim: [0, 0, 1], fing: [-0.05, -1, 0.08] }), rHand: H(-0.232, WB.h + 0.895, 1.02, { aim: [0, 0, 1], fing: [0.05, -1, 0.08] }) }) },
    ],
  });
  add(wallSpec(WB), { group: "Parkour", props: [{ box: [0, WB.h / 2, WB.z0 + 1, 3, WB.h, 2] }], focus: [0, 2.2, 0.6], dist: 6.5,
    desc: "Wall run-up: one kick off the wall, catch the top with both hands, pull over and stand." });

  // ---------------------------------------------------------------- ladder (rungs every 0.35 m, 0.3 m in front of the root)
  const LAD = { z: 0.3, pitch: 0.35 };
  {
    const N = 16, T = 1.3, rise = 2 * LAD.pitch, keys = [];
    const limb = (ph, off, y0, swingY) => {   // grip phase: moves down by `rise*duty`, then reaches up
      const duty = 0.6, q = ((ph + off) % 1 + 1) % 1;
      if (q < duty) return { y: y0 - rise * q, swing: 0 };
      const s = (q - duty) / (1 - duty); return { y: y0 - rise * duty + (rise) * ss(s), swing: Math.sin(Math.PI * s) };
    };
    for (let i = 0; i < N; i++) {
      const ph = i / N;
      const lh = limb(ph, 0, 1.62, 0), rh = limb(ph, 0.5, 1.62, 0), lf = limb(ph, 0.5, 0.42, 0), rf = limb(ph, 0, 0.42, 0);
      keys.push({ t: ph * T, ...mix(STAND, {
        hips: [0.02 * Math.cos(2 * Math.PI * ph), -0.06 + 0.02 * Math.cos(4 * Math.PI * ph), 0.0], torso: [8, 3 * Math.cos(2 * Math.PI * ph), 0], headAbs: [-6, 0, 0],
        lClav: [0, 0, 10], rClav: [0, 0, -10],
        lHand: H(0.19, lh.y, LAD.z - 0.02 - 0.08 * lh.swing, { aim: [-1, 0, 0], fing: [0, 0.2, 1], elbow: [0.6, -0.5, -1] }), rHand: H(-0.19, rh.y, LAD.z - 0.02 - 0.08 * rh.swing, { aim: [1, 0, 0], fing: [0, 0.2, 1], elbow: [-0.6, -0.5, -1] }),
        lGrip: lh.swing > 0.2 ? 0.3 : 0.75, rGrip: rh.swing > 0.2 ? 0.3 : 0.75,
        lFoot: L(0.13, lf.y - 0.0 + 0.0, LAD.z - 0.19 - 0.08 * lf.swing, { pitch: 5 + 20 * lf.swing, knee: [0.2, 0.2, 1] }), rFoot: R(-0.13, rf.y, LAD.z - 0.19 - 0.08 * rf.swing, { pitch: 5 + 20 * rf.swing, knee: [-0.2, 0.2, 1] }),
      }) });
    }
    const props = []; for (let y = 0.07; y < 3; y += LAD.pitch) props.push({ box: [0, y, LAD.z + 0.02, 0.8, 0.04, 0.04], accent: true });
    props.push({ box: [0.42, 1.5, LAD.z + 0.02, 0.05, 3, 0.05], accent: true }, { box: [-0.42, 1.5, LAD.z + 0.02, 0.05, 3, 0.05], accent: true });
    add({ name: "Ladder", dur: T, loop: true, keys }, { group: "Climb", props, focus: [0, 1.2, 0.2], dist: 4.4, climb: { rise, z: LAD.z },
      desc: "Ladder climb facing the rungs: opposite hand and foot move together, hands hook the rungs. The game syncs the cycle to height so hands land on rungs." });
  }
  // ---------------------------------------------------------------- rope: hand over hand, feet clamp
  {
    const N = 16, T = 1.4, rise = 0.6, keys = [], RZ = 0.17;
    for (let i = 0; i < N; i++) {
      const ph = i / N;
      const hand = (off, top) => { const duty = 0.55, q = ((ph + off) % 1 + 1) % 1; if (q < duty) return { y: top - rise * q / 1, s: 0 }; const s = (q - duty) / (1 - duty); return { y: top - rise * duty + rise * ss(s), s: Math.sin(Math.PI * s) }; };
      const lh = hand(0, 1.64), rh = hand(0.5, 1.64);
      // legs: pull up while the hands hold (phase 0..0.5), clamp and stand (0.5..1)
      const c = 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
      keys.push({ t: ph * T, ...mix(STAND, {
        hips: [0, -0.04 - 0.05 * c, -0.05], hipsRot: [8 + 10 * c, 0, 0], torso: [4, 0, 0], headAbs: [-10, 0, 0], lClav: [0, 0, 12], rClav: [0, 0, -12],
        lHand: H(0.03, lh.y, RZ - 0.04 * lh.s, { aim: [0, -0.3, -1], fing: [-1, 0.4, 0], elbow: [0.7, -0.3, -0.6] }), rHand: H(-0.03, rh.y, RZ - 0.04 * rh.s, { aim: [0, 0.3, 1], fing: [1, 0.4, 0], elbow: [-0.7, -0.3, -0.6] }),
        lGrip: lh.s > 0.2 ? 0.35 : 0.85, rGrip: rh.s > 0.2 ? 0.35 : 0.85,
        lFoot: L(0.06, 0.1 + 0.32 * c, RZ - 0.15 + 0.04 * c, { pitch: -10, yaw: -20, knee: [0.3, 0.2, 1] }), rFoot: R(-0.02, 0.05 + 0.32 * c, RZ - 0.06 + 0.04 * c, { pitch: 30, yaw: 30, knee: [-0.3, 0.2, 1] }),
      }) });
    }
    add({ name: "Rope_Climb", dur: T, loop: true, keys }, { group: "Climb", props: [{ box: [0, 2, RZ, 0.07, 4, 0.07], accent: true }], focus: [0, 1.2, 0.1], dist: 4, climb: { rise, z: RZ },
      desc: "Rope climb: hand over hand while the knees draw up and the feet clamp the rope, then stand on the clamp." });
  }
  // ---------------------------------------------------------------- bars (bar runs left-right, hands at 1.78 m)
  const BAR = 1.8;
  const BARHANG = mix(STAND, {
    hips: [0, -0.02, 0.0], hipsRot: [0, 0, 0], torso: [0, 0, 0], headAbs: [-8, 0, 0], lClav: [0, 0, 20], rClav: [0, 0, -20],
    lHand: H(0.22, BAR - 0.03, 0.03, { aim: [-1, 0, 0], fing: [0, 0.3, 1], elbow: [0.6, 0, -1] }), rHand: H(-0.22, BAR - 0.03, 0.03, { aim: [1, 0, 0], fing: [0, 0.3, 1], elbow: [-0.6, 0, -1] }),
    lFoot: L(0.1, -0.02, -0.04, { pitch: 35 }), rFoot: R(-0.1, 0.02, 0.0, { pitch: 30 }), lGrip: 0.85, rGrip: 0.85,
  });
  const barProps = [{ box: [0, BAR, 0.03, 4, 0.07, 0.07], accent: true }];
  add({
    name: "Bar_Hang", dur: 2.2, loop: true, keys: [
      { t: 0, ...mix(BARHANG, { hips: [0, -0.02, 0.05], hipsRot: [-5, 0, 0], lFoot: L(0.1, -0.02, -0.12, { pitch: 35 }), rFoot: R(-0.1, 0.02, -0.08, { pitch: 30 }) }) },
      { t: 1.1, ...mix(BARHANG, { hips: [0, -0.02, -0.04], hipsRot: [5, 0, 0], lFoot: L(0.1, 0.02, 0.06, { pitch: 30 }), rFoot: R(-0.1, -0.01, 0.02, { pitch: 35 }) }) },
    ],
  }, { group: "Climb", props: barProps, focus: [0, 1.2, 0], dist: 4, bar: BAR, desc: "Dead hang from a bar with a slow pendulum swing." });
  {
    const N = 16, T = 0.9, travel = 0.5, keys = [];
    for (let i = 0; i < N; i++) {
      const ph = i / N;
      const hand = (side, off) => { const duty = 0.55, q = ((ph + off) % 1 + 1) % 1; if (q < duty) return { x: travel / 2 - travel * q / duty, y: 0 }; const s = (q - duty) / (1 - duty); return { x: -travel / 2 + travel * ss(s), y: 0.07 * Math.sin(Math.PI * s) }; };
      const lh = hand("l", 0), rh = hand("r", 0.5), sw = Math.sin(2 * Math.PI * ph);
      keys.push({ t: ph * T, ...mix(BARHANG, {
        hips: [0.05 * sw, 0.0, 0], hipsRot: [0, 0, -6 * sw], torso: [0, 0, 4 * sw],
        lHand: H(0.24 + lh.x, BAR - 0.03 + lh.y, 0.03, { aim: [-1, 0, 0], fing: [0, 0.3, 1], elbow: [0.6, 0, -1] }), rHand: H(-0.24 + rh.x, BAR - 0.03 + rh.y, 0.03, { aim: [1, 0, 0], fing: [0, 0.3, 1], elbow: [-0.6, 0, -1] }),
        lGrip: lh.y > 0.01 ? 0.35 : 0.85, rGrip: rh.y > 0.01 ? 0.35 : 0.85,
        lFoot: L(0.1 + 0.04 * sw, -0.02, -0.03, { pitch: 35 }), rFoot: R(-0.1 + 0.04 * sw, 0.02, 0.0, { pitch: 30 }),
      }) });
    }
    add({ name: "Bar_Move_L", dur: T, loop: true, keys }, { group: "Climb", props: barProps, focus: [0, 1.2, 0], dist: 4, speed: travel / T, bar: BAR, desc: "Hand-over-hand along the bar, hips swinging with each reach." });
    add({ name: "Bar_Move_R", dur: T, loop: true, keys: keys.map((k) => ({ t: k.t, ...mirrorPose(k) })) }, { group: "Climb", props: barProps, focus: [0, 1.2, 0], dist: 4, speed: travel / T, bar: BAR, desc: "Mirror of Bar Move L." });
  }

  // ================================================================ PIPE (right hand)
  const PSTANCE = mix(STAND, {
    hips: [0, -0.07, 0], hipsRot: [0, -18, 0], torso: [8, 14, 0], headAbs: [2, 0, 0],
    lFoot: L(0.12, 0, 0.14, { yaw: 2 }), rFoot: R(-0.13, 0, -0.16, { yaw: -30 }),
    lHand: C(0.2, 1.12, 0.26, { aim: [-0.2, 0.6, 0.6], fing: [-0.2, 0.3, 1], elbow: [0.6, -0.4, -0.6] }), lGrip: 0.85,
    rHand: deep(PIPE_HOLD_R), rGrip: 1, rThumb: 0.8,
  });
  add({
    name: "Pipe_Idle", dur: 2.6, loop: true, keys: [
      { t: 0, ...PSTANCE },
      { t: 1.3, ...mix(PSTANCE, { hips: [0.01, -0.075, 0], upper: [-2, 0, 0], rHand: C(-0.215, 1.01, 0.21, { aim: [0.12, 0.85, 0.52], fing: [0.2, 0, 1], elbow: [-0.6, -0.4, -1] }), lHand: C(0.2, 1.13, 0.25, { aim: [-0.2, 0.6, 0.6], fing: [-0.2, 0.3, 1], elbow: [0.6, -0.4, -0.6] }) }) },
    ],
  }, { group: "Pipe", pipe: true, desc: "Ready stance with the pipe: left foot forward, pipe up in the right fist, left hand guarding." });
  // pickup: one step in, sink low, right hand closes on the pipe at the grab frame, rise into the stance
  const PICK = { x: -0.16, y: 0.035, z: 0.66, grab: 0.5 };
  add({
    name: "Pickup", dur: 1.2, world: true, keys: [
      { t: 0, root: [0, 0, 0], ...STAND, hips: [0, HIPS_Y - 0.025, 0] },
      { t: 0.22, root: [0, 0, 0.15], ...mix(STAND, { hips: [0.02, HIPS_Y - 0.12, 0.18], torso: [22, -8, 0], lFoot: L(0.12, 0.05, 0.3, { pitch: -5 }), rFoot: R(-0.115, 0, 0.0, { pitch: 10 }),
        rHand: H(-0.2, 0.75, 0.45, { aim: [0, 0, 1], fing: [0, -1, 0.3] }), lHand: H(0.26, 0.85, 0.2) }) },
      { t: PICK.grab, root: [0, 0, 0.3], ...mix(STAND, { hips: [0.02, 0.46, 0.24], hipsRot: [14, -12, 0], torso: [58, -16, 6], headAbs: [30, -10, 0], lFoot: L(0.13, 0, 0.42, { yaw: 5, knee: [0.3, 0, 1] }), rFoot: R(-0.12, 0.05, -0.02, { pitch: 45 }),
        rHand: H(PICK.x, PICK.y + 0.07, PICK.z - 0.04, { aim: [0, 0, 1], fing: [0.15, -1, 0], elbow: [-0.5, 0.2, -1] }), rGrip: 0.95, lHand: H(0.3, 0.55, 0.55, { aim: [0, 0, 1], fing: [0, -1, 0.3] }) }) },
      { t: 0.78, root: [0, 0, 0.3], ...mix(PSTANCE, { hips: [0.02, HIPS_Y - 0.17, 0.22], torso: [20, 0, 0], lFoot: L(0.12, 0, 0.42, { yaw: 2 }), rFoot: R(-0.13, 0, 0.0, { yaw: -20, pitch: 10 }),
        rHand: H(-0.24, 0.92, 0.55, { aim: [0, 0.5, 1], fing: [0.2, -0.5, 1], elbow: [-0.6, -0.4, -1] }) }) },
      { t: 1.2, root: [0, 0, 0.3], ...PSTANCE, hips: [0, HIPS_Y - 0.07, 0.3], lFoot: L(0.12, 0, 0.44, { yaw: 2 }), rFoot: R(-0.13, 0, 0.14, { yaw: -30 }) },
    ],
  }, { group: "Pipe", pickup: PICK, props: [], focus: [0, 0.7, 0.5], dist: 3.6, pipeFloor: true,
    desc: "Pick up: step in, sink low, the right hand closes round the pipe (at 0.5 s), rise straight into the ready stance." });

  // attacks. Each one: wind-up -> fast strike (hit frame) -> follow-through -> settle back to the stance.
  const PS = (o) => mix(PSTANCE, o);
  add({
    name: "Pipe_Swing", dur: 0.9, keys: [
      { t: 0, ...PSTANCE },
      { t: 0.2, ...PS({ hipsRot: [0, -32, 0], torso: [-2, -38, 4], headAbs: [2, 10, 0], lHand: C(0.18, 1.18, 0.35, { aim: [-0.2, 0.6, 0.6], fing: [-0.2, 0.3, 1] }),
        rHand: C(-0.32, 1.45, -0.08, { aim: [0.1, 0.6, -0.8], fing: [0.3, 0.8, 0.3], elbow: [-0.6, -0.2, -0.6] }), rClav: [0, 0, -12] }) },
      { t: 0.3, ...PS({ hips: [0.02, -0.1, 0.06], hipsRot: [0, 2, 0], torso: [12, 8, -2], rHand: C(-0.05, 1.22, 0.46, { aim: [0.7, 0.3, 0.65], fing: [0.2, 0.9, -0.5], elbow: [-0.7, -0.4, -0.5] }),
        lHand: C(0.25, 1.0, 0.1, { aim: [0, 0.6, 0.6], fing: [0, 0.3, 1] }), rClav: [0, 0, 0] }) },
      { t: 0.4, ...PS({ hips: [0.03, -0.12, 0.07], hipsRot: [0, 22, 0], torso: [22, 34, 0], headAbs: [6, 0, 0], rHand: C(0.22, 0.88, 0.32, { aim: [0.5, -0.6, -0.4], fing: [0.2, 0.2, 1], elbow: [-0.4, -0.6, -1] }),
        lHand: C(0.3, 0.98, -0.05) }) },
      { t: 0.55, ...PS({ hips: [0.02, -0.1, 0.04], hipsRot: [0, 14, 0], torso: [16, 26, 0], rHand: C(0.18, 0.92, 0.28, { aim: [0.5, -0.4, -0.5], fing: [0.2, 0.3, 1] }) }) },
      { t: 0.9, ...PSTANCE },
    ],
  }, { group: "Pipe", pipe: true, hit: 0.3, desc: "Forehand: cock the pipe behind the right shoulder, cut down across the body, hips drive the swing." });
  add({
    name: "Pipe_Backhand", dur: 0.9, keys: [
      { t: 0, ...PS({ hips: [0.02, -0.1, 0.04], hipsRot: [0, 14, 0], torso: [16, 26, 0], rHand: C(0.18, 0.92, 0.28, { aim: [0.5, -0.4, -0.5], fing: [0.2, 0.3, 1] }) }) },
      { t: 0.18, ...PS({ hipsRot: [0, 20, 0], torso: [4, 42, 0], headAbs: [2, -8, 0], rHand: C(0.22, 1.22, 0.06, { aim: [0.4, 0.5, -0.75], fing: [0.2, 0.9, 0.2], elbow: [-0.2, -0.6, -1] }),
        lHand: C(0.3, 1.0, -0.05) }) },
      { t: 0.28, ...PS({ hips: [0, -0.1, 0.05], hipsRot: [0, -4, 0], torso: [10, 0, 0], rHand: C(-0.08, 1.2, 0.47, { aim: [-0.7, 0.1, 0.7], fing: [0.1, 0.9, 0.3], elbow: [-0.5, -0.6, -0.7] }),
        lHand: C(0.25, 1.08, 0.2) }) },
      { t: 0.38, ...PS({ hips: [0, -0.1, 0.04], hipsRot: [0, -28, 0], torso: [8, -36, 0], rHand: C(-0.42, 1.12, 0.1, { aim: [-0.6, 0.2, -0.7], fing: [0, 1, 0.2], elbow: [-0.3, -0.7, -1] }) }) },
      { t: 0.52, ...PS({ hipsRot: [0, -24, 0], torso: [6, -26, 0], rHand: C(-0.38, 1.15, 0.12, { aim: [-0.5, 0.4, -0.6], fing: [0, 1, 0.2] }) }) },
      { t: 0.9, ...PSTANCE },
    ],
  }, { group: "Pipe", pipe: true, hit: 0.28, desc: "Backhand return: the swing continues round to the left, then whips back right at head height." });
  // two-handed overhead smash; the left hand sits just below the right on the pipe
  const two = (rx, ry, rz, aim, o = {}) => {
    const a = new THREE.Vector3(...aim).normalize();
    return { rHand: C(rx, ry, rz, { aim, fing: o.fing || [0.3, 0.3, 1], elbow: [-0.6, -0.5, -1] }), lHand: C(rx - a.x * 0.1 + 0.015, ry - a.y * 0.1, rz - a.z * 0.1, { aim, fing: o.fing || [0.3, 0.3, 1], elbow: [0.6, -0.5, -1] }), lGrip: 0.95 };
  };
  add({
    name: "Pipe_Smash", dur: 1.1, keys: [
      { t: 0, ...PSTANCE },
      { t: 0.32, ...PS({ hips: [0, -0.02, -0.04], hipsRot: [0, -8, 0], torso: [-14, 4, 0], headAbs: [4, 0, 0], lClav: [0, 0, 14], rClav: [0, 0, -14], ...two(-0.06, 1.62, -0.02, [0, 0.35, -1], { fing: [0, 1, 0.3] }) }) },
      { t: 0.44, ...PS({ hips: [0, -0.2, 0.1], hipsRot: [0, -4, 0], torso: [34, 2, 0], headAbs: [12, 0, 0], ...two(-0.04, 0.98, 0.5, [0, -0.35, 1], { fing: [0, -1, -0.3] }), lFoot: L(0.12, 0, 0.2, { yaw: 2 }) }) },
      { t: 0.62, ...PS({ hips: [0, -0.22, 0.1], hipsRot: [0, -4, 0], torso: [38, 2, 0], headAbs: [12, 0, 0], ...two(-0.04, 0.9, 0.48, [0, -0.5, 1], { fing: [0, -1, -0.4] }), lFoot: L(0.12, 0, 0.2, { yaw: 2 }) }) },
      { t: 1.1, ...PSTANCE },
    ],
  }, { group: "Pipe", pipe: true, hit: 0.44, desc: "Heavy: both hands on the pipe, rear back, then drop the whole body into an overhead smash." });

  // ================================================================ REACTIONS (player and raiders)
  const GUARD = mix(STAND, { hips: [0, -0.06, 0], torso: [8, 0, 0], lFoot: L(0.12, 0, 0.12), rFoot: R(-0.12, 0, -0.1, { yaw: -20 }),
    lHand: C(0.16, 1.32, 0.25, { aim: [0, 0.8, 0.4], fing: [-0.3, 0.6, 1] }), rHand: C(-0.15, 1.3, 0.2, { aim: [0, 0.8, 0.4], fing: [0.3, 0.6, 1] }), lGrip: 0.9, rGrip: 0.9 });
  add({
    name: "Hit", dur: 0.5, keys: [
      { t: 0, ...GUARD },
      { t: 0.07, ...mix(GUARD, { hips: [0.02, -0.08, -0.06], torso: [-10, 16, -4], headAbs: [-22, 20, -8], lHand: C(0.28, 1.2, 0.1, { aim: [0, 0.6, 0.6] }), rHand: C(-0.25, 1.15, 0.05, { aim: [0, 0.6, 0.6] }) }) },
      { t: 0.18, ...mix(GUARD, { hips: [0.01, -0.1, -0.05], torso: [-4, 10, -2], headAbs: [-10, 12, -4] }) },
      { t: 0.5, ...GUARD },
    ],
  }, { group: "Reactions", desc: "Light hit: head snaps back and turns, guard drops a little, recovers." });
  add({
    name: "Hit_Big", dur: 0.85, world: true, keys: [
      { t: 0, root: [0, 0, 0], ...GUARD, hips: [0, HIPS_Y - 0.06, 0] },
      { t: 0.08, root: [0, 0, -0.08], ...mix(GUARD, { hips: [0, HIPS_Y - 0.04, -0.14], hipsRot: [-6, 0, 0], torso: [-22, 18, 0], headAbs: [-30, 18, 0], lHand: H(0.35, 1.3, 0.0, { aim: [0, 0.6, 0.6] }), rHand: H(-0.35, 1.25, -0.05, { aim: [0, 0.6, 0.6] }), rFoot: R(-0.12, 0.08, -0.15, { pitch: 20 }) }) },
      { t: 0.28, root: [0, 0, -0.3], ...mix(GUARD, { hips: [0, HIPS_Y - 0.14, -0.3], hipsRot: [0, 0, 0], torso: [-6, 8, 0], headAbs: [-12, 8, 0], lHand: H(0.3, 1.1, -0.15, { aim: [0, 0.6, 0.6] }), rHand: H(-0.32, 1.05, -0.3, { aim: [0, 0.6, 0.6] }), rFoot: R(-0.13, 0, -0.5, { yaw: -20 }) }) },
      { t: 0.48, root: [0, 0, -0.4], ...mix(GUARD, { hips: [0, HIPS_Y - 0.12, -0.4], torso: [12, 4, 0], headAbs: [2, 4, 0], lFoot: L(0.12, 0.06, -0.15, { pitch: 20 }), rFoot: R(-0.13, 0, -0.5, { yaw: -20 }), lHand: H(0.22, 1.25, -0.2), rHand: H(-0.2, 1.22, -0.25) }) },
      { t: 0.85, root: [0, 0, -0.4], ...GUARD, hips: [0, HIPS_Y - 0.06, -0.4], lFoot: L(0.12, 0, -0.28), rFoot: R(-0.12, 0, -0.5, { yaw: -20 }), lHand: H(0.16, 1.32, -0.15, { aim: [0, 0.8, 0.4], fing: [-0.3, 0.6, 1] }), rHand: H(-0.15, 1.3, -0.2, { aim: [0, 0.8, 0.4], fing: [0.3, 0.6, 1] }) },
    ],
  }, { group: "Reactions", desc: "Heavy hit: knocked back, one stagger step, guard back up. Feet step, they don't slide." });
  add({
    name: "Death", dur: 1.7, keys: [
      { t: 0, ...mix(GUARD, { headAbs: undefined, head: [0, 0, 0] }) },
      { t: 0.15, ...mix(GUARD, { headAbs: undefined, head: [-25, 15, 0], hips: [0, -0.08, -0.08], torso: [-18, 15, 0], lHand: C(0.36, 1.2, 0.0), rHand: C(-0.34, 1.1, -0.05) }) },
      { t: 0.5, ...mix(GUARD, { headAbs: undefined, head: [10, 10, 0], hips: [0, -0.45, -0.12], hipsRot: [-10, 10, 0], torso: [20, 10, 0], lFoot: L(0.16, 0, 0.12, { yaw: 20 }), rFoot: R(-0.14, 0, -0.08, { yaw: -30 }),
        lHand: C(0.36, 0.9, 0.1), rHand: C(-0.36, 0.85, 0.05), lGrip: 0.2, rGrip: 0.2 }) },
      { t: 0.85, ...mix(GUARD, { headAbs: undefined, head: [-10, 10, 0], hips: [0, -0.68, -0.3], hipsRot: [-45, 10, 0], torso: [-10, 5, 0], lFoot: L(0.2, 0.0, 0.25, { pitch: -20, yaw: 20 }), rFoot: R(-0.16, 0.0, 0.15, { pitch: -20, yaw: -30 }),
        lHand: H(0.45, 0.35, -0.35), rHand: H(-0.45, 0.4, -0.4), lGrip: 0.2, rGrip: 0.2 }) },
      { t: 1.15, ...mix(GUARD, { headAbs: undefined, head: [-10, 25, 0], hips: [0, -0.8, -0.45], hipsRot: [-86, 6, 0], torso: [-4, 4, 0], lFoot: L(0.24, 0.02, 0.4, { pitch: -70, yaw: 25 }), rFoot: R(-0.2, 0.02, 0.38, { pitch: -75, yaw: -30 }),
        lHand: H(0.55, 0.06, -0.75, { aim: [0, 0, -1], fing: [1, 0, 0] }), rHand: H(-0.5, 0.06, -0.85, { aim: [0, 0, -1], fing: [-1, 0, 0] }), lGrip: 0.15, rGrip: 0.15 }) },
      { t: 1.7, ...mix(GUARD, { headAbs: undefined, head: [-6, 32, 0], hips: [0, -0.81, -0.45], hipsRot: [-88, 6, 0], torso: [-4, 4, 0], lFoot: L(0.27, 0.02, 0.42, { pitch: -75, yaw: 30 }), rFoot: R(-0.2, 0.02, 0.38, { pitch: -78, yaw: -30 }),
        lHand: H(0.58, 0.05, -0.75, { aim: [0, 0, -1], fing: [1, 0, 0] }), rHand: H(-0.52, 0.05, -0.86, { aim: [0, 0, -1], fing: [-1, 0, 0] }), lGrip: 0.1, rGrip: 0.1 }) },
    ].map((k) => { delete k.headAbs; return k; }),
  }, { group: "Reactions", desc: "Death: reel back, knees give, sit down hard and fall flat on the back." });

  const CROUCHED = mix(STAND, { hips: [0, -0.3, -0.02], hipsRot: [12, 0, 0], torso: [22, 0, 0], headAbs: [4, 0, 0],
    lFoot: L(0.14, 0, 0.08, { yaw: 10 }), rFoot: R(-0.13, 0, -0.12, { yaw: -12 }),
    lHand: C(0.22, 0.98, 0.22, { aim: [0, 0.3, 1], fing: [-0.2, -0.6, 0.8] }), rHand: C(-0.22, 0.96, 0.18, { aim: [0, 0.3, 1], fing: [0.2, -0.6, 0.8] }), lGrip: 0.5, rGrip: 0.5 });
  add({
    name: "Crouch_Idle", dur: 3, loop: true, keys: [
      { t: 0, ...CROUCHED },
      { t: 1.5, ...mix(CROUCHED, { hips: [0.01, -0.31, -0.02], upper: [-2, 0, 0], headAbs: [4, 10, 0] }) },
    ],
  }, { group: "Locomotion", desc: "Crouched and still, ready to sneak. Pairs with the original sneak walk." });

  // ================================================================ KEPT (Mixamo clips you liked), cleaned up
  const keep = (name, meta) => { if (!src[name]) return; const c = groundFix(src[name].clone(), model, rig); LIB[name] = { clip: c, kept: true, loop: true, ...meta }; };
  keep("Running", { group: "Locomotion", desc: "Original run (you liked it). Hips raised so the feet meet the floor instead of sinking.", speed: 4.4 });
  keep("Sneak_Walk", { group: "Locomotion", desc: "Original sneak (you liked it), now used in game when you crouch-walk (C).", speed: 1.2 });
  keep("Fight_Idle", { group: "Fists", desc: "Original guard stance." });
  for (const n of ["Jab", "Cross", "Hook", "Kick"]) keep(n, { group: "Fists", loop: false, desc: "Original strike. In game it now starts from the frame that best matches your current pose and blends, so combos flow instead of snapping." });
  if (LIB.Running) {   // pipe run: the original run with the right arm swapped for the pipe hold
    const hold = rig.solve(mix(STAND, { rHand: deep(PIPE_HOLD_R), rGrip: 1 })).q;
    const arm = ["rClav", "rArm", "rFore", "rHand", ...Object.keys(rig.b).filter((k) => /^r(Index|Middle|Ring|Pinky|Thumb)/.test(k))];
    const names = new Set(arm.map((k) => rig.b[k].node.name + ".quaternion"));
    const tracks = LIB.Running.clip.tracks.filter((t) => !names.has(t.name));
    for (const k of arm) tracks.push(new THREE.QuaternionKeyframeTrack(rig.b[k].node.name + ".quaternion", [0], hold[k].toArray()));
    LIB.Pipe_Run = { clip: new THREE.AnimationClip("Pipe_Run", LIB.Running.clip.duration, tracks), kept: true, loop: true, group: "Pipe", pipe: true, speed: 4.4, desc: "The original run with the right arm holding the pipe steady." };
  }

  // height-matched variants for the game (cached): Climb_Box / Wall_Climb rebuilt for the actual obstacle
  const cache = {};
  LIB.__variant = (name, h, near) => {
    const key = `${name}@${h.toFixed(2)}@${near.toFixed(2)}`;
    if (cache[key]) return cache[key];
    const spec = name === "Wall_Climb" ? wallSpec({ h, z0: near }, key) : boxClimbSpec({ h, z0: near }, key);
    const r = rig.bake(spec); return (cache[key] = { clip: r.clip, rm: r.rm });
  };
  Object.defineProperty(LIB, "__variant", { enumerable: false });

  // pipe grip: cylinder axis along the thumb, the fist closes about 12 cm from the bottom end
  const hb = rig.b.rHand, inv = hb.Wr.clone().invert();
  const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(inv), palm = new THREE.Vector3(1, 0, 0).applyQuaternion(inv);
  const mid = rig.b.rMiddle1.Lp.clone().multiplyScalar(0.92).addScaledVector(palm, 0.026);
  const gripQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  const gripP = mid.clone().addScaledVector(axis, 0.355);
  LIB.__attachPipe = (obj) => { obj.position.copy(gripP); obj.quaternion.copy(gripQ); obj.scale.setScalar(1); };
  LIB.__pipeGrip = { pos: gripP, quat: gripQ };
  Object.defineProperty(LIB, "__attachPipe", { enumerable: false }); Object.defineProperty(LIB, "__pipeGrip", { enumerable: false });
  return LIB;
}

// Raise / lower a clip's hips so its lowest sole point (heel or toe tip, not just the joints) sits on the floor.
function groundFix(clip, model, rig) {
  const mixer = new THREE.AnimationMixer(model), act = mixer.clipAction(clip); act.play();
  const inv = new THREE.Matrix4();
  // sole points in each bone's local frame, measured from the rest pose: heel under the ankle, tip in front of the ball
  const pts = [];
  for (const s of ["l", "r"]) {
    const f = rig.b[s + "Foot"], t = rig.b[s + "Toe"];
    const loc = (b, off) => off.clone().applyQuaternion(b.Wr.clone().invert());
    pts.push([f.node, loc(f, new THREE.Vector3(0, -f.Wp.y, -0.065))], [f.node, loc(f, new THREE.Vector3(0, -f.Wp.y, 0.02))],
      [t.node, loc(t, new THREE.Vector3(0, -t.Wp.y, 0.075))], [t.node, loc(t, new THREE.Vector3(0, -t.Wp.y, 0))]);
  }
  let lo = Infinity; const v = new THREE.Vector3();
  for (let t = 0; t <= clip.duration; t += 1 / 30) {
    mixer.setTime(t); model.updateMatrixWorld(true); inv.copy(model.matrixWorld).invert();
    for (const [node, off] of pts) { v.copy(off).applyMatrix4(node.matrixWorld).applyMatrix4(inv); lo = Math.min(lo, v.y); }
  }
  act.stop(); mixer.uncacheRoot(model);
  for (const k in rig.b) { rig.b[k].node.quaternion.copy(rig.b[k].Lr); rig.b[k].node.position.copy(rig.b[k].Lp); }
  const tr = clip.tracks.find((t) => /Hips\.position$/.test(t.name));
  if (tr && Math.abs(lo) > 0.004) for (let i = 1; i < tr.values.length; i += 3) tr.values[i] -= lo;
  clip.userData = { ground: lo };
  return clip;
}
