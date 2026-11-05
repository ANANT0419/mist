// Run by opening tests/gesture.html. Results land on the page and in window.results.
// A virtual hand built by forward kinematics, so every pose has a known true answer.
const deg = d => d * Math.PI / 180;
let seed = 12345;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = s => s * Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(6.2832 * rnd());

// pose: per finger [mcp, pip, dip] bends in degrees, index, middle, ring, pinky.
function makeHand(pose, rot = [0, 0, 0], opts = {}) {
  const pts = new Array(21);
  const palmLen = .09, base = [[-.03, palmLen], [-.01, palmLen * 1.03], [.01, palmLen], [.03, palmLen * .92]];
  const lens = [[.042, .026, .021], [.046, .03, .022], [.043, .028, .022], [.034, .02, .019]];
  pts[0] = { x: 0, y: 0, z: 0 };
  for (let i = 1; i <= 4; i++) pts[i] = { x: -.04 - i * .012, y: i * .022, z: 0 };
  pose.forEach((f, i) => {
    let [x, y] = base[i], z = 0, ang = 0;
    const j = 5 + i * 4;
    pts[j] = { x, y, z };
    for (let k = 0; k < 3; k++) {
      ang += deg(f[k]);           // bending curls the finger toward the palm (-z)
      y += lens[i][k] * Math.cos(ang);
      z += -lens[i][k] * Math.sin(ang);
      pts[j + k + 1] = { x, y, z };
    }
  });
  const [ax, ay, az] = rot.map(deg);
  const squash = opts.squashZ ?? 1;
  return pts.map(p => {
    let { x, y, z } = p;
    [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
    [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
    [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
    const n = opts.noise ?? 0;
    return { x: x + gauss(n), y: y + gauss(n), z: z * squash + gauss(n * 2) };
  });
}

const STRAIGHT = [8, 8, 4], CURLED = [70, 100, 60];
const POSES = {
  point: [STRAIGHT, CURLED, CURLED, CURLED],
  pointRelaxed: [[15, 18, 10], [45, 55, 28], [60, 80, 45], [65, 90, 50]],
  fist: [CURLED, CURLED, CURLED, CURLED],
  fistLoose: [[55, 78, 38], [60, 82, 40], [60, 85, 42], [60, 85, 45]],
  open: [STRAIGHT, STRAIGHT, STRAIGHT, STRAIGHT],
  openSoft: [[15, 20, 10], [15, 22, 10], [18, 25, 12], [20, 28, 14]],
  peace: [STRAIGHT, STRAIGHT, CURLED, CURLED],
};
const lerpPose = (a, b, t) => a.map((f, i) => f.map((v, k) => v + (b[i][k] - v) * t));

// Every direction a hand might face, including aimed straight at the camera.
const ROTS = [];
for (const ax of [-85, -60, -30, 0, 30, 60, 85]) for (const ay of [-60, -25, 0, 25, 60]) for (const az of [-40, 0, 40]) ROTS.push([ax, ay, az]);
const VIEWS = [{ noise: .001 }, { noise: .003 }, { noise: .002, squashZ: .45 }];

function run(seq, dt = 33) {
  const m = new Mist.Gesture.Machine();
  const trace = [];
  for (const w of seq) { m.update(w, dt); trace.push({ state: m.state, touching: m.touching }); }
  return trace;
}
const hold = (pose, rot, opt, ms, dt = 33) => Array.from({ length: Math.round(ms / dt) }, () => makeHand(pose, rot, opt));

const results = [];
function test(name, fn) {
  let pass = 0, total = 0, firstFail = null; const by = {};
  fn((ok, info) => { total++; if (ok) pass++; else {
    if (!firstFail) firstFail = info;
    const key = [info.pose, info.v && (info.v.squashZ ? 'squashed' : 'noise' + info.v.noise), info.r && 'pitch' + info.r[0]].filter(Boolean).join(' ');
    by[key] = (by[key] || 0) + 1; } });
  results.push({ name, pass, total, ok: pass === total, firstFail, by });
}

test('Pointing never becomes a fist, from any angle (3s hold)', t => {
  for (const pose of ['point', 'pointRelaxed']) for (const r of ROTS) for (const v of VIEWS) {
    const tr = run(hold(POSES[pose], r, v, 3000));
    t(!tr.some(x => x.state === 'fist'), { pose, r, v });
  }
});
test('Pointing is recognised as drawing within 300ms', t => {
  for (const pose of ['point', 'pointRelaxed']) for (const r of ROTS) for (const v of VIEWS) {
    const tr = run(hold(POSES[pose], r, v, 300));
    t(tr.at(-1).state === 'finger', { pose, r, v, got: tr.at(-1).state });
  }
});
test('A true fist registers within 400ms', t => {
  for (const pose of ['fist', 'fistLoose']) for (const r of ROTS) for (const v of VIEWS) {
    const tr = run(hold(POSES[pose], r, v, 400));
    t(tr.at(-1).state === 'fist', { pose, r, v, got: tr.at(-1).state });
  }
});
test('A true fist never draws a line', t => {
  for (const r of ROTS) for (const v of VIEWS) {
    const tr = run(hold(POSES.fist, r, v, 1500));
    t(!tr.some(x => x.state === 'finger'), { r, v });
  }
});
test('An open hand never touches the glass', t => {
  for (const pose of ['open', 'openSoft', 'peace']) for (const r of ROTS) for (const v of VIEWS) {
    const tr = run(hold(POSES[pose], r, v, 1500));
    t(!tr.some(x => x.touching), { pose, r, v });
  }
});
test('Drawing survives a 130ms glitch where the tracker sees a fist', t => {
  for (const r of ROTS) {
    const v = { noise: .002 };
    const seq = [...hold(POSES.point, r, v, 500), ...hold(POSES.fist, r, v, 130), ...hold(POSES.point, r, v, 500)];
    const tr = run(seq);
    t(!tr.some(x => x.state === 'fist'), { r });
  }
});
test('Closing a finger into a fist goes finger, lifted, then fist, with no fist rub early', t => {
  for (const r of ROTS) {
    const v = { noise: .0015 };
    const closing = Array.from({ length: 9 }, (_, i) => makeHand(lerpPose(POSES.point, POSES.fist, (i + 1) / 9), r, v));
    const seq = [...hold(POSES.point, r, v, 500), ...closing, ...hold(POSES.fist, r, v, 700)];
    const tr = run(seq);
    const firstFist = tr.findIndex(x => x.state === 'fist');
    const start = Math.round(500 / 33);
    t(firstFist > start + 4 && tr.at(-1).state === 'fist', { r, firstFist, start });
  }
});
test('The pen lifts before the index finger has travelled far while closing', t => {
  for (const r of ROTS) {
    const v = { noise: .0015 };
    const closing = Array.from({ length: 9 }, (_, i) => makeHand(lerpPose(POSES.point, POSES.fist, (i + 1) / 9), r, v));
    const start = Math.round(500 / 33);
    const tr = run([...hold(POSES.point, r, v, 500), ...closing]);
    const firstOff = tr.findIndex((x, i) => i >= start && !x.touching);
    t(firstOff !== -1 && firstOff - start <= 7, { r, frames: firstOff - start });
  }
});
test('Opening a fist back to pointing resumes drawing quickly', t => {
  for (const r of ROTS) {
    const v = { noise: .0015 };
    const tr = run([...hold(POSES.fist, r, v, 600), ...hold(POSES.point, r, v, 300)]);
    t(tr.at(-1).state === 'finger' && tr.at(-1).touching, { r, got: tr.at(-1) });
  }
});

// ---------- Filter and pen ----------
test('One Euro filter removes jitter when still, with little lag when fast', t => {
  const fx = new Mist.OneEuro(1.5, 7, 1.2);
  let dev = 0, n = 0;
  for (let i = 0; i < 90; i++) { const o = fx.filter(.5 + gauss(.002), 1 / 30); if (i > 30) { dev += Math.abs(o - .5); n++; } }
  t(dev / n < .0012, { stillError: dev / n });
  const fy = new Mist.OneEuro(1.5, 7, 1.2);
  let lag = 0;
  for (let i = 0; i < 30; i++) { const v = i / 30 * 2; lag = v - fy.filter(v, 1 / 30); }
  t(lag < .035, { lagAt2HeightsPerSec: lag });
});
test('Pen curve stays on the true path and has no corners', t => {
  // A circle sampled at 30Hz, drawn as polygon vs. through the pen.
  const pen = new Mist.Pen();
  const R = .2, omega = 6;            // about 1.2 screen heights per second
  const pts = [];
  const emit = (ax, ay, bx, by) => pts.push([bx, by]);
  let T = 0;
  pen.begin(R, 0, 0);
  for (let i = 1; i <= 40; i++) {
    const tm = i * 33;
    pen.add(R * Math.cos(omega * tm / 1000), R * Math.sin(omega * tm / 1000), tm);
    for (let f = 0; f < 2; f++) { T = tm + f * 16.5; pen.advance(T - 34, emit); }
  }
  pen.end(emit);
  // The very first and last segments have no neighbour to curve toward, so they are judged separately.
  const seg = Math.round(pts.length / 40);
  let maxErr = 0, maxTurn = 0, endErr = 0;
  for (let i = 2; i < pts.length - 2; i++) {
    const err = Math.abs(Math.hypot(...pts[i]) - R);
    if (i < seg * 2 || i > pts.length - seg * 2) { endErr = Math.max(endErr, err); continue; }
    maxErr = Math.max(maxErr, err);
    const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
    let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d;
    maxTurn = Math.max(maxTurn, d);
  }
  const chord = omega * .033;  // polygon's corner angle for comparison
  window.penStats = { maxErr, endErr, maxTurnDeg: maxTurn * 57.3, polygonCornerDeg: chord * 57.3, polygonSagitta: R * (1 - Math.cos(chord / 2)) };
  t(maxErr < .0002, window.penStats);
  t(endErr < .0015, window.penStats);
  t(maxTurn < chord * .25, window.penStats);
});
test('Pen plays back evenly: no gaps, every frame advances', t => {
  const pen = new Mist.Pen();
  let frames = 0, empty = 0;
  pen.begin(0, 0, 0);
  pen.advance(-1, () => {});
  let next = 33, x = 0;
  for (let tm = 16.5; tm < 1000; tm += 16.5) {
    if (tm >= next) { x += .02; pen.add(x, 0, next); next += 33; }
    let got = 0;
    if (tm > 100) { pen.advance(tm - 34, () => got++); frames++; if (!got) empty++; }
  }
  t(empty / frames < .05, { empty, frames });
});
test('Holding still does not pile up points', t => {
  const pen = new Mist.Pen();
  pen.begin(.5, .5, 0);
  for (let i = 1; i < 300; i++) pen.add(.5 + gauss(.0002), .5 + gauss(.0002), i * 33);
  t(pen.pts.length < 6, { pts: pen.pts.length });
});

// ---------- Blow face ----------
const face = o => ({ pucker: 0, funnel: 0, puff: 0, jaw: 0, smile: 0, ...o });
const runBlow = (seq, ms) => { const d = new Mist.BlowDetector(); let peak = 0; const n = Math.round(ms / 33); for (let i = 0; i < n; i++) { const f = typeof seq === 'function' ? seq(i, n) : seq; peak = Math.max(peak, d.update(f, .033)); } return { peak, end: d.strength }; };
test('A blowing face fogs the glass', t => {
  t(runBlow(i => i < 10 ? face({ pucker: .05 }) : face({ pucker: .75, funnel: .3 }), 1200).peak > .8, 'pucker');
  t(runBlow(i => i < 10 ? face({}) : face({ funnel: .6, jaw: .2 }), 1200).peak > .6, 'funnel');
  t(runBlow(i => i < 10 ? face({}) : face({ pucker: .4, puff: .6 }), 1200).peak > .7, 'puffed');
});
test('Everyday faces do not fog it', t => {
  t(runBlow(face({ pucker: .12, funnel: .1 }), 3000).peak < .05, 'resting');
  t(runBlow(face({ smile: .9 }), 3000).peak < .05, 'smile');
  t(runBlow(i => face({ jaw: .9, funnel: .55 }), 3000).peak < .1, 'yawn or open mouth');
  t(runBlow(i => face({ jaw: .35 * Math.abs(Math.sin(i * .4)), funnel: .22 * Math.abs(Math.sin(i * .4)) }), 4000).peak < .15, 'talking');
  t(runBlow(i => i % 40 === 0 ? face({ pucker: .8 }) : face({}), 3000).peak < .1, 'a flicker');
  t(runBlow(null, 2000).peak === 0, 'no face');
});
test('A naturally pursed resting mouth still has to blow on purpose', t => {
  t(runBlow(face({ pucker: .28 }), 4000).peak < .1, 'rests pursed');
  t(runBlow(i => i < 60 ? face({ pucker: .28 }) : face({ pucker: .85 }), 3500).peak > .6, 'then blows');
});
test('Blowing stops when you stop', t => {
  t(runBlow(i => i < 40 ? face({ pucker: .8 }) : face({}), 3000).end < .03, 'stops');
});

// ---------- Judging a drawing ----------
const judge = paint => {
  const w = 150, h = 180, g = new Float32Array(w * h).fill(1);
  const clearAt = (x, y, r) => { for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) if ((i - x) ** 2 + (j - y) ** 2 <= r * r) g[j * w + i] = 0; };
  const pa = .8, S = .72;
  paint({ g, w, h, clearAt, toCell: (dx, dy) => [Math.round((.5 + dx * S / pa) * w), Math.round((.5 + dy * S) * h)] });
  return { g, w, h, pa };
};
const designPts = i => Mist.Designs.sample(i);
const scoreOf = (i, paint) => { const j = judge(paint); return Mist.Designs.score(j, 0, j.w, designPts(i), j.pa, { scale: .72 }).score; };
test('The judge rewards the better drawing, for every design', t => {
  for (let i = 0; i < Mist.Designs.LIST.length; i++) {
    const pts = designPts(i);
    const line = (c, map = p => p) => { for (const p of pts) { const q = map(p); const [x, y] = c.toCell(q[0], q[1]); c.clearAt(x, y, 2); } };
    const perfect = scoreOf(i, c => line(c));
    const steady = scoreOf(i, c => line(c, p => [p[0] + Math.sin(p[1] * 30) * .008, p[1] + Math.cos(p[0] * 30) * .008]));
    const shaky = scoreOf(i, c => line(c, p => [p[0] + Math.sin(p[1] * 40) * .04, p[1] + Math.cos(p[0] * 40) * .04]));
    const half = scoreOf(i, c => { pts.slice(0, pts.length >> 1).forEach(p => { const [x, y] = c.toCell(p[0], p[1]); c.clearAt(x, y, 2); }); });
    const scribble = scoreOf(i, c => { for (let k = 0; k < 1400; k++) { c.clearAt(Math.round(c.w / 2 + Math.sin(k * .05) * 58), Math.round(c.h / 2 + Math.cos(k * .071) * 62), 2); } });
    const wiped = scoreOf(i, c => { for (let y = 40; y < 140; y += 4) for (let x = 20; x < 130; x += 4) c.clearAt(x, y, 4); });
    const noBlow = (() => { const j = judge(() => {}); j.g.fill(0); return Mist.Designs.score(j, 0, j.w, pts, j.pa, { scale: .72 }).score; })();
    const blank = scoreOf(i, () => {});
    const info = { design: Mist.Designs.LIST[i].name, perfect, steady, shaky, half, scribble, wiped, noBlow, blank };
    (window.scoreTable = window.scoreTable || []).push(info);
    t(perfect >= 90, info);
    t(perfect >= steady && steady > shaky, info);
    t(steady > half && steady > scribble && steady > wiped, info);
    t(noBlow < 35 && blank === 0, info);
  }
});

window.results = results;
const bad = results.filter(r => !r.ok);
document.getElementById('out').textContent = results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.pass}/${r.total}  ${r.name}${r.firstFail ? '\n      where: ' + JSON.stringify(r.by) : ''}`).join('\n') + `\n\n${bad.length ? bad.length + ' FAILED' : 'ALL PASSED'}`;
