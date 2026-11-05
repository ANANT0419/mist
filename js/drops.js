// CPU droplet physics. Cheap: a few hundred points, drawn as GL point sprites.
window.Mist = window.Mist || {};

Mist.Drops = class {
  constructor() {
    this.max = 280;
    this.list = [];
    this.water = 0;
    this.sprites = new Float32Array(this.max * 4);
    this.carves = new Float32Array(1600 * 4);
    this.carveN = 0;
    this.count = 0;
  }

  clear() { this.list.length = 0; }

  spawn(x, y, r) {
    if (this.list.length >= this.max) {
      let idx = -1, smallest = 1e9;
      for (let i = 0; i < this.list.length; i++) {
        const d = this.list[i];
        if (!d.moving && d.r < smallest) { smallest = d.r; idx = i; }
      }
      if (idx < 0) return;
      this.list.splice(idx, 1);
    }
    this.list.push({
      x, y, r, vy: 0, moving: false,
      factor: 1, nextChange: 0, wiggle: Math.random() * 6.28,
      life: 18 + Math.random() * 30, lastX: x, lastY: y,
    });
  }

  // Wiping pushes water to the sides of the stroke; some of it beads up there.
  feed(ax, ay, bx, by, R, kind, aspect) {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    this.water += len * R * (kind ? 42 : 170);
    while (this.water > 1) {
      this.water -= 1;
      const t = Math.random(), side = Math.random() < .5 ? -1 : 1;
      const nx = len > 1e-6 ? -dy / len : 1, ny = len > 1e-6 ? dx / len : 0;
      const out = R * (1 + Math.random() * .22) * side;
      const big = Math.random() < (kind ? .3 : .16);
      const r = big ? 4.2 + Math.random() * 2.8 : 1.9 + Math.random() * 1.2;
      this.spawn((ax + dx * t + nx * out) / aspect, ay + dy * t + ny * out, r);
    }
  }

  // Lifting a finger leaves a small pool at the end of the stroke.
  pool(x, y, R, kind) {
    const n = kind ? 2 : (Math.random() < .35 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      this.spawn(x + (Math.random() - .5) * R, y - R * (.3 + Math.random() * .7),
        (kind ? 4.5 : 2.6) + Math.random() * (kind ? 3 : 1.6));
    }
  }

  update(dt, aspect, cssH, pxScale, fieldScale) {
    const crit = 4.8;
    const L = this.list;
    this.carveN = 0;

    for (let i = L.length - 1; i >= 0; i--) {
      const d = L[i];
      d.lastX = d.x; d.lastY = d.y;

      if (d.r > crit) {
        d.moving = true;
        d.nextChange -= dt;
        if (d.nextChange <= 0) {
          const roll = Math.random();
          d.factor = roll < .22 ? 0 : .35 + Math.random() * 1.15;  // stick-slip
          d.nextChange = .18 + Math.random() * .85;
        }
        const target = (d.r - crit + 1.4) * .021 * d.factor;
        d.vy += (target - d.vy) * Math.min(1, dt * 7);
        const dist = d.vy * dt;
        d.y -= dist;
        d.wiggle += dt * (1.2 + d.r * .15);
        d.x += Math.sin(d.wiggle) * dist * .17 / aspect;
        d.r -= dist * 2.4;
        if (Math.random() < dist * 9) {
          this.spawn(d.x, d.y + (d.r * 1.1) / cssH, 1.6 + Math.random() * .9);
        }
      } else {
        d.moving = false;
        d.vy = 0;
        d.life -= dt;
        if (d.life < 3) d.r -= dt * .5;
      }

      if (d.y < -.03 || d.r < .55) { L.splice(i, 1); continue; }
    }

    // Moving drops swallow what they touch.
    const invH = 1 / cssH;
    for (let i = L.length - 1; i >= 0; i--) {
      const a = L[i];
      if (!a || !a.moving) continue;
      for (let j = L.length - 1; j >= 0; j--) {
        if (j === i) continue;
        const b = L[j];
        const dy = (a.y - b.y), dx = (a.x - b.x) * aspect;
        const reach = (a.r + b.r) * invH * .85;
        if (dx * dx + dy * dy < reach * reach) {
          a.r = Math.min(Math.cbrt(a.r ** 3 + b.r ** 3), 11);
          L.splice(j, 1);
          if (j < i) i--;
        }
      }
    }

    // Build GPU buffers.
    this.count = L.length;
    const S = this.sprites, C = this.carves, maxC = C.length / 4;
    let n = 0;
    for (let i = 0; i < L.length; i++) {
      const d = L[i];
      const stretch = d.moving ? Math.min(d.vy * 11, 1.05) : 0;
      const size = d.r * 2 * pxScale * (1 + stretch);
      S[i * 4] = d.x; S[i * 4 + 1] = d.y; S[i * 4 + 2] = size; S[i * 4 + 3] = stretch;

      // Carve a clear trail through the fog, interpolated so fast drops leave no gaps.
      const stepLen = Math.max(.0012, d.r * invH * .4);
      const seg = Math.hypot((d.x - d.lastX) * aspect, d.y - d.lastY);
      const steps = Math.min(8, Math.max(1, Math.ceil(seg / stepLen)));
      for (let k = 0; k < steps && n < maxC; k++) {
        const t = (k + 1) / steps;
        C[n * 4] = d.lastX + (d.x - d.lastX) * t;
        C[n * 4 + 1] = d.lastY + (d.y - d.lastY) * t;
        C[n * 4 + 2] = Math.max(2, d.r * 1.35 * fieldScale);
        C[n * 4 + 3] = 0;
        n++;
      }
    }
    this.carveN = n;
  }
};
