// The winner's prize. Designed as an event, not a timer:
//   lift   the winning drawing rises off the glass and condenses into a seed of light
//   gift   it waits. The 10 seconds are yours to start, when you raise both hands
//   open   threads spring between your fingertips and snap into a glass prism
//   play   10 seconds holding another reality. The edges burn down like a fuse, the world
//          inside changes, and your rival watches it live
//   shatter it breaks at zero, because scarcity is the point
//   keep   a clip of your 10 seconds is yours to take away
window.Mist = window.Mist || {};

Mist.Prize = class {
  constructor({ app, mine, tie, video, ribbon, ribbonSide, paneAspect, send, onAgain }) {
    Object.assign(this, { app, mine, tie, video, send, onAgain });
    this.R = app.R;
    this.gl = app.R.gl;
    this.phase = 'lift';
    this.ph = 0;
    this.T = 0;
    this.life = 1;
    this.opened = 0;
    this.handsUp = 0;
    this.style = 0; this.styleNext = 1; this.styleMix = 1; this.styleClock = 0;
    this.kp = null; this.target = null;
    this.sparks = [];
    this.shards = null;
    this.beatAt = 3;
    this.ui = {
      root: document.getElementById('prize'), title: document.getElementById('prize-title'), sub: document.getElementById('prize-sub'),
      num: document.getElementById('prize-num'), skip: document.getElementById('prize-skip'),
      keep: document.getElementById('keep-card'), clip: document.getElementById('keep-clip'),
      keepTitle: document.getElementById('keep-title'), keepSub: document.getElementById('keep-sub'),
      save: document.getElementById('keep-save'), again: document.getElementById('keep-again'),
    };
    this.ensureGL();
    this.buildRibbon(ribbon, ribbonSide, paneAspect);

    // The dividing wall falls away: one person now holds the whole screen.
    app.enterFull(video);
    app.sound.cue('rise');
    if (mine) app.hands.setNumHands(2);
    this.ui.root.hidden = false;
    this.ui.root.dataset.phase = 'lift';
    this.ui.root.dataset.low = '0';
    this.ui.num.textContent = '';
    this.ui.keep.hidden = true;
    this.say(mine ? (tie ? 'You both win' : 'You win') : 'They win', mine ? 'Something is waiting for you' : 'Watch what they do with it');
    this.ui.skip.onclick = () => this.go('keep');
    this.ui.skip.hidden = true;
    this.ui.again.onclick = () => { this.ui.again.disabled = true; this.onAgain(); };
  }

  say(t, s) { this.ui.title.textContent = t; this.ui.sub.textContent = s || ''; }

  waitingForRival() { this.ui.again.textContent = 'Waiting for them…'; }

  // ---------- GL ----------
  ensureGL() {
    const R = this.R, gl = this.gl;
    if (R.prizeGL) { Object.assign(this, R.prizeGL); return; }
    const S = Mist.prizeShaders;
    const fill = R.program(S.FILL_VS, S.FILL_FS), edge = R.program(S.EDGE_VS, S.EDGE_FS), pts = R.program(S.PT_VS, S.PT_FS);
    const mk = (P, layout) => {
      const vao = gl.createVertexArray(), buf = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const stride = layout.reduce((a, l) => a + l[1], 0) * 4;
      let off = 0;
      for (const [name, n] of layout) {
        const loc = gl.getAttribLocation(P.p, name);
        if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off); }
        off += n * 4;
      }
      gl.bindVertexArray(null);
      return { P, vao, buf };
    };
    R.prizeGL = {
      gFill: mk(fill, [['aP', 2], ['aUv', 2], ['aA', 1]]),
      gEdge: mk(edge, [['aP', 2], ['aS', 1], ['aT', 1], ['aB', 1]]),
      gPts: mk(pts, [['aP', 2], ['aZ', 1], ['aC', 4]]),
    };
    Object.assign(this, R.prizeGL);
  }

  // ---------- Ribbon ----------
  buildRibbon(raw, side, pa) {
    const A = this.R.aspect;
    const pts = [];
    const n = Math.floor(raw.length / 2);
    const step = Math.max(1, Math.floor(n / 420));
    for (let i = 0; i < n; i += step) {
      const gx = (.5 + raw[i * 2] / pa) / 2 + (side ? .5 : 0);
      pts.push({ x: gx * A, y: raw[i * 2 + 1] + .5 });
    }
    if (pts.length < 40) for (let i = 0; i < 120; i++) {
      const a = i / 120 * 6.283;
      pts.push({ x: A * (side ? .75 : .25) + Math.cos(a) * .2, y: .5 + Math.sin(a) * .2 });
    }
    this.ribbon = pts.map((p, i) => ({ ...p, stagger: i / pts.length, spin: 1 + Math.random() * 2 }));
    this.seed = { x: A * .5, y: .54 };
  }

  // ---------- Hands ----------
  static KP = [0, 4, 5, 8, 9, 12, 16, 17, 20];

  map(l) {
    const v = this.video, c = this.R.cover(v.videoWidth || 16, v.videoHeight || 9, this.R.aspect);
    return { x: ((.5 - l[0]) / c.x + .5) * this.R.aspect, y: (.5 - l[1]) / c.y + .5 };
  }

  readHands() {
    const raw = (this.app.hands.raw || []).filter(h => h.score > .5);
    if (raw.length < 2) return null;
    const pick = h => Mist.Prize.KP.map(i => [h.lm[i].x, h.lm[i].y]);
    const a = pick(raw[0]), b = pick(raw[1]);
    return a[0][0] > b[0][0] ? [a, b] : [b, a];    // left on screen first (the mirror flips x)
  }

  smoothHands(dt) {
    if (!this.target) return;
    if (!this.kp) { this.kp = JSON.parse(JSON.stringify(this.target)); return; }
    const k = 1 - Math.exp(-dt * 24);
    for (let h = 0; h < 2; h++) for (let i = 0; i < this.kp[h].length; i++) for (let c = 0; c < 2; c++) {
      this.kp[h][i][c] += (this.target[h][i][c] - this.kp[h][i][c]) * k;
    }
  }

  buildBox() {
    if (!this.kp) return null;
    const P = this.kp.map(h => h.map(l => this.map(l)));
    const IDX = { wrist: 0, thumb: 1, k5: 2, index: 3, k9: 4, mid: 5, ring: 6, k17: 7, pinky: 8 };
    const anchor = h => {
      const t = h[IDX.thumb], i = h[IDX.index], k = h[IDX.k9];
      return { x: (t.x + i.x) * .275 + k.x * .45, y: (t.y + i.y) * .275 + k.y * .45 };
    };
    const Ca = anchor(P[0]), Cb = anchor(P[1]);
    let ax = Cb.x - Ca.x, ay = Cb.y - Ca.y;
    const len = Math.hypot(ax, ay) || 1e-3;
    ax /= len; ay /= len;
    const nx = -ay, ny = ax;
    const e = this.opened;
    const cap = (C, h, sign) => {
      const span = Math.max(Math.hypot(h[IDX.thumb].x - h[IDX.index].x, h[IDX.thumb].y - h[IDX.index].y),
        .6 * Math.hypot(h[IDX.wrist].x - h[IDX.k9].x, h[IDX.wrist].y - h[IDX.k9].y));
      const H = Math.max(.1, Math.min(.3, span * .95)) * e;
      let ux = h[IDX.k9].x - h[IDX.wrist].x, uy = h[IDX.k9].y - h[IDX.wrist].y;
      const m = Math.hypot(ux, uy) || 1; ux /= m; uy /= m;
      const flip = ux * nx + uy * ny < 0 ? -1 : 1;
      let e1x = ux * .55 + nx * flip * .8, e1y = uy * .55 + ny * flip * .8;
      const m1 = Math.hypot(e1x, e1y) || 1; e1x = e1x / m1 * H; e1y = e1y / m1 * H;
      const d = H * .48, e2x = (ax * .62 * sign + nx * .4) * d, e2y = (ay * .62 * sign + ny * .4) * d;
      return [
        { x: C.x + e1x + e2x, y: C.y + e1y + e2y }, { x: C.x + e1x - e2x, y: C.y + e1y - e2y },
        { x: C.x - e1x - e2x, y: C.y - e1y - e2y }, { x: C.x - e1x + e2x, y: C.y - e1y + e2y },
      ];
    };
    const ca = cap(Ca, P[0], 1), cb = cap(Cb, P[1], -1);
    return { Ca, Cb, ax, ay, nx, ny, len, ca, cb, P, angle: Math.atan2(ay, ax) };
  }

  static hull(points) {
    const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [], up = [];
    for (const q of p) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length > 1 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // ---------- Phases ----------
  go(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.ph = 0;
    this.ui.root.dataset.phase = phase;
    const { app, ui, mine } = this;
    if (mine) this.send({ t: 'pz', ph: phase });
    if (phase === 'gift') {
      this.say(mine ? '10 seconds' : 'They’ve earned 10 seconds', mine ? 'They start when you do. Raise both hands to open it.' : 'Waiting for them to open it');
      if (mine) setTimeout(() => { if (this.phase === 'gift') ui.skip.hidden = false; }, 15000);
      app.state.fadeTarget = .72;
    } else if (phase === 'open') {
      this.say('', '');
      ui.skip.hidden = true;
      app.sound.cue('open');
      app.state.fadeTarget = .58;
      this.burst(this.seed.x, this.seed.y, 90, .9);
      if (mine) this.startRecording();
    } else if (phase === 'play') {
      this.opened = 1;
    } else if (phase === 'shatter') {
      ui.num.textContent = '';
      app.sound.cue('shatter');
      app.state.fadeTarget = 1;
      this.makeShards();
    } else if (phase === 'keep') {
      if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
      ui.skip.hidden = true;
      app.hands.setNumHands(1);
      this.say('', '');
      app.state.fadeTarget = 1;
      this.showKeep();
    }
  }

  onRemote(m) {
    if (this.mine) return;
    if (m.ph) {
      // Their phases drive this screen, but the ceremony's opening always plays through.
      if (this.phase === 'lift' && m.ph !== 'gift' && m.ph !== 'lift') this.phase = 'gift';
      this.go(m.ph);
    }
    if (m.h) this.target = m.h;
    if (typeof m.life === 'number') this.life = m.life;
    if (typeof m.st === 'number' && m.st !== this.styleNext) { this.style = this.styleNext; this.styleNext = m.st; this.styleMix = 0; }
  }

  burst(x, y, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, s = speed * (.25 + Math.random() * .9);
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: .6 + Math.random() * .9, age: 0, z: 2 + Math.random() * 4 });
    }
  }

  update(dt) {
    this.T += dt;
    this.ph += dt;
    const { mine, app, ui } = this;

    if (mine) {
      const h = this.readHands();
      if (h) { this.target = h; this.handsUp += dt; } else this.handsUp = Math.max(0, this.handsUp - dt * 2);
    }
    this.smoothHands(dt);

    if (this.phase === 'lift' && this.ph > 2.8) this.go('gift');
    if (this.phase === 'gift' && mine && this.handsUp > .35 && this.ph > .4) this.go('open');
    if (this.phase === 'gift' && mine && this.ph > 45) this.go('keep');   // don't strand your rival

    if (this.phase === 'open') {
      const e = Math.min(1, this.ph / .85);
      this.opened = 1 - (1 - e) ** 3;
      if (e >= 1) { this.go('play'); this.life = 1; }
    }

    if (this.phase === 'play') {
      if (mine) this.life = Math.max(0, 1 - this.ph / 10);
      const left = this.life * 10;
      const shown = Math.ceil(left);
      if (ui.num.textContent !== String(shown)) ui.num.textContent = String(shown);
      ui.root.dataset.low = left < 3 ? '1' : '0';
      if (left < this.beatAt && left > 0) { app.sound.cue('beat'); this.beatAt -= 1; }

      this.styleClock += dt;
      if (mine && this.styleClock > 1.7) {
        this.styleClock = 0;
        this.style = this.styleNext;
        this.styleNext = (this.styleNext + 1) % Mist.prizeShaders.STYLES;
        this.styleMix = 0;
        app.sound.cue('style');
      }
      if (mine && this.ph >= 10) this.go('shatter');
    }
    if (this.styleMix < 1) this.styleMix = Math.min(1, this.styleMix + dt * 2.2);

    if (this.phase === 'shatter') {
      if (this.shards) for (const s of this.shards) {
        s.vy -= dt * .55; s.x += s.vx * dt; s.y += s.vy * dt; s.a += s.w * dt;
      }
      if (this.ph > 1.9) this.go('keep');
    }

    // Tell the spectator, about 30 times a second.
    if (mine && (this.phase === 'open' || this.phase === 'play')) {
      this.sendT = (this.sendT || 0) + dt;
      if (this.sendT > .033 && this.target) {
        this.sendT = 0;
        const round = this.target.map(h => h.map(l => [+l[0].toFixed(4), +l[1].toFixed(4)]));
        this.send({ t: 'pz', h: round, life: +this.life.toFixed(3), st: this.styleNext });
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt; s.vx *= Math.exp(-dt * 1.6); s.vy = s.vy * Math.exp(-dt * 1.6) - dt * .14;
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.age > s.life) this.sparks.splice(i, 1);
    }
  }

  // ---------- Drawing ----------
  draw() {
    const R = this.R, gl = this.gl;
    R.bind(null);
    gl.disable(gl.BLEND);
    const box = (this.phase === 'open' || this.phase === 'play') ? this.buildBox() : null;
    this.lastBox = box || this.lastBox;
    if (box) this.drawFill(box);
    if (this.phase === 'shatter') this.drawShards();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (box) this.drawEdges(box);
    this.drawPoints(box);
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  styleUniforms(P) {
    const gl = this.gl, R = this.R;
    gl.uniform1f(P.u.uAsp, R.aspect);
    gl.uniform1f(P.u.uT, this.T);
    gl.uniform1i(P.u.uA_, this.style);
    gl.uniform1i(P.u.uB_, this.styleNext);
    gl.uniform1f(P.u.uMix, this.styleMix);
    gl.uniform2f(P.u.uTx, 1 / R.sceneT.w, 1 / R.sceneT.h);
  }

  drawFill(b) {
    const gl = this.gl, R = this.R, { P, vao, buf } = this.gFill;
    const pts = b.ca.concat(b.cb);
    const hull = Mist.Prize.hull(pts);
    const cx = (b.Ca.x + b.Cb.x) / 2, cy = (b.Ca.y + b.Cb.y) / 2;
    const data = [];
    const v = (x, y) => data.push(x, y, x / R.aspect, y, 1);
    for (let i = 0; i < hull.length; i++) {
      const q = hull[(i + 1) % hull.length];
      v(cx, cy); v(hull[i].x, hull[i].y); v(q.x, q.y);
    }
    this.hullNow = hull;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, R.sceneT.tex);
    gl.uniform1i(P.u.uS, 0);
    this.styleUniforms(P);
    gl.uniform2f(P.u.uC, cx, cy);
    gl.uniform2f(P.u.uAx, b.ax, b.ay);
    gl.uniform1f(P.u.uLen, b.len);
    gl.uniform1f(P.u.uFade, 1);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 5);
  }

  makeShards() {
    const b = this.lastBox;
    this.shards = [];
    if (!b || !this.hullNow) return;
    const hull = this.hullNow, cx = (b.Ca.x + b.Cb.x) / 2, cy = (b.Ca.y + b.Cb.y) / 2;
    const rand = () => Math.random();
    const split = (t, depth) => {
      if (depth === 0) { this.addShard(t, cx, cy); return; }
      // Always cut the longest edge, so pieces stay chunky like real glass, not splinters.
      const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const edges = [[t[0], t[1], t[2]], [t[1], t[2], t[0]], [t[2], t[0], t[1]]].sort((a, b) => len(b[0], b[1]) - len(a[0], a[1]));
      const [p, q, r] = edges[0];
      const k = .35 + rand() * .3;
      const m = { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
      split([p, m, r], depth - 1); split([m, q, r], depth - 1);
    };
    for (let i = 0; i < hull.length; i++) split([{ x: cx, y: cy }, hull[i], hull[(i + 1) % hull.length]], 4);
    this.burst(cx, cy, 170, 1.2);
    const n = hull.length;
    for (let i = 0; i < 26; i++) { const h = hull[Math.floor(rand() * n)]; this.burst(h.x, h.y, 2, .7); }
  }

  addShard(t, cx, cy) {
    const mx = (t[0].x + t[1].x + t[2].x) / 3, my = (t[0].y + t[1].y + t[2].y) / 3;
    const ang = Math.atan2(my - cy, mx - cx), sp = .28 + Math.random() * .75;
    this.shards.push({
      x: 0, y: 0, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp + .18, a: 0, w: (Math.random() - .5) * 7, mx, my,
      pts: t.map(p => ({ dx: p.x - mx, dy: p.y - my, u: p.x / this.R.aspect, v: p.y })),
    });
  }

  drawShards() {
    if (!this.shards || !this.shards.length) return;
    const gl = this.gl, R = this.R, { P, vao, buf } = this.gFill;
    const fade = Math.max(0, 1 - this.ph / 1.5);
    const data = [];
    for (const s of this.shards) {
      const c = Math.cos(s.a), n = Math.sin(s.a);
      for (const p of s.pts) data.push(s.mx + s.x + p.dx * c - p.dy * n, s.my + s.y + p.dx * n + p.dy * c, p.u, p.v, fade);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, R.sceneT.tex);
    gl.uniform1i(P.u.uS, 0);
    this.styleUniforms(P);
    const b = this.lastBox;
    gl.uniform2f(P.u.uC, (b.Ca.x + b.Cb.x) / 2, (b.Ca.y + b.Cb.y) / 2);
    gl.uniform2f(P.u.uAx, b.ax, b.ay);
    gl.uniform1f(P.u.uLen, b.len);
    gl.uniform1f(P.u.uFade, 1);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 5);
    gl.disable(gl.BLEND);
  }

  drawEdges(b) {
    const gl = this.gl, R = this.R, { P, vao, buf } = this.gEdge;
    const data = [];
    const quad = (p, q, w, bright, t0, t1) => {
      const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1e-4;
      const nx = -dy / l * w, ny = dx / l * w;
      const V = (x, y, s, t) => data.push(x, y, s, t, bright);
      V(p.x + nx, p.y + ny, 1, t0); V(p.x - nx, p.y - ny, -1, t0); V(q.x + nx, q.y + ny, 1, t1);
      V(q.x + nx, q.y + ny, 1, t1); V(p.x - nx, p.y - ny, -1, t0); V(q.x - nx, q.y - ny, -1, t1);
    };
    const W = .017;
    for (let i = 0; i < 4; i++) {
      quad(b.ca[i], b.ca[(i + 1) % 4], W, i < 2 ? 1 : .55, 0, .1);
      quad(b.cb[i], b.cb[(i + 1) % 4], W, i < 2 ? 1 : .55, .9, 1);
      quad(b.ca[i], b.cb[i], W, i === 0 || i === 3 ? 1 : .5, 0, 1);
    }
    // Threads between matching fingertips, as the prism forms.
    if (this.opened < 1) {
      const a = 1 - this.opened;
      for (const k of [1, 3, 5, 6, 8]) quad(b.P[0][k], b.P[1][k], .006, a * 1.3, 0, 1);
    }
    gl.useProgram(P.p);
    gl.uniform1f(P.u.uAsp, R.aspect);
    gl.uniform1f(P.u.uT, this.T);
    gl.uniform1f(P.u.uLife, this.life);
    gl.uniform1f(P.u.uLow, this.life < .3 ? 1 : 0);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 5);
  }

  drawPoints(box) {
    const gl = this.gl, R = this.R, { P, vao, buf } = this.gPts;
    const data = [];
    const px = R.pxScale;
    const add = (x, y, z, r, g, b, a) => data.push(x, y, z * px, r, g, b, a);
    const ease = t => t * t * (3 - 2 * t);

    if (this.phase === 'lift') {
      const t = this.ph / 2.8;
      for (const p of this.ribbon) {
        const e = ease(Math.min(1, Math.max(0, (t - p.stagger * .45 - .1) / .5)));
        const a = (1 - e) * p.spin * 2.2;
        const c = Math.cos(a), s = Math.sin(a);
        const dx = p.x - this.seed.x, dy = p.y - this.seed.y;
        const x = this.seed.x + (dx * c - dy * s) * (1 - e), y = this.seed.y + (dx * s + dy * c) * (1 - e) + Math.sin(e * 3.14) * .05;
        add(x, y, 6.5, 1, .86 + e * .1, .68 + e * .25, .6 + e * .35);
      }
    }
    if (this.phase === 'lift' || this.phase === 'gift') {
      const grow = this.phase === 'lift' ? ease(Math.min(1, this.ph / 2.8)) : 1;
      const pulse = 1 + .13 * Math.sin(this.T * 2.6) + (this.phase === 'gift' && this.handsUp > 0 ? .4 : 0);
      add(this.seed.x, this.seed.y, 210 * grow * pulse, .95, .7, .5, .3);
      add(this.seed.x, this.seed.y, 90 * grow * pulse, 1, .9, .75, .85);
      add(this.seed.x, this.seed.y, 34 * grow * pulse, 1, 1, 1, 1);
      if (this.phase === 'gift') for (let i = 0; i < 18; i++) {
        const a = this.T * (.5 + i * .03) + i * 2.4, r = .1 + .035 * Math.sin(this.T + i);
        add(this.seed.x + Math.cos(a) * r, this.seed.y + Math.sin(a * 1.3) * r * .8, 5, 1, .9, .75, .8);
      }
    }
    // Every fingertip carries a light. Your hands are the instrument.
    if (box) for (const h of box.P) for (const k of [1, 3, 5, 6, 8]) {
      add(h[k].x, h[k].y, 17, .95, .7, 1, .55);
      add(h[k].x, h[k].y, 6, 1, 1, 1, 1);
    }
    for (const s of this.sparks) {
      const a = 1 - s.age / s.life;
      add(s.x, s.y, s.z * (.6 + a), 1, .86, .68 + a * .3, a);
    }
    if (!data.length) return;
    gl.useProgram(P.p);
    gl.uniform1f(P.u.uAsp, R.aspect);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, data.length / 7);
  }

  // ---------- Keepsake ----------
  startRecording() {
    try {
      const canvas = this.R.canvas;
      const stream = canvas.captureStream(30);
      const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
      this.recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6e6 });
      this.ext = type.includes('mp4') ? 'mp4' : 'webm';
      this.chunks = [];
      this.recorder.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type });
        stream.getTracks().forEach(t => t.stop());
        this.clipUrl = URL.createObjectURL(blob);
        this.ui.clip.src = this.clipUrl;
        this.ui.clip.play().catch(() => {});
        this.ui.clip.hidden = false;
        this.ui.save.hidden = false;
        this.ui.save.onclick = () => {
          const a = document.createElement('a');
          a.href = this.clipUrl;
          a.download = `my-10-seconds.${this.ext}`;
          a.click();
        };
      };
      this.recorder.start();
    } catch (e) { console.warn('Could not record the clip', e); }
  }

  showKeep() {
    const { ui, mine } = this;
    ui.root.dataset.phase = 'keep';
    ui.keep.hidden = false;
    ui.again.disabled = false;
    ui.again.textContent = 'Play again';
    ui.save.hidden = true;
    ui.clip.hidden = true;
    ui.keepTitle.textContent = mine ? 'Those 10 seconds were yours' : 'That was their 10 seconds';
    ui.keepSub.textContent = mine ? 'Nobody else will ever hold that exact moment. Take it with you.' : 'Win the next drawing and the prism is yours.';
  }
};

// ---------- Shaders ----------
// Original "other realities" for the inside of the prism, computed from the live camera image.
Mist.prizeShaders = {
  STYLES: 6,
  FILL_VS: `#version 300 es
in vec2 aP; in vec2 aUv; in float aA; out vec2 vUv; out float vA; out vec2 vP; uniform float uAsp;
void main(){ vUv=aUv; vA=aA; vP=aP; gl_Position=vec4(aP.x/uAsp*2.-1.,aP.y*2.-1.,0.,1.); }`,
  FILL_FS: `#version 300 es
precision highp float;
in vec2 vUv; in float vA; in vec2 vP; out vec4 o;
uniform sampler2D uS; uniform vec2 uTx,uC,uAx; uniform float uT,uMix,uLen,uAsp,uFade; uniform int uA_,uB_;

float lum(vec3 c){ return dot(c,vec3(.3,.59,.11)); }
vec3 hue(float h){ return .5+.5*cos(6.2832*(h+vec3(0.,.33,.67))); }
float edges(vec2 uv){
  vec2 t=uTx*1.2;
  float a=lum(texture(uS,uv+vec2(-t.x,t.y)).rgb), b=lum(texture(uS,uv+vec2(0.,t.y)).rgb), c=lum(texture(uS,uv+t).rgb);
  float d=lum(texture(uS,uv+vec2(-t.x,0.)).rgb), f=lum(texture(uS,uv+vec2(t.x,0.)).rgb);
  float g=lum(texture(uS,uv-t).rgb), h=lum(texture(uS,uv-vec2(0.,t.y)).rgb), i=lum(texture(uS,uv+vec2(t.x,-t.y)).rgb);
  float gx=a+2.*d+g-c-2.*f-i, gy=a+2.*b+c-g-2.*h-i;
  return sqrt(gx*gx+gy*gy);
}
vec3 style(int k, vec2 uv){
  vec3 c=texture(uS,uv).rgb;
  float l=lum(c), e=edges(uv);
  vec2 px=gl_FragCoord.xy;
  if(k==0){                 // living manga: ink lines and halftone on warm paper
    float a=.785, dots=sin((px.x*cos(a)-px.y*sin(a))*.42)*sin((px.x*sin(a)+px.y*cos(a))*.42);
    float tone=l<.2?0.:(l<.48?step(.05,dots+(l-.32)*2.2):(l<.72?step(-.55,dots+(l-.6)*1.6):1.));
    vec3 paper=mix(vec3(.05,.045,.06),vec3(.98,.95,.87),tone);
    return mix(paper,vec3(.03),smoothstep(.2,.48,e));
  }
  if(k==1){                 // cel: flat bold colour and clean outlines
    vec3 chroma=c/max(l,.04);
    float steps=floor(l*4.+.55)/4.;
    vec3 flat_=clamp(mix(vec3(lum(chroma)),chroma,1.55)*max(steps,.1),0.,1.);
    return mix(flat_*1.12,vec3(.04,.02,.09),smoothstep(.22,.5,e));
  }
  if(k==2){                 // neon: the world reduced to light
    vec3 glow=hue(uT*.17+uv.x*.9+uv.y*.4)*smoothstep(.1,.55,e)*2.1;
    return vec3(.02,.01,.06)+c*.1+glow;
  }
  if(k==3){                 // molten gold: an embossed metal statue of the room
    float n=lum(texture(uS,uv+uTx*1.5).rgb)-lum(texture(uS,uv-uTx*1.5).rgb);
    float m=clamp(l*.75+n*3.2+.14,0.,1.);
    return mix(vec3(.13,.06,.01),mix(vec3(.85,.53,.1),vec3(1.,.95,.72),m*m),smoothstep(0.,.72,m));
  }
  if(k==4){                 // heat: seeing warmth instead of light
    float t=clamp(l*1.15+.04*sin(uv.y*50.+uT*2.),0.,1.);
    vec3 r=t<.33?mix(vec3(.03,.0,.2),vec3(.55,.0,.6),t*3.):(t<.66?mix(vec3(.55,.0,.6),vec3(1.,.42,.05),(t-.33)*3.):mix(vec3(1.,.42,.05),vec3(1.,.97,.62),(t-.66)*3.));
    return r;
  }
  // hologram: a projection of you in cold light
  float scan=.72+.28*sin(px.y*.9-uT*14.);
  vec3 split=vec3(lum(texture(uS,uv+vec2(.004,0.)).rgb),l,lum(texture(uS,uv-vec2(.004,0.)).rgb));
  return (split*vec3(.25,.85,1.05)+vec3(.1,.55,.75)*smoothstep(.15,.5,e)*1.6)*scan+vec3(.0,.03,.06);
}
void main(){
  // Light bends a little entering the glass.
  vec2 c=vec2(uC.x/uAsp,uC.y);
  vec2 uv=c+(vUv-c)*.92;
  // The next reality sweeps along the prism, end to end.
  float d=dot(vP-uC,uAx)/max(uLen,.001)+.5;
  float m=smoothstep(uMix*1.3-.15-.05,uMix*1.3-.15+.05,d);
  vec3 col=mix(style(uB_,uv),style(uA_,uv),m);
  float front=exp(-pow((d-(uMix*1.3-.15))*14.,2.))*(uMix<1.?1.:0.);
  col+=vec3(1.,.95,.9)*front*.85;
  // Glass: a faint sheen and a diagonal glint.
  float glint=exp(-pow(fract(d*1.4+dot(vP,uAx.yx)*1.1-uT*.09)-.5,2.)*90.);
  col+=vec3(.9,.95,1.)*glint*.1;
  o=vec4(col,vA*uFade);
}`,
  EDGE_VS: `#version 300 es
in vec2 aP; in float aS; in float aT; in float aB; out float vS; out float vT; out float vB; uniform float uAsp;
void main(){ vS=aS; vT=aT; vB=aB; gl_Position=vec4(aP.x/uAsp*2.-1.,aP.y*2.-1.,0.,1.); }`,
  EDGE_FS: `#version 300 es
precision highp float;
in float vS; in float vT; in float vB; out vec4 o; uniform float uT,uLife,uLow;
void main(){
  float d=abs(vS);
  float core=smoothstep(.17,.05,d), glow=exp(-d*d*7.)*.42;
  // The edges are the clock: light burns away from one end like a fuse.
  float lit=smoothstep(uLife+.012,uLife-.012,vT);
  float ember=exp(-pow((vT-uLife)*22.,2.))*2.2;
  float pulse=1.+uLow*.55*sin(uT*17.);
  vec3 tint=mix(vec3(1.,.42,.74),vec3(.58,.7,1.),.5+.5*sin(uT*.9+vT*3.));
  vec3 col=(vec3(1.)*core+tint*glow)*(lit*.95+.09)*pulse+vec3(1.,.72,.42)*ember*(core+glow);
  o=vec4(col*vB,1.);
}`,
  PT_VS: `#version 300 es
in vec2 aP; in float aZ; in vec4 aC; out vec4 vC; uniform float uAsp;
void main(){ vC=aC; gl_PointSize=aZ; gl_Position=vec4(aP.x/uAsp*2.-1.,aP.y*2.-1.,0.,1.); }`,
  PT_FS: `#version 300 es
precision highp float;
in vec4 vC; out vec4 o;
void main(){ float d=length(gl_PointCoord*2.-1.); float a=exp(-d*d*3.6)*(1.-smoothstep(.85,1.,d)); o=vec4(vC.rgb*vC.a*a,1.); }`,
};
