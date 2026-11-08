// Pure logic, no browser APIs: gesture reading, jitter filtering, and stroke smoothing.
window.Mist = window.Mist || {};

// ---------- Reading the hand ----------
//
// Fingers are judged by joint ANGLES from the 3D landmarks, never by apparent length.
// A finger aimed at the camera looks short (so length-based checks see a fist), but a
// straight line stays straight under foreshortening, so its joints still read as open.
Mist.Gesture = (() => {
  const FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  const FULL_CURL = 130 * Math.PI / 180;   // PIP bend + half of DIP bend in a closed finger

  function bend(a, b, c) {                 // 0 when a-b-c is straight
    const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z;
    const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
    const m = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1e-9;
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / m));
    return Math.PI - Math.acos(cos);
  }

  function read(w) {
    const curl = FINGERS.map(([m, p, d, t]) =>
      Math.min(1, (bend(w[m], w[p], w[d]) + .5 * bend(w[p], w[d], w[t])) / FULL_CURL));
    const pc = {
      x: (w[0].x + w[5].x + w[17].x) / 3,
      y: (w[0].y + w[5].y + w[17].y) / 3,
      z: (w[0].z + w[5].z + w[17].z) / 3,
    };
    const palm = Math.hypot(w[0].x - w[9].x, w[0].y - w[9].y, w[0].z - w[9].z) || 1e-9;
    const tipNear = Math.hypot(w[8].x - pc.x, w[8].y - pc.y, w[8].z - pc.z) / palm;
    // How straight the index is: 1 is a ruler, a curled finger is much lower. Unlike a joint
    // angle, this stays reliable when the finger points at the camera and its bones look short.
    const D = (a, b) => Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y, w[a].z - w[b].z);
    const straight = D(5, 8) / ((D(5, 6) + D(6, 7) + D(7, 8)) || 1e-9);
    // Reach: how far each fingertip is from the wrist compared with its middle knuckle. An
    // outstretched finger reaches well past its knuckle (about 1.35), a folded one comes back
    // toward the palm (under 1). It's a second, independent opinion to the joint angles.
    const reach = FINGERS.map(([m, p, d, t]) => D(0, t) / (D(0, p) || 1e-9));
    return { curl, tipNear, straight, reach };
  }

  // What this one frame looks like. null means "can't tell", and the current state then stands.
  function evidence(idx, mid, ring, pinky, tipNear, straight = 0, reach = null) {
    const e = angles(idx, mid, ring, pinky, tipNear, straight);
    if (!reach) return e;
    // Both opinions must agree before the glass is touched. A fist needs every fingertip folded
    // back; a point needs the index reaching out and the others not.
    if (e === 'fist' && Math.max(reach[0], reach[1], reach[2], reach[3]) > 1.06) return null;
    if (e === 'finger' && (reach[0] < 1.15 || (reach[1] > 1.12) + (reach[2] > 1.12) + (reach[3] > 1.12) >= 2)) return null;
    return e;
  }

  function angles(idx, mid, ring, pinky, tipNear, straight) {
    const rest = (mid + ring + pinky) / 3;
    // A fingertip tucked against the palm settles it: that finger is not out, whatever its
    // joints appear to read. (Real photos: fists sit at .4 to .75, a real point at about 1.35.)
    const tucked = tipNear < .85;
    if (tucked && rest > .45 && idx > .22) return 'fist';

    // Pointing is judged by contrast: the index must be clearly more open than the other fingers,
    // the middle one included (or it's a peace sign). Noise inflates every finger's reading equally,
    // because a bend can only be positive, so a contrast holds up where a fixed threshold wouldn't.
    if (!tucked && mid - idx > .15 && rest - idx > .2 && rest > .36 && idx < .6) return 'finger';

    // Real fists read looser than you'd expect (index around .5). In a fist the index is about as
    // closed as the others, which a point never is.
    if (Math.min(mid, ring, pinky) > .48 && rest - idx < .28 && idx > .5 && tipNear < 1.4 && straight < .84) return 'fist';
    if (rest < .42) return 'hover';
    return null;
  }

  // How long (ms) a reading must hold to change state. Becoming a fist is deliberately the
  // hardest, above all from pointing, so curling your other fingers can never start a wipe.
  const NEED = {
    hover: { finger: 110, fist: 190 },
    finger: { hover: 110, fist: 320 },
    fist: { hover: 110, finger: 90 },
  };

  class Machine {
    constructor() {
      this.state = 'hover';
      this.acc = { hover: 0, finger: 0, fist: 0 };
      this.idx = 0;
      this.c = null;
      this.liftMs = 0;
      this.lifted = false;
      this.last = null;
    }

    update(world, dtMs) {
      const r = read(world);
      const dt = Math.min(dtMs, 80);
      // Readings are smoothed over a few frames, so a single bad landmark can't swing them.
      const k = 1 - Math.exp(-dt / 55);
      if (!this.c) this.c = r.curl.slice();
      else for (let i = 0; i < 4; i++) this.c[i] += (r.curl[i] - this.c[i]) * k;
      this.idx = this.c[0];
      this.straight = this.straight === undefined ? r.straight : this.straight + (r.straight - this.straight) * k;
      if (!this.reach) this.reach = r.reach.slice();
      else for (let i = 0; i < 4; i++) this.reach[i] += (r.reach[i] - this.reach[i]) * k;
      const e = evidence(this.c[0], this.c[1], this.c[2], this.c[3], r.tipNear, this.straight, this.reach);
      this.last = { curl: this.c, idx: this.idx, tipNear: r.tipNear, straight: this.straight, reach: this.reach, evidence: e };

      // One noisy frame only slows a change down; it cannot trigger or cancel one.
      for (const s in this.acc) this.acc[s] = s === e ? this.acc[s] + dt : Math.max(0, this.acc[s] - dt);
      if (e && e !== this.state && this.acc[e] >= NEED[this.state][e]) {
        this.state = e;
        this.acc = { hover: 0, finger: 0, fist: 0 };
        this.lifted = false;
        this.liftMs = 0;
      }

      // Curling the index moves its tip, which would scribble. Lift the pen as soon as the
      // finger starts to close, before the state has resolved.
      const leaving = (this.state === 'finger' && this.idx > .56) || (this.state === 'fist' && e !== 'fist' && e !== null);
      this.liftMs = leaving ? this.liftMs + dt : Math.max(0, this.liftMs - dt * 2);
      this.lifted = this.liftMs >= 45;
      return this.state;
    }

    get touching() { return this.state !== 'hover' && !this.lifted; }
  }

  return { read, evidence, angles, Machine, NEED };
})();

// ---------- One Euro filter ----------
// Heavy smoothing when you hold still (no jitter), almost none when you move (no lag).
Mist.OneEuro = class {
  constructor(minCutoff = 1.5, beta = 7, dCutoff = 1.2) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, dt) {
    if (this.x === null || dt <= 0) { this.x = v; return v; }
    const d = (v - this.x) / dt;
    this.dx += (d - this.dx) * Mist.OneEuro.alpha(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (v - this.x) * Mist.OneEuro.alpha(cutoff, dt);
    return this.x;
  }
};

// ---------- Stroke path ----------
// Camera samples arrive 30 times a second, and joining them with straight lines looks
// polygonal. The Pen fits a centripetal Catmull-Rom curve through them and plays it back
// a little behind real time, so the line grows every display frame instead of in jumps.
Mist.Pen = class {
  constructor(minStep = .0011, maxChord = .0035) {
    this.minStep = minStep; this.maxChord = maxChord;
    this.pts = []; this.i = 0; this.u = 0; this.cur = null; this.active = false;
  }

  begin(x, y, t) {
    this.pts = [{ x, y, t }]; this.i = 0; this.u = 0;
    this.cur = { x, y }; this.active = true; this.fresh = true;
  }

  add(x, y, t) {
    if (!this.active) return this.begin(x, y, t);
    const last = this.pts[this.pts.length - 1];
    if (Math.hypot(x - last.x, y - last.y) < this.minStep) return;
    this.pts.push({ x, y, t: Math.max(t, last.t + .5) });
  }

  static knot(a, b) { return Math.max(1e-5, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y))); }

  sample(i, u) {
    const P = this.pts, p1 = P[i], p2 = P[i + 1];
    const p0 = P[i - 1] || { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
    // The newest segment has no next point yet. Predict it from velocity and acceleration, so
    // the curve's direction already matches where the real next point will take it.
    let p3 = P[i + 2];
    if (!p3) {
      const vx = p2.x - p1.x, vy = p2.y - p1.y;
      let ax = vx - (p1.x - p0.x), ay = vy - (p1.y - p0.y);
      const cap = Math.hypot(vx, vy) / (Math.hypot(ax, ay) || 1);
      if (cap < 1) { ax *= cap; ay *= cap; }
      p3 = { x: p2.x + vx + ax, y: p2.y + vy + ay };
    }
    const d0 = Mist.Pen.knot(p0, p1), d1 = Mist.Pen.knot(p1, p2), d2 = Mist.Pen.knot(p2, p3);
    const axis = (a, b, c, d) => {
      const m1 = d1 * ((b - a) / d0 - (c - a) / (d0 + d1) + (c - b) / d1);
      const m2 = d1 * ((c - b) / d1 - (d - b) / (d1 + d2) + (d - c) / d2);
      const A = 2 * b - 2 * c + m1 + m2, B = -3 * b + 3 * c - 2 * m1 - m2;
      return ((A * u + B) * u + m1) * u + b;
    };
    return { x: axis(p0.x, p1.x, p2.x, p3.x), y: axis(p0.y, p1.y, p2.y, p3.y) };
  }

  // Emit everything up to time T. emit(ax, ay, bx, by)
  advance(T, emit) {
    if (!this.active) return;
    if (this.fresh) { this.fresh = false; emit(this.cur.x, this.cur.y, this.cur.x, this.cur.y); }
    const P = this.pts;
    while (this.i + 1 < P.length) {
      const a = P[this.i], b = P[this.i + 1];
      const target = Math.min(1, (T - a.t) / (b.t - a.t));
      if (target <= this.u) break;
      const span = Math.hypot(b.x - a.x, b.y - a.y) * (target - this.u);
      const steps = Math.min(40, Math.max(1, Math.ceil(span / this.maxChord)));
      const u0 = this.u;
      for (let k = 1; k <= steps; k++) {
        const p = this.sample(this.i, u0 + (target - u0) * k / steps);
        emit(this.cur.x, this.cur.y, p.x, p.y);
        this.cur = p;
      }
      this.u = target;
      if (target < 1) break;
      this.i++; this.u = 0;
    }
    // Keep only the points the curve can still need.
    if (this.i > 3) { P.splice(0, this.i - 2); this.i = 2; }
  }

  end(emit) {
    if (!this.active) return null;
    this.advance(Infinity, emit);
    this.active = false;
    return this.cur;
  }
};

// ---------- Blow face ----------
// Rounded lips fog the glass the moment they form. Two independent signs are read:
//   shape:  the mouth corners pull in (measured from the face mesh, relative to YOUR relaxed mouth)
//   model:  the tracker's own pucker / funnel scores, also relative to your relaxed face
// Either one is enough, because the model's scores differ a lot from person to person, while
// the corners always pull in when you purse your lips. A smile widens the mouth, so it never counts.
Mist.BlowDetector = class {
  constructor() {
    this.rest = null;     // your relaxed face, learned as you go
    this.strength = 0; this.score = 0; this.on = false; this.hold = 0; this.off = 0; this.n = 0;
  }

  measure(f) {
    const r = this.rest;
    const rb = Math.max(f.pucker, f.funnel * 1.15) + .3 * f.puff;
    const c = x => Math.max(0, Math.min(1, x));
    const narrow = f.width && r.width ? (r.width - f.width) / r.width : 0;
    const shape = c((narrow - .045) / .09);                    // corners in by 4.5% starts, 13.5% is full
    const model = c((rb - r.b - .07) / .2);
    const smiling = c((f.smile - r.smile - .2) / .3);
    return { rb, narrow, shape, model, score: Math.max(shape, model) * (1 - smiling) };
  }

  update(f, dt) {
    if (!f) {
      this.on = false; this.hold = 0; this.score = 0;
    } else {
      const rb0 = Math.max(f.pucker, f.funnel * 1.15) + .3 * f.puff;
      if (!this.rest) this.rest = { width: f.width || 0, b: Math.min(rb0, .15), smile: Math.min(f.smile, .3) };
      const m = this.measure(f);
      this.last = m;
      this.score = m.score;
      this.n++;

      // On fast, off a touch slower, and a single odd reading never switches it.
      if (!this.on) { this.hold = m.score > .3 ? this.hold + dt : 0; if (this.hold >= .05) { this.on = true; this.off = 0; } }
      else { this.off = m.score < .12 ? this.off + dt : 0; if (this.off >= .07) { this.on = false; this.hold = 0; } }

      // Learn the relaxed face, only while not blowing. The first half second learns quickly.
      if (!this.on && m.score < .12) {
        const r = this.rest, quick = this.n < 15 ? 8 : 1;
        // A smile stretches the mouth, so nothing about its width is learned during one.
        if (f.width && f.smile - r.smile < .12 && f.smile < .4) {
          // Relaxed is the widest your mouth sits without smiling, so widening is learned fast.
          const up = f.width > r.width;
          r.width += (f.width - r.width) * Math.min(1, dt * (up ? 3 * quick : .4 * quick));
        }
        if (m.rb < r.b) r.b += (m.rb - r.b) * Math.min(1, dt * 4);
        else if (m.rb < r.b + .04) r.b = Math.min(.2, r.b + dt * .03);
        r.smile += (f.smile - r.smile) * Math.min(1, dt * (f.smile < r.smile ? 3 : .3));
      }
    }
    const s = this.score, eased = s * s * (3 - 2 * s);
    // Thick fog from the first moment: never a faint wisp while your lips are round.
    const target = this.on ? Math.max(.65, eased) : 0;
    this.strength += (target - this.strength) * Math.min(1, dt * (target > this.strength ? 30 : 10));
    if (this.strength < .004) this.strength = 0;
    return this.strength;
  }
};
