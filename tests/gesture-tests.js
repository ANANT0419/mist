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
// Readings arrive about 30 times a second.
const blow = (seq, ms) => { const d = new Mist.BlowDetector(); const out = []; const n = Math.round(ms / 33);
  for (let i = 0; i < n; i++) out.push(d.update(typeof seq === 'function' ? seq(i, n) : seq, .033)); return out; };
const firstAbove = (arr, v) => { const i = arr.findIndex(x => x > v); return i < 0 ? Infinity : i * 33; };
test('Rounding the lips fogs the glass within a tenth of a second', t => {
  for (const shape of [{ pucker: .5 }, { pucker: .75, funnel: .3 }, { funnel: .45 }, { funnel: .5, jaw: .6 }, { pucker: .35, puff: .4 }]) {
    const r = blow(i => i < 15 ? face({ pucker: .04 }) : face(shape), 1500);
    const ms = firstAbove(r, .5) - 15 * 33;
    t(ms <= 100, { shape, ms });
  }
});
test('A gentle round mouth held for 8 seconds keeps fogging', t => {
  const r = blow(i => i < 15 ? face({ pucker: .05 }) : face({ pucker: .38 }), 8500);
  t(r.at(-1) > .8, { end: r.at(-1) });
});
test('Fog stops quickly when the lips relax', t => {
  const r = blow(i => i < 60 ? face({ pucker: .8 }) : face({ pucker: .05 }), 3000);
  t(firstAbove(r.slice(60).map(x => -x), -.05) <= 600, { tail: r.slice(60, 80).map(x => +x.toFixed(2)) });
});
test('Ordinary faces do not fog it', t => {
  t(Math.max(...blow(face({ pucker: .1, funnel: .06 }), 4000)) < .05, 'resting');
  t(Math.max(...blow(face({ smile: .9, pucker: .15 }), 4000)) < .05, 'smiling');
  t(Math.max(...blow(face({ jaw: .9, funnel: .08, pucker: .05 }), 4000)) < .05, 'mouth wide open, not rounded');
  t(Math.max(...blow(i => i % 40 === 0 ? face({ pucker: .8 }) : face({}), 4000)) < .1, 'single-frame flicker');
  t(Math.max(...blow(null, 2000)) === 0, 'no face');
});
test('Someone whose mouth rests a bit pursed still has to round on purpose', t => {
  t(Math.max(...blow(face({ pucker: .17 }), 4000)) < .1, 'resting pursed');
  t(blow(i => i < 60 ? face({ pucker: .17 }) : face({ pucker: .5 }), 3000).at(-1) > .8, 'then rounds');
});

test('Pursed lips fog it from mouth shape alone, even when the model barely notices', t => {
  const rest = face({ width: .62, pucker: .05 });
  for (const w of [.55, .53, .5]) {
    const r = blow(i => i < 30 ? rest : face({ width: w, pucker: .1 }), 2000);
    t(firstAbove(r, .5) - 30 * 33 <= 100, { width: w, ms: firstAbove(r, .5) - 990 });
  }
});
test('Shape: smiling, talking-width changes and starting puckered behave', t => {
  t(Math.max(...blow(i => i < 30 ? face({ width: .62 }) : face({ width: .72, smile: .8 }), 3000)) < .05, 'smile is wider, not round');
  t(Math.max(...blow(i => face({ width: .62 + .01 * Math.sin(i / 3) }), 4000)) < .05, 'small natural movement');
  // Started the app with lips already pursed: relaxing teaches it, then rounding works.
  const r = blow(i => i < 20 ? face({ width: .5 }) : i < 80 ? face({ width: .62 }) : face({ width: .52 }), 4000);
  t(r.at(-1) > .6, { end: r.at(-1) });
  // After a smile, the relaxed mouth must not read as rounded.
  const q = blow(i => i < 30 ? face({ width: .62 }) : i < 90 ? face({ width: .72, smile: .8 }) : face({ width: .62, smile: .05 }), 5000);
  t(Math.max(...q.slice(95)) < .05, 'relaxed after smiling');
});

window.results = results;
const bad = results.filter(r => !r.ok);
document.getElementById('out').textContent = results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.pass}/${r.total}  ${r.name}${r.firstFail ? '\n      where: ' + JSON.stringify(r.by) : ''}`).join('\n') + `\n\n${bad.length ? bad.length + ' FAILED' : 'ALL PASSED'}`;
