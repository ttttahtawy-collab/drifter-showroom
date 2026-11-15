// Drifter pose engine: hand-authored keyframe animation with IK, baked to three.js AnimationClips.
//
// Model space: +Y up, +Z forward (the way the character faces), +X = character's LEFT.
// Euler triples are degrees [x, y, z], applied Y (turn) then X (bend) then Z (lean):
//   x > 0  bends forward (spine) / tips the toes down (feet)
//   y > 0  turns to the character's left
//   z > 0  leans to the character's right
// Rotations are deltas from the rest pose, expressed in model axes as if the parent were at rest,
// so "spine: [20,0,0]" always means "bend 20 degrees forward" regardless of bone roll.
//
// A pose (one keyframe) may contain:
//   hips:[x,y,z] metres offset from the rest hips position · hipsRot:[e]
//   torso:[e] spread over the 3 spine bones · spine/chest/upper:[e] · neck:[e] · head:[e] · headAbs:[e] (world-level head)
//   lClav/rClav:[e]
//   lHand/rHand: { p:[x,y,z] wrist target, elbow:[dir] pole, rot:[e] absolute hand orientation, space:"chest"|"model" }
//   lArmFK/rArmFK: { arm:[e], fore:[e], hand:[e] } (used when no lHand/rHand IK)
//   lFoot/rFoot: { p:[x,y,z] (y=0 means planted), pitch, yaw, roll, toe, knee:[dir], pivot:"ankle"|"ball" }
//   lGrip/rGrip: 0..1 finger curl · lThumb/rThumb: 0..1
//   root:[x,y,z] root motion (character travel, exported separately) · rootYaw: degrees
import * as THREE from "three";

const D2R = Math.PI / 180;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const eq = (e) => e ? new THREE.Quaternion().setFromEuler(new THREE.Euler((e[0] || 0) * D2R, (e[1] || 0) * D2R, (e[2] || 0) * D2R, "YXZ")) : new THREE.Quaternion();

const MAIN = {
  hips: "Hips", spine: "Spine", spine1: "Spine1", spine2: "Spine2", neck: "Neck", head: "Head",
  lClav: "LeftShoulder", lArm: "LeftArm", lFore: "LeftForeArm", lHand: "LeftHand",
  rClav: "RightShoulder", rArm: "RightArm", rFore: "RightForeArm", rHand: "RightHand",
  lUpLeg: "LeftUpLeg", lLeg: "LeftLeg", lFoot: "LeftFoot", lToe: "LeftToeBase",
  rUpLeg: "RightUpLeg", rLeg: "RightLeg", rFoot: "RightFoot", rToe: "RightToeBase",
};
const FINGERS = ["Index", "Middle", "Ring", "Pinky"];

function basisQ(aim, hinge) {   // y = aim, x = hinge (orthogonalised), z = x × y
  const y = aim.clone().normalize();
  const x = hinge.clone().addScaledVector(y, -hinge.dot(y)).normalize();
  const z = V().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

export class PoseRig {
  constructor(model) {
    this.model = model;
    model.updateMatrixWorld(true);
    const inv = model.matrixWorld.clone().invert();
    const find = (short) => {
      let hit = null;
      model.traverse((o) => { if (!hit && o.isBone && o.name.replace(/^mixamorig:?/, "") === short) hit = o; });
      return hit;
    };
    this.b = {};
    const add = (key, short, parentKey) => {
      const node = find(short); if (!node) throw new Error("bone missing: " + short);
      const m = node.matrixWorld.clone().premultiply(inv);
      const wp = V(), wq = new THREE.Quaternion(), s = V(); m.decompose(wp, wq, s);
      this.b[key] = { key, node, name: node.name, parentKey, Lr: node.quaternion.clone(), Lp: node.position.clone(), Wr: wq, Wp: wp };
    };
    add("hips", "Hips", null);
    for (const [k, p] of [["spine", "hips"], ["spine1", "spine"], ["spine2", "spine1"], ["neck", "spine2"], ["head", "neck"],
      ["lClav", "spine2"], ["lArm", "lClav"], ["lFore", "lArm"], ["lHand", "lFore"],
      ["rClav", "spine2"], ["rArm", "rClav"], ["rFore", "rArm"], ["rHand", "rFore"],
      ["lUpLeg", "hips"], ["lLeg", "lUpLeg"], ["lFoot", "lLeg"], ["lToe", "lFoot"],
      ["rUpLeg", "hips"], ["rLeg", "rUpLeg"], ["rFoot", "rLeg"], ["rToe", "rFoot"]]) add(k, MAIN[k], p);
    for (const side of ["l", "r"]) {
      const S = side === "l" ? "Left" : "Right";
      for (const f of [...FINGERS, "Thumb"]) for (let i = 1; i <= 3; i++) {
        const key = `${side}${f}${i}`;
        add(key, `${S}Hand${f}${i}`, i === 1 ? `${side}Hand` : `${side}${f}${i - 1}`);
      }
    }
    // hips parent (model space)
    const hp = this.b.hips.node.parent; const hm = hp.matrixWorld.clone().premultiply(inv);
    this.hipsParentQ = new THREE.Quaternion(); this.hipsParentP = V(); hm.decompose(this.hipsParentP, this.hipsParentQ, V());
    this.hipsParentM = hm;
    // limb measurements
    const B = this.b;
    this.lenUpLeg = B.lLeg.Lp.length(); this.lenLeg = B.lFoot.Lp.length();
    this.lenArm = B.lFore.Lp.length(); this.lenFore = B.lHand.Lp.length();
    this.ankleY = B.lFoot.Wp.y;                    // rest ankle height above the floor
    this.ballY = B.lToe.Wp.y;
    this.rest = {};
    for (const k in B) this.rest[k] = B[k].Wp.clone();
    // rest IK frames
    this._limb = {};
    for (const [side, up, lo, end, pole] of [["lLeg", "lUpLeg", "lLeg", "lFoot", V(0, 0, 1)], ["rLeg", "rUpLeg", "rLeg", "rFoot", V(0, 0, 1)],
      ["lArm", "lArm", "lFore", "lHand", V(0.3, 0, -1)], ["rArm", "rArm", "rFore", "rHand", V(-0.3, 0, -1)]]) {
      const H = B[up].Wp, K = B[lo].Wp, T = B[end].Wp;
      const dir = V().subVectors(T, H).normalize();
      const pp = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
      const hinge = V().crossVectors(pp, dir).normalize();
      const aU = V().subVectors(K, H).normalize(), aL = V().subVectors(T, K).normalize();
      this._limb[side] = { up, lo, end, q0U: basisQ(aU, hinge), q0L: basisQ(aL, hinge), pole0: pole };
    }
    this._handQ0 = basisQ(V(0, -1, 0), V(0, 0, 1));   // rest hand: fingers down, thumb forward
    this.warn = [];
  }

  // delta in model axes -> local quaternion (parent assumed at rest)
  localFromDelta(key, D) {
    const b = this.b[key];
    return b.Lr.clone().multiply(b.Wr.clone().invert().multiply(D).multiply(b.Wr));
  }

  solve(pose) {
    const B = this.b, W = {}, P = {}, out = {};
    const setWorld = (key, worldQ) => {
      const b = B[key];
      out[key] = W[b.parentKey].clone().invert().multiply(worldQ);
      W[key] = worldQ; P[key] = P[b.parentKey].clone().add(b.Lp.clone().applyQuaternion(W[b.parentKey]));
    };
    const setLocal = (key, localQ) => {
      const b = B[key];
      out[key] = localQ; W[key] = W[b.parentKey].clone().multiply(localQ);
      P[key] = P[b.parentKey].clone().add(b.Lp.clone().applyQuaternion(W[b.parentKey]));
    };
    const fk = (key, e, extra) => { let D = eq(e); if (extra) D = extra.clone().multiply(D); setLocal(key, this.localFromDelta(key, D)); };

    // hips
    const hipsQ = eq(pose.hipsRot).multiply(B.hips.Wr);
    W.hips = hipsQ; P.hips = B.hips.Wp.clone().add(V(...(pose.hips || [0, 0, 0])));
    out.hips = this.hipsParentQ.clone().invert().multiply(hipsQ);
    const hipsPosLocal = P.hips.clone().applyMatrix4(this.hipsParentM.clone().invert());
    // spine
    const t3 = pose.torso ? pose.torso.map((v) => v / 3) : null;
    const tq = t3 ? eq(t3) : null;
    fk("spine", pose.spine, tq); fk("spine1", pose.chest, tq); fk("spine2", pose.upper, tq);
    fk("neck", pose.neck);
    if (pose.headAbs) setWorld("head", eq(pose.headAbs).multiply(B.head.Wr)); else fk("head", pose.head);
    // chest-space helper
    const chestT = W.spine2.clone().multiply(B.spine2.Wr.clone().invert());
    const toSpace = (arr, space) => {
      const v = V(...arr);
      if (space === "chest") return v.sub(B.spine2.Wp).applyQuaternion(chestT).add(P.spine2);
      if (space === "hips") return v.sub(B.hips.Wp).applyQuaternion(W.hips.clone().multiply(B.hips.Wr.clone().invert())).add(P.hips);
      return v;
    };
    const dirSpace = (arr, space) => {
      const v = V(...arr);
      if (space === "chest") return v.applyQuaternion(chestT);
      if (space === "hips") return v.applyQuaternion(W.hips.clone().multiply(B.hips.Wr.clone().invert()));
      return v;
    };
    // arms
    for (const s of ["l", "r"]) {
      fk(s + "Clav", pose[s + "Clav"]);
      const ik = pose[s + "Hand"];
      if (ik && ik.p) {
        // cs = how much the target rides with the chest (0 = model/world space, 1 = chest space); blendable
        const w = ik.cs ?? (ik.space === "chest" ? 1 : 0);
        const T = toSpace(ik.pw || ik.p, "model").lerp(toSpace(ik.p, "chest"), w);
        const dsp = (a) => dirSpace(a, "model").lerp(dirSpace(a, "chest"), w);
        const pole = ik.elbow ? dsp(ik.elbow) : dsp([s === "l" ? 0.4 : -0.4, -0.2, -1]);
        // reach assist: when the hand target is out of reach, swing the clavicle toward it (up to 28 degrees)
        {
          const cl = s + "Clav", arm = B[s + "Arm"], reach = this.lenArm + this.lenFore;
          const Hs = P[cl].clone().add(arm.Lp.clone().applyQuaternion(W[cl]));
          const over = Hs.distanceTo(T) - reach * 0.985;
          if (over > 0) {
            const c = V().subVectors(Hs, P[cl]), want = V().subVectors(T, P[cl]);
            const full = new THREE.Quaternion().setFromUnitVectors(c.clone().normalize(), want.normalize());
            const ang = 2 * Math.acos(Math.min(1, Math.abs(full.w))), lim = Math.min(ang, 28 * D2R, over / Math.max(0.05, c.length()) * 1.4);
            const q = new THREE.Quaternion().slerp(full, ang > 1e-5 ? lim / ang : 0);
            setWorld(cl, q.multiply(W[cl]));
          }
        }
        this._twoBone(s + "Arm", T, pole, setWorld, P, W);
        if (ik.aim) {   // thumb/grip axis + finger direction (model or chest space)
          const D = basisQ(dsp(ik.fing || [0, -1, 0]), dsp(ik.aim)).multiply(this._handQ0.clone().invert());
          setWorld(s + "Hand", D.multiply(B[s + "Hand"].Wr));
        } else if (ik.rot) setWorld(s + "Hand", eq(ik.rot).multiply(B[s + "Hand"].Wr));
        else fk(s + "Hand", ik.rel);
      } else {
        const f = pose[s + "ArmFK"] || {};
        fk(s + "Arm", f.arm); fk(s + "Fore", f.fore); fk(s + "Hand", f.hand);
      }
      // fingers
      const g = pose[s + "Grip"] ?? 0.2, th = pose[s + "Thumb"] ?? g * 0.8;
      const sign = s === "l" ? -1 : 1;
      for (const f of FINGERS) for (let i = 1; i <= 3; i++) {
        const key = `${s}${f}${i}`; const ang = g * (i === 1 ? 80 : i === 2 ? 95 : 70) * D2R;
        setLocal(key, B[key].Lr.clone().multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), sign * ang)));
      }
      for (let i = 1; i <= 3; i++) {
        const key = `${s}Thumb${i}`;
        const q = i === 1 ? new THREE.Quaternion().setFromEuler(new THREE.Euler(th * 0.5, 0, sign * th * 0.6))
          : new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), sign * th * 0.7);
        setLocal(key, B[key].Lr.clone().multiply(q));
      }
    }
    // legs
    const hipsYaw = (pose.hipsRot ? pose.hipsRot[1] : 0) || 0;
    for (const s of ["l", "r"]) {
      const f = pose[s + "Foot"] || {};
      const rest = B[s + "Foot"].Wp;
      let fq = eq([f.pitch || 0, f.yaw || 0, f.roll || 0]).multiply(B[s + "Foot"].Wr);
      if (f.space === "hips") fq = W.hips.clone().multiply(B.hips.Wr.clone().invert()).multiply(fq);
      const off = V(...(f.p || [0, 0, 0]));
      let T;
      if (f.pivot === "ball") {
        const ball = B[s + "Toe"].Wp.clone().add(off);
        T = ball.sub(B[s + "Toe"].Lp.clone().applyQuaternion(fq));
      } else if (f.space === "hips") T = toSpace(rest.clone().add(off).toArray(), "hips");
      else T = rest.clone().add(off);
      const yaw = (f.yaw || 0) * 0.6 + hipsYaw * 0.4;
      const pole = f.knee ? dirSpace(f.knee, f.space) : V(Math.sin(yaw * D2R) + (s === "l" ? 0.08 : -0.08), 0, Math.cos(yaw * D2R));
      this._twoBone(s + "Leg", T, pole, setWorld, P, W);
      setWorld(s + "Foot", fq);
      const toe = f.toe ?? (f.pivot === "ball" ? -(f.pitch || 0) : 0);
      fk(s + "Toe", [toe, 0, 0]);
    }
    return { q: out, hipsPos: hipsPosLocal, P, W };
  }

  _twoBone(limb, T, pole, setWorld, P, W) {
    const L = this._limb[limb]; const B = this.b;
    // upper bone origin comes from the (already posed) parent
    const up = B[L.up]; const H = P[up.parentKey].clone().add(up.Lp.clone().applyQuaternion(W[up.parentKey]));
    const a = B[L.lo].Lp.length(), b = B[L.end].Lp.length();
    const to = V().subVectors(T, H); let d = to.length();
    if (d > a + b - 1e-3) { if (d > a + b + 0.02) this.warn.push(limb + " stretch " + (d - a - b).toFixed(3)); d = a + b - 1e-3; }
    if (d < Math.abs(a - b) + 1e-3) d = Math.abs(a - b) + 1e-3;
    const dir = to.normalize();
    const cosA = (a * a + d * d - b * b) / (2 * a * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const pp = pole.clone().addScaledVector(dir, -pole.dot(dir)); if (pp.lengthSq() < 1e-8) pp.copy(L.pole0); pp.normalize();
    const K = H.clone().addScaledVector(dir, a * cosA).addScaledVector(pp, a * sinA);
    const E = H.clone().addScaledVector(dir, d);
    const hinge = V().crossVectors(pp, dir).normalize();
    const aU = V().subVectors(K, H).normalize(), aL = V().subVectors(E, K).normalize();
    const qU = basisQ(aU, hinge).multiply(L.q0U.clone().invert()).multiply(B[L.up].Wr);
    setWorld(L.up, qU);
    const qL = basisQ(aL, hinge).multiply(L.q0L.clone().invert()).multiply(B[L.lo].Wr);
    setWorld(L.lo, qL);
  }

  // ------------------------------------------------------------------ baking
  bake(spec) {
    const fps = spec.fps || 30, dur = spec.dur ?? spec.keys[spec.keys.length - 1].t;
    const n = Math.max(2, Math.round(dur * fps) + 1);
    const sampler = makeSampler(spec.keys, dur, !!spec.loop, spec.base || {});
    const times = new Float32Array(n);
    const qv = {}; for (const k in this.b) qv[k] = new Float32Array(n * 4);
    const hp = new Float32Array(n * 3);
    const rmTimes = [], rmVals = [], rmYaw = [];
    this.warn = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min(dur, i / fps); times[i] = t;
      const pose = sampler(t);
      if (spec.world) toRootSpace(pose, this.b.hips.Wp);
      const r = this.solve(pose);
      for (const k in this.b) { const q = r.q[k] || this.b[k].Lr; q.toArray(qv[k], i * 4); }
      r.hipsPos.toArray(hp, i * 3);
      rmTimes.push(t); rmVals.push(V(...(pose.root || [0, 0, 0]))); rmYaw.push((pose.rootYaw || 0) * D2R);
    }
    const tracks = [new THREE.VectorKeyframeTrack(this.b.hips.node.name + ".position", times, hp)];
    for (const k in this.b) {
      // keep quaternion continuity for interpolation
      const a = qv[k];
      for (let i = 1; i < n; i++) { const d = a[i * 4] * a[i * 4 - 4] + a[i * 4 + 1] * a[i * 4 - 3] + a[i * 4 + 2] * a[i * 4 - 2] + a[i * 4 + 3] * a[i * 4 - 1]; if (d < 0) for (let j = 0; j < 4; j++) a[i * 4 + j] *= -1; }
      tracks.push(new THREE.QuaternionKeyframeTrack(this.b[k].node.name + ".quaternion", times, a));
    }
    const clip = new THREE.AnimationClip(spec.name, dur, tracks);
    const hasRM = rmVals.some((v) => v.lengthSq() > 1e-8);
    const rm = hasRM ? { times: rmTimes, vals: rmVals, yaw: rmYaw, dur, end: rmVals[n - 1].clone() } : null;
    if (this.warn.length) clip.userData = { warn: [...new Set(this.warn)].slice(0, 6) };
    return { clip, rm, warn: [...new Set(this.warn)] };
  }
}

// world-authored clips: hips / hands / feet are given in the clip's start frame; subtract the root motion
function toRootSpace(pose, restHips) {   // world clips give hips as an absolute position
  const r = pose.root || [0, 0, 0];
  const sub = (a) => a && [a[0] - r[0], a[1] - r[1], a[2] - r[2]];
  if (pose.hips) pose.hips = [pose.hips[0] - r[0] - restHips.x, pose.hips[1] - r[1] - restHips.y, pose.hips[2] - r[2] - restHips.z];
  for (const k of ["lHand", "rHand"]) if (pose[k] && pose[k].p) pose[k].pw = sub(pose[k].p);
  for (const k of ["lFoot", "rFoot"]) if (pose[k] && pose[k].p) pose[k].p = sub(pose[k].p);
}

// ------------------------------------------------------------------ keyframe interpolation
// Every numeric leaf of the pose objects is a channel. Channels are interpolated with monotone cubic
// (Fritsch–Carlson) splines: no overshoot, exact holds when neighbouring keys are equal (planted feet
// stay planted), smooth ease through peaks. Strings / booleans are stepped.
function flatten(obj, pre, out) {
  for (const k in obj) {
    if (k === "t" || k === "ease") continue;
    const v = obj[k], p = pre ? pre + "." + k : k;
    if (typeof v === "number") out[p] = v;
    else if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === "number") out[p + "." + i] = x; });
    else if (v && typeof v === "object") flatten(v, p, out);
    else out["$" + p] = v;
  }
  return out;
}
function setPath(obj, path, val) {
  const parts = path.split("."); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i], nextIsIdx = /^\d+$/.test(parts[i + 1]);
    if (o[k] === undefined) o[k] = nextIsIdx ? [] : {};
    o = o[k];
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(o)) o[+last] = val; else o[last] = val;
}
function makeSampler(keys, dur, loop, base) {
  const flat = keys.map((k) => flatten(k, "", {}));
  const baseFlat = flatten(base, "", {});
  const chans = new Set(); flat.forEach((f) => Object.keys(f).forEach((c) => chans.add(c)));
  const T = keys.map((k) => k.t);
  const series = {};
  for (const c of chans) {
    const vals = []; let last;
    for (let i = 0; i < flat.length; i++) { if (c in flat[i]) last = flat[i][c]; vals.push(last); }
    // fill leading gaps from the first defined value (or base / 0)
    const first = vals.find((v) => v !== undefined) ?? (c in baseFlat ? baseFlat[c] : 0);
    for (let i = 0; i < vals.length && vals[i] === undefined; i++) vals[i] = first;
    series[c] = vals;
  }
  const ts = loop ? [...T, dur] : T;
  const tang = {};
  for (const c in series) {
    if (c.startsWith("$")) continue;
    const v = loop ? [...series[c], series[c][0]] : series[c];
    tang[c] = monotoneTangents(ts, v, loop);
    series[c] = v;
  }
  return (t) => {
    if (loop) t = ((t % dur) + dur) % dur;
    let i = 0; while (i < ts.length - 2 && t >= ts[i + 1]) i++;
    const t0 = ts[i], t1 = ts[i + 1] ?? t0, h = Math.max(1e-6, t1 - t0);
    const u = Math.min(1, Math.max(0, (t - t0) / h));
    const pose = JSON.parse(JSON.stringify(base));
    for (const c in series) {
      if (c.startsWith("$")) { const vals = series[c]; let v = vals[Math.min(i, vals.length - 1)]; if (t >= t1 && vals[i + 1] !== undefined) v = vals[i + 1]; setPath(pose, c.slice(1), v); continue; }
      const v = series[c], m = tang[c];
      if (i + 1 >= v.length) { setPath(pose, c, v[v.length - 1]); continue; }
      const u2 = u * u, u3 = u2 * u;
      const val = (2 * u3 - 3 * u2 + 1) * v[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * v[i + 1] + (u3 - u2) * h * m[i + 1];
      setPath(pose, c, val);
    }
    return pose;
  };
}
function monotoneTangents(t, v, loop) {
  const n = v.length; const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((v[i + 1] - v[i]) / Math.max(1e-6, t[i + 1] - t[i]));
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  if (loop && n > 2) { const dl = d[n - 2], d0 = d[0]; m[0] = m[n - 1] = dl * d0 <= 0 ? 0 : (dl + d0) / 2; }
  else { m[0] = d[0] ?? 0; m[n - 1] = d[n - 2] ?? 0; if (n > 2) { m[0] = 0; m[n - 1] = 0; } }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return m;
}

// mirror a pose left <-> right (for Shimmy_R from Shimmy_L etc.)
export function mirrorPose(p) {
  const out = {};
  const mE = (e) => e && [e[0], -(e[1] || 0), -(e[2] || 0)];
  const mP = (v) => v && [-v[0], v[1], v[2]];
  for (const k in p) {
    const v = p[k]; let nk = k;
    if (/^l[A-Z]/.test(k)) nk = "r" + k.slice(1); else if (/^r[A-Z]/.test(k)) nk = "l" + k.slice(1);
    if (["hipsRot", "torso", "spine", "chest", "upper", "neck", "head", "headAbs", "lClav", "rClav"].includes(k)) out[nk] = mE(v);
    else if (k === "hips" || k === "root") out[nk] = mP(v);
    else if (k === "rootYaw") out[nk] = -v;
    else if (/Hand$/.test(k) && v && typeof v === "object") out[nk] = { ...v, p: mP(v.p), elbow: mP(v.elbow), rot: mE(v.rot), rel: mE(v.rel), aim: mP(v.aim), fing: mP(v.fing) };
    else if (/Foot$/.test(k) && v && typeof v === "object") out[nk] = { ...v, p: mP(v.p), yaw: v.yaw && -v.yaw, roll: v.roll && -v.roll, knee: mP(v.knee) };
    else if (/ArmFK$/.test(k) && v) out[nk] = { arm: mE(v.arm), fore: mE(v.fore), hand: mE(v.hand) };
    else out[nk] = v;
  }
  for (const k in out) if (out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) for (const j in out[k]) if (out[k][j] === undefined) delete out[k][j];
  return out;
}
