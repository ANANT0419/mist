// Webcam hand tracking. Inference runs in a worker; video is never uploaded anywhere.
//   one finger out, others curled -> draw exactly where your fingertip appears in the mirror
//   all four fingers closed        -> wipe, at real hand size
//   open hand                      -> hover, to move without touching
window.Mist = window.Mist || {};

Mist.Hands = class {
  // toGlass(lx, ly) maps camera coordinates to glass coordinates (y up, 0..1)
  constructor(video, toGlass) {
    this.video = video;
    this.toGlass = toGlass;
    this.worker = null;
    this.running = false;
    this.busy = false;
    this.slots = [];
    this.nextId = 1;
    this.lastT = -1;
    this.interval = 33;
    this.lastArrival = 0;
    this.stats = { infer: 0, roundTrip: 0, fps: 0, delegate: '' };
    this.raw = [];
  }

  start() {
    if (this.worker) { this.running = true; this.pump(); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = this.worker = new Worker('js/hand-worker.js');
      const timer = setTimeout(() => reject(new Error('Hand tracker timed out')), 45000);
      w.onerror = e => { clearTimeout(timer); reject(new Error(e.message || 'Worker failed')); };
      w.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          clearTimeout(timer);
          this.stats.delegate = data.delegate;
          this.running = true;
          this.pump();
          resolve();
        } else if (data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(data.message));
        } else if (data.type === 'result') {
          this.busy = false;
          this.onResult(data);
        } else if (data.type === 'frameError') {
          this.busy = false;
        }
      };
      w.postMessage({ type: 'init' });
    });
  }

  setNumHands(n) { if (this.worker) this.worker.postMessage({ type: 'options', numHands: n }); }

  stop() {
    this.running = false;
    for (const s of this.slots) s.pen.active = false;
    this.slots = [];
  }

  pump() {
    const v = this.video;
    if (!v.requestVideoFrameCallback) {
      const poll = () => {
        if (!this.running) return;
        if (v.currentTime !== this.lastT) { this.send(v.currentTime * 1000); this.lastT = v.currentTime; }
        requestAnimationFrame(poll);
      };
      return poll();
    }
    if (this.pumping) return;
    this.pumping = true;
    const onFrame = (now, meta) => {
      if (!this.running) { this.pumping = false; return; }
      this.send(meta.mediaTime * 1000);
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  // Never queue frames: if the tracker is busy, skip this one. Stale frames are pure lag.
  send(t) {
    if (this.busy || !this.running || !this.video.videoWidth) return;
    if (t <= this.sentT) t = this.sentT + 1;
    this.sentT = t;
    this.busy = true;
    const v = this.video;
    const k = Math.min(1, 960 / v.videoWidth);
    createImageBitmap(v, { resizeWidth: Math.round(v.videoWidth * k), resizeHeight: Math.round(v.videoHeight * k), resizeQuality: 'medium' })
      .then(bitmap => this.worker.postMessage({ type: 'frame', bitmap, t, sent: performance.now() }, [bitmap]))
      .catch(() => { this.busy = false; });
  }

  onResult(msg) {
    const now = performance.now();
    if (!this.running) return;
    if (this.lastArrival) {
      const gap = now - this.lastArrival;
      if (gap < 200) this.interval += (gap - this.interval) * .08;
    }
    this.lastArrival = now;
    const st = this.stats;
    st.infer += (msg.infer - st.infer) * .1;
    st.roundTrip += (now - msg.sent - st.roundTrip) * .1;
    st.fps = 1000 / this.interval;
    this.ingest(msg.hands, msg.t, now);
  }

  // Follow hands by position, not the left/right label, because that label can flip between
  // frames, and a flip would otherwise look like the hand teleporting.
  ingest(hands, t, now) {
    this.raw = hands;
    const dets = hands.filter(h => h.score > .5).map(h => {
      const lm = h.lm;
      const px = (lm[0].x + lm[5].x + lm[17].x) / 3, py = (lm[0].y + lm[5].y + lm[17].y) / 3;
      return { h, px, py, used: false };
    });
    const free = new Set(this.slots);
    const pairs = [];
    for (const d of dets) for (const s of this.slots) {
      pairs.push({ d, s, dist: Math.hypot(d.px - s.px, d.py - s.py) });
    }
    pairs.sort((a, b) => a.dist - b.dist);
    for (const { d, s, dist } of pairs) {
      if (d.used || !free.has(s) || dist > .3) continue;
      d.used = true; free.delete(s);
      this.feed(s, d, t, now);
    }
    for (const d of dets) {
      if (d.used || this.slots.length >= 2) continue;
      const s = this.newSlot();
      this.slots.push(s);
      this.feed(s, d, t, now);
    }
  }

  newSlot() {
    const f = () => new Mist.OneEuro(1.5, 7, 1.2);
    return {
      id: this.nextId++, machine: new Mist.Gesture.Machine(), pen: new Mist.Pen(),
      tipX: f(), tipY: f(), fistX: f(), fistY: f(),
      x: .5, y: .5, tip: null, knuckles: null, r: .08, t: 0, seen: 0, born: 0,
      px: 0, py: 0, wasKind: null, finishing: [],
    };
  }

  feed(s, d, t, now) {
    const lm = d.h.lm, A = this.aspect();
    const dtMs = s.t ? Math.max(1, t - s.t) : this.interval;
    const dt = dtMs / 1000;
    s.t = t; s.seen = now; s.px = d.px; s.py = d.py;
    if (!s.born) s.born = now;

    s.machine.update(d.h.world, dtMs);

    const tip = this.toGlass(lm[8].x, lm[8].y);
    const kx = (lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 4, ky = (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4;
    const kn = this.toGlass(kx, ky);
    s.tip = { x: s.tipX.filter(tip.x * A, dt) / A, y: s.tipY.filter(tip.y, dt) };
    s.knuckles = { x: s.fistX.filter(kn.x * A, dt) / A, y: s.fistY.filter(kn.y, dt) };

    // A wipe should be as wide as your fist looks in the mirror.
    const a = this.toGlass(lm[5].x, lm[5].y), b = this.toGlass(lm[17].x, lm[17].y);
    const width = Math.hypot((a.x - b.x) * A, a.y - b.y);
    s.r += (Math.max(.05, Math.min(.2, width * .68)) - s.r) * .2;

    // A hand just entering the frame is not yet a deliberate touch.
    const settled = now - s.born > 110;
    const touching = settled && s.machine.touching;
    const kind = s.machine.state === 'fist' ? 1 : 0;
    const p = kind ? s.knuckles : s.tip;
    s.x = p.x; s.y = p.y;

    if (touching) {
      if (s.wasKind !== kind) {
        this.lift(s);
        s.wasKind = kind;
        s.pen.kind = kind;
        s.pen.seed = Math.random();
        s.pen.begin(p.x * A, p.y, now);
      } else {
        s.pen.add(p.x * A, p.y, now);
      }
    } else if (s.wasKind !== null) {
      this.lift(s);
      s.wasKind = null;
    }
  }

  // The old stroke keeps playing out to its end while a new one can start straight away.
  lift(s) {
    if (s.pen.active) { s.finishing.push(s.pen); s.pen = new Mist.Pen(); }
  }

  aspect() { return this.getAspect ? this.getAspect() : 1; }

  // Called every display frame. emit(ax, ay, bx, by, kind, seed, r) in glass coordinates.
  advance(now, emit, onLift) {
    if (!this.running) return [];
    const A = this.aspect();
    // Play the curve back one sample behind, so the next point is known and the line never kinks.
    const delay = Math.max(10, Math.min(40, this.interval * 1.02));
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i];
      const gone = now - s.seen > 190;
      if (gone) this.lift(s);
      const radius = pen => pen.kind ? s.r : Mist.Hands.FINGER_R;
      const out = pen => (ax, ay, bx, by) => emit(ax / A, ay, bx / A, by, pen.kind, pen.seed, radius(pen));
      for (const pen of s.finishing) {
        const end = pen.end(out(pen));
        if (end && onLift) onLift(end.x / A, end.y, radius(pen), pen.kind);
      }
      s.finishing.length = 0;
      if (s.pen.active) s.pen.advance(now - delay, out(s.pen));
      if (gone) this.slots.splice(i, 1);
    }
    return this.slots;
  }
};

Mist.Hands.FINGER_R = .0095;
