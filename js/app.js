// Ties input to the simulation and owns the frame loop and the UI.
(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('glass');

  let R;
  try { R = new Mist.Renderer(canvas); }
  catch (e) {
    const f = $('fatal');
    f.hidden = false;
    f.textContent = 'Mist needs WebGL 2 with floating point rendering. Try a recent version of Chrome, Edge, Safari or Firefox.';
    console.error(e);
    return;
  }

  const drops = new Mist.Drops();
  const sound = new Mist.Sound();
  const camEl = $('cam');
  // The crop the mirror uses on screen, so a fingertip maps to exactly where you see it.
  const toGlass = (lx, ly) => {
    const c = R.cover(camEl.videoWidth || 16, camEl.videoHeight || 9);
    return { x: (.5 - lx) / c.x + .5, y: (.5 - ly) / c.y + .5 };
  };
  const hands = new Mist.Hands(camEl, toGlass);
  hands.getAspect = () => R.aspect;
  const face = new Mist.Face(camEl);

  const FINGER_R = Mist.Hands.FINGER_R, FIST_R = .088;
  const LINGER = [
    { evap: 1 / 55, tip: 'Fog lasts about a minute' },
    { evap: 1 / 260, tip: 'Fog lasts several minutes' },
    { evap: 0, tip: 'Fog stays until you clean' },
  ];

  const state = {
    strokes: [],
    allowBreath: true,
    allowTouch: true,
    frameLen: 0,
    soundKind: 0,
    fogLevel: 0,
    debug: false,
    tool: 0,               // 0 finger, 1 fist
    linger: 0,
    breath: { x: .5 * R.aspect, y: .5, r: .2, s: 0 },
    sustain: 0,
    space: false,
    pointer: { x: .5, y: .5, seen: false },
    look: { x: 0, y: 0 },
    clean: 0,
    fade: 0,
    fadeTarget: 1,
    speed: 0,
    drew: false,
    ghostHinted: false,
    saveNext: false,
    forceBreath: 0,        // test hook
    scene: 0,
    lastActive: performance.now(),
    screenStream: null,
    camStream: null,
    handsOn: false,
    frameAvg: 16,
    slowFrames: 0,
  };

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Hints ----------
  let hintTimer = 0;
  function hint(text, ms = 4200) {
    const h = $('hint');
    h.textContent = text;
    h.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => h.classList.remove('show'), ms);
  }

  // ---------- Strokes ----------
  function addStroke(ax, ay, bx, by, kind, seed, radius) {
    if (!state.allowTouch) return;
    let r = radius || (kind ? FIST_R : FINGER_R);
    if (!kind) r *= Math.min(1, R.aspect / 1.3);   // a tall window shouldn't mean a fat line
    const A = R.aspect;
    const s = { ax: ax * A, ay, bx: bx * A, by, r, kind, mem: 1, seed };
    state.strokes.push(s);
    state.frameLen += Math.hypot(s.bx - s.ax, s.by - s.ay);
    state.soundKind = kind;
    drops.feed(s.ax, s.ay, s.bx, s.by, r, kind, A);
  }

  // ---------- Pointer ----------
  const active = new Map();
  const toUV = e => ({ x: e.clientX / R.cssW, y: 1 - e.clientY / R.cssH });

  function kindFor(e) {
    if (e.shiftKey || e.buttons === 2) return 1;
    if (e.pointerType === 'touch' && Math.max(e.width || 0, e.height || 0) > 42) return 1;
    return state.tool;
  }

  canvas.addEventListener('pointerdown', e => {
    sound.ensure();
    if (!state.allowTouch) return;
    canvas.setPointerCapture(e.pointerId);
    const p = toUV(e);
    const kind = kindFor(e);
    const pen = new Mist.Pen(.0007, .003);
    pen.kind = kind; pen.seed = Math.random();
    pen.begin(p.x * R.aspect, p.y, e.timeStamp);
    active.set(e.pointerId, { pen, kind });
    state.drew = true;
    wake(true);
    updateBrush(e);
  });

  canvas.addEventListener('pointermove', e => {
    state.pointer = { ...toUV(e), seen: true };
    updateBrush(e);
    const a = active.get(e.pointerId);
    if (!a) { wake(e.clientY > R.cssH * .55); return; }
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (events.length ? events : [e])) {
      const p = toUV(ev);
      a.pen.add(p.x * R.aspect, p.y, ev.timeStamp);
    }
  });

  const penOut = pen => (ax, ay, bx, by) => addStroke(ax / R.aspect, ay, bx / R.aspect, by, pen.kind, pen.seed);

  function endPointer(e) {
    const a = active.get(e.pointerId);
    if (!a) return;
    active.delete(e.pointerId);
    const end = a.pen.end(penOut(a.pen));
    if (end) drops.pool(end.x / R.aspect, end.y, a.kind ? FIST_R : FINGER_R, a.kind);
    wake();
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerleave', () => { $('brush').style.opacity = 0; });

  const brush = $('brush');
  function updateBrush(e) {
    if (e.pointerType === 'touch') { brush.style.opacity = 0; return; }
    const a = active.get(e.pointerId);
    const kind = a ? a.kind : (e.shiftKey ? 1 : state.tool);
    const d = (kind ? FIST_R : FINGER_R) * R.cssH * 2;
    brush.style.width = brush.style.height = d + 'px';
    brush.style.marginLeft = brush.style.marginTop = (-d / 2) + 'px';
    brush.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
    brush.style.opacity = a ? .22 : .85;
  }

  // ---------- Dock ----------
  let idleTimer = 0;
  function wake(reveal = true) {
    state.lastActive = performance.now();
    if (active.size) { document.body.classList.add('quiet'); return; }
    if (reveal) document.body.classList.remove('quiet');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!$('dock').matches(':hover')) document.body.classList.add('quiet');
    }, 5500);
  }
  $('dock').addEventListener('pointerenter', () => { $('brush').style.opacity = 0; wake(); });
  $('dock').addEventListener('click', e => { if (e.detail && e.target.closest('button')) e.target.closest('button').blur(); });

  function setTool(t) {
    state.tool = t;
    [$('tool-finger'), $('tool-fist')].forEach((b, i) => {
      b.classList.toggle('on', i === t);
      b.setAttribute('aria-checked', i === t);
    });
  }
  $('tool-finger').onclick = () => setTool(0);
  $('tool-fist').onclick = () => setTool(1);

  // Camera, shared by hand tracking and the mirror scene.
  async function getCam() {
    if (state.camStream) return true;
    state.camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: 'user' }, audio: false,
    });
    camEl.srcObject = state.camStream;
    await camEl.play();
    return true;
  }
  function releaseCamIfUnused() {
    if (state.camStream && !state.handsOn && state.scene !== 3 && !face.running) {
      state.camStream.getTracks().forEach(t => t.stop());
      state.camStream = null;
      camEl.srcObject = null;
    }
  }

  function syncPreview() {
    // In the mirror your reflection is already the preview.
    $('pip').hidden = !state.handsOn || state.scene === 3;
    $('status').hidden = !state.handsOn;
  }

  let handsBusy = false;
  async function toggleHands() {
    if (handsBusy) return;
    const b = $('btn-hands');
    if (state.handsOn) {
      state.handsOn = false;
      hands.stop();
      b.setAttribute('aria-pressed', 'false');
      for (const c of handCursors) c.style.opacity = 0;
      R.tips.fill(0);
      syncPreview();
      releaseCamIfUnused();
      return;
    }
    handsBusy = true;
    sound.ensure();
    hint('Loading hand tracking. Your video stays on this computer.', 12000);
    try {
      await getCam();
      await Promise.all([hands.start(), face.start().catch(e => console.warn(e))]);
      state.handsOn = true;
      b.setAttribute('aria-pressed', 'true');
      await setScene(3);
      syncPreview();
      hint('Make a blowing face to fog the glass. Then point to draw, close all your fingers to wipe, open your hand to lift.', 8000);
    } catch (e) {
      console.warn(e);
      hint(e.name === 'NotAllowedError'
        ? 'Camera access was blocked. You can still draw with your mouse or trackpad.'
        : 'Hand tracking could not load. It needs an internet connection the first time.', 6000);
      releaseCamIfUnused();
    }
    handsBusy = false;
  }
  $('btn-hands').onclick = toggleHands;

  // What's behind the glass
  async function setScene(i) {
    const prev = state.scene;
    if (i === prev && i < 3) return;
    try {
      if (i === 3) {
        await getCam();
        R.setVideo(camEl, true, 1.04);
      } else if (i === 4) {
        if (!state.screenStream) {
          const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
          state.screenStream = s;
          const v = state.screenVideo = state.screenVideo || Object.assign(document.createElement('video'), { muted: true, playsInline: true });
          v.srcObject = s;
          await v.play();
          s.getVideoTracks()[0].addEventListener('ended', () => {
            state.screenStream = null;
            if (state.scene === 4) setScene(0);
          });
          hint('Now breathe on it. Press F for full screen.');
        }
        R.setVideo(state.screenVideo, false, 1);
      } else {
        R.scene = i;
        R.setVideo(null);
      }
    } catch (e) {
      console.warn(e);
      if (e.name !== 'AbortError') hint(i === 3 ? 'Camera access was blocked.' : 'Screen sharing was cancelled.');
      return;
    }
    state.scene = i;
    state.fade = .25;
    if (prev === 4 && i !== 4 && state.screenStream) {
      state.screenStream.getTracks().forEach(t => t.stop());
      state.screenStream = null;
    }
    releaseCamIfUnused();
    syncPreview();
    document.querySelectorAll('.orb').forEach(o => {
      const on = +o.dataset.scene === i;
      o.classList.toggle('on', on);
      o.setAttribute('aria-checked', on);
    });
  }
  document.querySelectorAll('.orb').forEach(o => { o.onclick = () => setScene(+o.dataset.scene); });

  $('btn-linger').onclick = () => {
    state.linger = (state.linger + 1) % LINGER.length;
    const l = LINGER[state.linger];
    $('btn-linger').dataset.tip = l.tip;
    hint(l.tip, 2200);
  };

  function clean() {
    state.clean = 1;
    state.fogLevel = 0;
    drops.clear();
    cancelIntro();
    state.drew = false;
    state.ghostHinted = false;
  }
  $('btn-clean').onclick = clean;

  function save() { state.saveNext = true; }
  $('btn-save').onclick = save;

  $('btn-sound').onclick = () => {
    sound.ensure();
    sound.enabled = !sound.enabled;
    $('btn-sound').setAttribute('aria-pressed', sound.enabled);
    if (!sound.enabled) { sound.wipe(0, 0); sound.breathe(0); }
  };

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
  $('btn-full').onclick = toggleFull;

  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) { sound.ensure(); state.space = true; cancelIntro(); }
      return;
    }
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'c') clean();
    else if (k === 's') save();
    else if (k === 'f') toggleFull();
    else if (k === 'h') document.body.classList.toggle('quiet');
    else if (k === 'd') { state.debug = !state.debug; $('debug').hidden = !state.debug; }
    else if (k >= '1' && k <= '5') setScene(+k - 1);
  });
  addEventListener('keyup', e => { if (e.code === 'Space') state.space = false; });
  addEventListener('blur', () => { state.space = false; });

  let resizeT = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => R.resize(), 90);
  });

  // ---------- Intro: the glass fogs itself and a finger writes hello ----------
  function buildIntroPaths() {
    const paths = [];
    const seg = (fn, n) => { const p = []; for (let i = 0; i <= n; i++) p.push(fn(i / n)); return p; };
    paths.push(seg(t => [-.19, .14 - t * .26], 14));                      // h, stem
    paths.push(seg(t => {                                                  // h, arch
      const a = 1 - t;
      const x = a * a * a * -.19 + 3 * a * a * t * -.15 + 3 * a * t * t * -.075 + t * t * t * -.075;
      const y = a * a * a * -.035 + 3 * a * a * t * .055 + 3 * a * t * t * .05 + t * t * t * -.12;
      return [x, y];
    }, 22));
    paths.push(seg(t => [.0, .03 - t * .15], 10));                         // i
    paths.push([[.0, .092], [.0005, .092]]);                               // dot
    paths.push(seg(t => {                                                  // heart
      const a = Math.PI + t * Math.PI * 2 * .999;
      const s = Math.sin(a), k = .0062;
      return [.17 + 16 * s * s * s * k, -.012 + (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) * k];
    }, 56));
    return paths;
  }

  const intro = {
    on: true, t: 0, path: 0, idx: 0, prog: 0,
    paths: buildIntroPaths(), seed: Math.random(), hinted: false,
  };
  function cancelIntro() { intro.on = false; intro.writing = false; }

  function runIntro(dt) {
    if (!intro.on) return 0;
    intro.t += dt;
    const t = intro.t;
    if (reduced) { intro.on = false; hintStart(); return 0; }

    if (t > 2.5 && !intro.writing && intro.path === 0 && intro.idx === 0) intro.writing = true;
    if (intro.writing) {
      intro.prog += dt * 62;
      while (intro.prog >= 1) {
        intro.prog -= 1;
        const p = intro.paths[intro.path];
        if (intro.idx + 1 < p.length) {
          const [ax, ay] = p[intro.idx], [bx, by] = p[intro.idx + 1];
          const A = R.aspect;
          addStroke(.5 + ax / A, .52 + ay, .5 + bx / A, .52 + by, 0, intro.seed, .0105);
          intro.idx++;
        } else {
          intro.path++; intro.idx = 0;
          intro.seed = Math.random();
          if (intro.path >= intro.paths.length) { intro.writing = false; break; }
        }
      }
    }
    if (intro.path >= intro.paths.length && !intro.hinted) {
      intro.hinted = true;
      setTimeout(hintStart, 500);
      intro.on = false;
    }
    return t < 2.2 ? Math.min(1, t * 1.4) * .9 : 0;
  }
  function hintStart() {
    if (document.body.classList.contains('landing')) return;
    hint('Purse your lips and blow at the camera to fog the glass, then draw with your finger.', 7500);
  }

  // ---------- Hands to strokes ----------
  const handCursors = [$('hand-0'), $('hand-1')];
  const WORDS = { finger: 'Drawing', fist: 'Wiping', hover: 'Hand lifted' };

  function runHands(now, dt) {
    if (!state.handsOn) return;
    const slots = hands.advance(now,
      (ax, ay, bx, by, kind, seed, r) => { addStroke(ax, ay, bx, by, kind, seed, r); state.drew = true; },
      (x, y, r, kind) => drops.pool(x, y, r, kind));

    const word = slots.length
      ? slots.map(h => (h.machine.touching ? WORDS[h.machine.state] : WORDS.hover)).join(' · ')
      : 'Show your hand';
    const st = $('status');
    if (st.textContent !== word) { st.textContent = word; $('pip-state').textContent = word; }
    st.dataset.mode = slots.some(h => h.machine.touching) ? 'on' : 'off';

    for (let i = 0; i < 2; i++) {
      const h = slots[i], el = handCursors[i];
      const showAim = h && h.tip && now - h.born > 110;
      // Let the fingertip show through the fog so you can aim, easing in and out.
      const target = showAim && h.machine.state !== 'fist' ? 1 : 0;
      R.tips[i * 3 + 2] += (target - R.tips[i * 3 + 2]) * Math.min(1, dt * 12);
      if (!showAim) { el.style.opacity = 0; continue; }

      const p = h.machine.state === 'fist' ? h.knuckles : h.tip;
      R.tips[i * 3] = h.tip.x * R.aspect;
      R.tips[i * 3 + 1] = h.tip.y;
      state.pointer = { x: p.x, y: p.y, seen: true };

      // While touching, the line itself is the feedback. The ring is only for aiming.
      const touching = h.machine.touching;
      const d = (h.machine.state === 'fist' ? h.r : .013) * R.cssH * 2;
      el.style.width = el.style.height = d + 'px';
      el.style.marginLeft = el.style.marginTop = (-d / 2) + 'px';
      el.style.transform = `translate(${p.x * R.cssW}px,${(1 - p.y) * R.cssH}px)`;
      el.style.opacity = touching ? (h.machine.state === 'fist' ? .3 : 0) : .85;
    }
    if (state.debug) drawDebug(slots);
  }

  // Press D: shows exactly what the tracker sees.
  const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  function drawDebug(slots) {
    const c = $('debug');
    if (c.width !== R.cssW || c.height !== R.cssH) { c.width = R.cssW; c.height = R.cssH; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const P = (l) => { const p = toGlass(l.x, l.y); return [p.x * R.cssW, (1 - p.y) * R.cssH]; };
    g.lineWidth = 2; g.strokeStyle = 'rgba(120,230,255,.9)'; g.fillStyle = '#fff';
    for (const h of hands.raw) {
      g.beginPath();
      for (const [a, b] of BONES) { g.moveTo(...P(h.lm[a])); g.lineTo(...P(h.lm[b])); }
      g.stroke();
    }
    g.font = '12px ui-monospace, Menlo, monospace';
    const st = hands.stats;
    const lines = [`tracker ${st.delegate}  ${st.fps.toFixed(0)} fps  inference ${st.infer.toFixed(1)} ms  round trip ${st.roundTrip.toFixed(1)} ms`,
      `display ${(1000 / state.frameAvg).toFixed(0)} fps  quality ${R.quality.toFixed(2)}`];
    if (face.face) {
      const f = face.face;
      lines.push(`face ${face.infer.toFixed(0)} ms  pucker ${f.pucker.toFixed(2)} funnel ${f.funnel.toFixed(2)} cheeks ${f.puff.toFixed(2)} jaw ${f.jaw.toFixed(2)} smile ${f.smile.toFixed(2)}  rest ${(face.blow.base || 0).toFixed(2)}  blowing ${face.strength.toFixed(2)}`);
    }
    for (const h of slots) {
      const m = h.machine.last;
      if (m) lines.push(`index ${m.idx.toFixed(2)} middle ${m.curl[1].toFixed(2)} ring ${m.curl[2].toFixed(2)} pinky ${m.curl[3].toFixed(2)} near ${m.tipNear.toFixed(2)} straight ${m.straight.toFixed(2)}  sees ${m.evidence}  state ${h.machine.state}${h.machine.lifted ? ' (lifted)' : ''}`);
    }
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(12, 56, 760, 12 + lines.length * 17);
    g.fillStyle = '#fff';
    lines.forEach((l, i) => g.fillText(l, 22, 76 + i * 17));
  }

  // ---------- Frame ----------
  let last = performance.now(), T = 0;
  const startSeed = Math.random() * 100;

  function frame(now) {
    requestAnimationFrame(frame);
    tick(now);
  }

  function tick(now) {
    const rawDt = Math.max(0, (now - last) / 1000);
    last = now;
    const dt = Math.min(rawDt, 1 / 20);
    T += dt;

    // Fall back to a lower resolution rather than a choppy pane.
    if (!document.hidden && rawDt < .25) {
      state.frameAvg += (rawDt * 1000 - state.frameAvg) * .05;
      state.slowFrames = state.frameAvg > 25 ? state.slowFrames + 1 : 0;
      if (state.slowFrames > 90 && R.quality > .56) {
        R.quality = Math.max(.55, R.quality - .15);
        R.resize();
        state.slowFrames = 0;
      }
    }

    // Breath: the intro, your blowing face, Space (solo only), or the test hook.
    const introS = runIntro(dt);
    const faceS = face.update(now, dt);
    const spaceS = state.space ? 1 : 0;
    let s = state.allowBreath ? Math.max(introS, faceS, spaceS, state.forceBreath) : 0;
    sound.breathe(Math.max(spaceS, state.allowBreath ? faceS : 0));
    $('status').dataset.blow = s > .05 ? '1' : '0';

    // The cloud starts wide and thick, and keeps spreading while you hold the shape.
    if (s > .02) state.sustain = Math.min(state.sustain + dt * (.6 + 1.2 * s), 3.2);
    else state.sustain = Math.max(0, state.sustain - dt * .9);

    const b = state.breath;
    let cx = .5, cy = .5;
    const mouth = face.mouth;
    if (state.space && state.pointer.seen) { cx = state.pointer.x; cy = state.pointer.y; }
    else if (mouth) { const m = toGlass(mouth.x, mouth.y); cx = m.x; cy = m.y; }   // fog spreads from your mouth
    else if (s > 0) {
      cx += Math.sin(T * .7 + startSeed) * .05;
      cy += Math.sin(T * .53 + startSeed * 2) * .05;
    }
    // Follow the mouth closely: the fog comes from wherever your lips are now.
    const follow = mouth ? 18 : 5;
    b.x += (cx * R.aspect - b.x) * Math.min(1, dt * follow);
    b.y += (cy - b.y) * Math.min(1, dt * follow);
    b.r = .24 + state.sustain * .62;
    b.s = s;

    // A fogged pane gathers water over time, and a drop now and then runs down it.
    state.fogLevel = s > .05 ? Math.min(1, state.fogLevel + dt * .4) : Math.max(0, state.fogLevel - dt * LINGER[state.linger].evap);
    if (state.fogLevel > .5 && Math.random() < dt * .22 ) {
      drops.spawn(Math.random(), .55 + Math.random() * .42, 5.2 + Math.random() * 1.8);
    }

    // Long breaths drip.
    if (s > .3 && Math.random() < dt * .8) {
      const an = Math.random() * 6.283, rr = Math.sqrt(Math.random()) * b.r * .8;
      const heavy = Math.random() < .14;
      drops.spawn(b.x / R.aspect + Math.cos(an) * rr / R.aspect, b.y + Math.sin(an) * rr,
        heavy ? 5 + Math.random() * 2 : 1.8 + Math.random() * 1);
    }

    if (state.drew && !state.ghostHinted && state.sustain > 1.2 && s > .2) {
      state.ghostHinted = true;
      setTimeout(() => hint('See that? The glass remembers where you touched it.', 5000), 700);
    }

    // Grow pointer strokes along their curves, then hand strokes.
    state.frameLen = 0;
    for (const a of active.values()) a.pen.advance(now - 7, penOut(a.pen));
    runHands(now, dt);

    // Touch sound.
    state.speed = Math.max(state.speed * Math.exp(-dt * 9), Math.min(5, state.frameLen / Math.max(dt, .004)));
    sound.wipe(state.speed, state.soundKind);

    // Reflections drift with the pointer, as if you moved your head.
    const tx = (state.pointer.x - .5) * 2, ty = (state.pointer.y - .5) * 2;
    state.look.x += (tx - state.look.x) * Math.min(1, dt * 2.2);
    state.look.y += (ty - state.look.y) * Math.min(1, dt * 2.2);

    // Passes.
    R.drawScene(T + startSeed);
    const used = R.simulate(dt, T, [b], state.strokes, LINGER[state.linger].evap, state.clean);
    state.strokes.splice(0, used);
    state.clean = state.clean > .5 ? .22 : (state.clean > .01 ? state.clean * .94 : 0);

    drops.update(dt, R.aspect, R.cssH, R.pxScale, R.fieldScale);
    R.drawDrops(drops);

    state.fade += (state.fadeTarget - state.fade) * Math.min(1, dt * 2.4);
    R.composite(T, state.look, state.fade);

    if (state.saveNext) {
      state.saveNext = false;
      canvas.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mist-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        hint('Saved to your downloads.', 2200);
      }, 'image/png');
    }
  }

  // ---------- Start ----------
  const L = { root: $('landing'), start: $('land-solo') };

  L.start.onclick = async () => {
    sound.ensure();
    document.body.classList.remove('landing');
    L.root.hidden = true;
    wake();
    try {
      hint('Loading. Your camera stays on this laptop.', 12000);
      await getCam();
      await Promise.all([hands.start(), face.start()]);
      state.handsOn = true;
      $('btn-hands').setAttribute('aria-pressed', 'true');
      await setScene(3);
      syncPreview();
      cancelIntro();
      hint('Round your lips like you’re blowing on glass. Then point to draw, close all your fingers to wipe.', 8000);
    } catch (e) {
      console.warn(e);
      hint('No camera. Hold Space to fog the glass and draw with your mouse.', 6000);
    }
  };

  document.body.classList.add('landing');
  wake();
  requestAnimationFrame(frame);

  // Exposed for testing and tinkering from the console.
  Mist.app = {
    state, R, drops, hands, face, sound, camEl, intro, cancelIntro, addStroke, clean, setScene, setTool, hint,
    tick,
    // Advance exactly n frames, even while the tab is in the background.
    step(n = 1) { for (let i = 0; i < n; i++) { last -= 1000 / 60; tick(last + 1000 / 60); last = performance.now(); } },
  };
})();
