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
    return { curl, tipNear, straight };
  }

  // What this one frame looks like. null means "can't tell", and the current state then stands.
  function evidence(idx, mid, ring, pinky, tipNear, straight = 0) {
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
      const e = evidence(this.c[0], this.c[1], this.c[2], this.c[3], r.tipNear, this.straight);
      this.last = { curl: this.c, idx: this.idx, tipNear: r.tipNear, straight: this.straight, evidence: e };

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

  return { read, evidence, Machine, NEED };
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
// Pursed lips (pucker or funnel), helped by puffed cheeks. Measured against your own resting
// face, since some mouths simply rest more puckered. A wide-open mouth or a smile doesn't count.
Mist.BlowDetector = class {
  constructor() { this.strength = 0; this.base = null; this.hold = 0; this.level = 0; }

  update(f, dt) {
    let target = 0;
    if (f) {
      const raw = Math.max(f.pucker, f.funnel * 1.1) + .4 * f.puff;
      if (this.base === null) this.base = Math.min(raw, .25);
      // Rest position drifts slowly, and only while you're clearly not blowing.
      else if (raw < this.base) this.base += (raw - this.base) * Math.min(1, dt * 3);
      else if (raw < this.base + .12) this.base += (raw - this.base) * Math.min(1, dt * .15);
      let s = raw - this.base;
      s -= Math.max(0, f.jaw - .45) * 1.2;
      s -= f.smile * .8;
      this.level = Math.max(0, Math.min(1, (s - .16) / .3));
      target = this.level;
    } else {
      this.level = 0;
    }
    // A passing expression shouldn't fog the glass.
    this.hold = target > .05 ? this.hold + dt : Math.max(0, this.hold - dt * 3);
    const gated = this.hold > .1 ? target : 0;
    this.strength += (gated - this.strength) * Math.min(1, dt * (gated > this.strength ? 10 : 4));
    if (this.strength < .004) this.strength = 0;
    return this.strength;
  }
};
