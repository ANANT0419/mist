// Plays a whole match with a simulated camera, for testing. In the browser console on the game page:
//   await (await import('./tests/match-harness.js')).run({ playMs: 9000, quality: .85 })
// Real game logic and rendering; only the camera and the player's body are stand-ins.
export function fakeCamera() {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  const draw = () => {
    const t = performance.now() / 1000;
    const gr = g.createLinearGradient(0, 0, 1280, 720);
    gr.addColorStop(0, '#d9c8e8'); gr.addColorStop(.55, '#a79cd0'); gr.addColorStop(1, '#5f5a8c');
    g.fillStyle = gr; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#3d3454'; for (let i = 0; i < 5; i++) g.fillRect(80 + i * 240, 70, 120, 170);
    g.fillStyle = '#f7e7c4'; for (let i = 0; i < 5; i++) g.fillRect(96 + i * 240, 88, 88, 134);
    const x = 640 + Math.sin(t * .8) * 26;
    g.fillStyle = '#17141f'; g.beginPath(); g.ellipse(x, 800, 340, 340, 0, 0, 7); g.fill();
    g.fillStyle = '#d9a085'; g.beginPath(); g.ellipse(x, 350, 118, 150, 0, 0, 7); g.fill();
    g.fillStyle = '#231a1e'; g.beginPath(); g.ellipse(x, 240, 132, 96, 0, 0, 7); g.fill();
    g.fillStyle = '#231a1e'; g.beginPath(); g.ellipse(x - 44, 350, 20, 12, 0, 0, 7); g.ellipse(x + 44, 350, 20, 12, 0, 0, 7); g.fill();
    g.strokeStyle = '#8a4a43'; g.lineWidth = 7; g.beginPath(); g.arc(x, 420, 30, .2, 2.9); g.stroke();
  };
  draw();
  setInterval(draw, 40);
  return c.captureStream(25);
}

// A hand posed at (cx, cy) in camera coordinates, fingers spread and held up.
export function fakeHand(cx, cy, roll, size = .11) {
  const lm = [];
  const put = (i, dx, dy) => {
    const c = Math.cos(roll), s = Math.sin(roll);
    lm[i] = { x: cx + (dx * c - dy * s) * size * 9 / 16, y: cy + (dx * s + dy * c) * size, z: 0 };
  };
  put(0, 0, 1);
  [[1, -.5, .7], [2, -.8, .4], [3, -1, .1], [4, -1.15, -.2]].forEach(([i, x, y]) => put(i, x, y));
  [[5, -.35], [9, -.1], [13, .15], [17, .4]].forEach(([b, x], f) => {
    put(b, x, 0); put(b + 1, x * 1.05, -.45); put(b + 2, x * 1.1, -.8); put(b + 3, x * 1.15, -1.15 + f * .06);
  });
  return { lm, world: lm, score: 1 };
}

export async function run({ playMs = 9000, skill = .6, myAccuracy = .006 } = {}) {
  const a = window.Mist.app;
  navigator.mediaDevices.getUserMedia = async () => fakeCamera();
  const state = window.__h = { log: [], phase: '', playing: true };
  const L = n => state.log.push(`${Math.round(performance.now())} ${n}`);
  document.getElementById('land-find').click();
  // Don't wait for the lobby: go straight to the practice rival.
  while (!a.state.handsOn) await new Promise(r => setTimeout(r, 100));
  L('trackers ready');
  a.hands.ingest = () => {};
  await a.playGhost(skill);
  const m = a.match;
  m.playMs = playMs;
  L('match begun');

  // Keep frames coming even if the browser pane is paused, and act as the player.
  let last = performance.now();
  const driver = setInterval(() => {
    a.step(1);
    const p = m.prize ? 'prize:' + m.prize.phase : m.phase;
    if (p !== state.phase) { state.phase = p; L(p); }
    if (m.prize && m.prize.mine && m.prize.phase !== 'lift') {
      const t = performance.now() / 1000;
      const ang = Math.sin(t * .7) * .55;
      const cy = .5, dx = .26, ax = Math.cos(ang) * dx, ay = Math.sin(ang) * dx * 16 / 9;
      if (m.prize.phase !== 'keep') a.hands.raw = [fakeHand(.5 - ax, cy - ay, ang * .4 - .25), fakeHand(.5 + ax, cy + ay, ang * .4 + .25)];
    }
  }, 16);
  state.stop = () => clearInterval(driver);

  // Player: blow, then trace with a steady hand.
  const wait = () => new Promise(r => { const i = setInterval(() => { if (m.phase === 'play') { clearInterval(i); r(); } }, 40); });
  await wait();
  L('player blowing');
  a.state.forceBreath = 1;
  await new Promise(r => setTimeout(r, 2200));
  a.state.forceBreath = 0;
  const pts = Mist.Designs.sample(m.design, 300);
  const S = Mist.Designs.scale(m.paneAspect), pa = m.paneAspect;
  const toG = ([x, y]) => [(.5 + x * S / pa) / 2, .5 + y * S];
  const wob = () => (Math.random() - .5) * myAccuracy * 2;
  let dx = 0, dy = 0;
  const remain = Math.max(1500, playMs - 2600);
  const stepMs = remain / pts.length;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = toG(pts[i]), [bx, by] = toG(pts[i + 1]);
    if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) < .08) {
      dx += (wob() - dx) * .2; dy += (wob() - dy) * .2;
      a.addStroke(ax + dx, ay + dy, bx + dx, by + dy, 0, .3);
    }
    if (i % 4 === 0) await new Promise(r => setTimeout(r, stepMs * 4));
    if (m.phase !== 'play') break;
  }
  L('player done');
  return state;
}

// Jump straight to the prize, with time stepped by hand, so any moment can be inspected.
export async function prizeBench() {
  const a = window.Mist.app;
  navigator.mediaDevices.getUserMedia = async () => fakeCamera();
  document.getElementById('land-find').click();
  while (!a.state.handsOn) await new Promise(r => setTimeout(r, 100));
  a.hands.ingest = () => {};
  await a.playGhost(.5);
  const m = a.match;
  m.seq++;                       // stop the round's clock
  m.design = 1;
  const pts = Mist.Designs.sample(1, 300), S = Mist.Designs.scale(m.paneAspect);
  m.mine = pts.flatMap(p => [p[0] * S, p[1] * S]);
  m.startPrize(true, false);
  const style = document.createElement('style');
  style.textContent = '*{animation:none!important;transition:none!important}';
  document.head.appendChild(style);
  const pose = (t, spread = .27, tilt = .45) => {
    const ang = Math.sin(t * .7) * tilt, ax = Math.cos(ang) * spread, ay = Math.sin(ang) * spread * 16 / 9;
    a.hands.raw = [fakeHand(.5 - ax, .52 - ay, ang * .4 - .25), fakeHand(.5 + ax, .52 + ay, ang * .4 + .25)];
  };
  const bench = { a, m, t: 0, pose,
    go(sec, hands = true) { const n = Math.round(sec * 60); for (let i = 0; i < n; i++) { this.t += 1 / 60; if (hands) pose(this.t); else a.hands.raw = []; a.step(1); }
      return { phase: m.prize.phase, ph: +m.prize.ph.toFixed(2), life: +m.prize.life.toFixed(2), style: m.prize.style, next: m.prize.styleNext, num: document.getElementById('prize-num').textContent, err: a.R.gl.getError() }; } };
  window.__b = bench;
  return bench;
}

// Two real players: run this in two tabs with the same room to test real matchmaking.
export async function realPlayer(room, { playMs = 7000 } = {}) {
  const a = window.Mist.app;
  history.replaceState(null, '', `?room=${room}`);
  navigator.mediaDevices.getUserMedia = async () => fakeCamera();
  const log = window.__real = { room, events: [] };
  const L = e => log.events.push(e);
  document.getElementById('land-find').click();
  const t0 = performance.now();
  while (!a.match && performance.now() - t0 < 30000) await new Promise(r => setTimeout(r, 100));
  if (!a.match) { L('no match'); return log; }
  const m = a.match;
  L(m.net.isHost ? 'matched as host' : 'matched as guest');
  m.playMs = playMs;
  a.hands.ingest = () => {};
  const orig = m.applyPhase.bind(m);
  m.applyPhase = p => { L('phase ' + p.p); orig(p); };
  const origResult = m.showResult.bind(m);
  m.showResult = (x, y) => { L(`result me=${x} rival=${y}`); log.result = [x, y]; origResult(x, y); };
  const driver = setInterval(() => { a.step(1); }, 33);
  log.stop = () => clearInterval(driver);
  return log;
}
