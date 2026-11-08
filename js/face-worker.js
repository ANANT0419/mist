// Reads the face in its own worker, so it can never slow hand tracking or the display.
const BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
let tracker = null;
let lastT = -1;
let delegate = 'GPU';
let fails = 0;

async function loadVision() {
  const res = await fetch(`${BASE}/vision_bundle.cjs`);
  if (!res.ok) throw new Error(`Could not fetch the tracker (${res.status})`);
  const module = { exports: {} };
  new Function('module', 'exports', await res.text())(module, module.exports);
  return module.exports;
}

async function create(delegate) {
  const { FilesetResolver, FaceLandmarker } = await loadVision();
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
  });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      try { tracker = await create('GPU'); } catch (e) { delegate = 'CPU'; tracker = await create('CPU'); }
      self.postMessage({ type: 'ready', delegate });
    } catch (e) { self.postMessage({ type: 'error', message: String(e && e.message || e) }); }
    return;
  }
  if (data.type === 'frame') {
    if (!tracker) { data.bitmap.close(); self.postMessage({ type: 'result', face: null, infer: 0, delegate }); return; }
    const t0 = performance.now();
    let out = null;
    try {
      // The tracker rejects any timestamp that doesn't move forward.
      const ts = lastT = Math.max(data.t, lastT + 1);
      const res = tracker.detectForVideo(data.bitmap, ts);
      fails = 0;
      const cats = res.faceBlendshapes?.[0]?.categories;
      const lm = res.faceLandmarks?.[0];
      if (lm) {
        const s = {};
        if (cats) for (const c of cats) s[c.categoryName] = c.score;
        // The mouth's real shape, measured in 3D and scaled by the distance between the eyes,
        // so leaning in, leaning back or turning a little doesn't change it.
        const asp = data.bitmap.width / data.bitmap.height;
        const D = (a, b) => Math.hypot((lm[a].x - lm[b].x) * asp, lm[a].y - lm[b].y, (lm[a].z - lm[b].z) * asp);
        const eyes = D(33, 263) || 1e-6;
        out = {
          pucker: s.mouthPucker || 0, funnel: s.mouthFunnel || 0, puff: s.cheekPuff || 0, jaw: s.jawOpen || 0,
          smile: Math.max(s.mouthSmileLeft || 0, s.mouthSmileRight || 0),
          width: D(61, 291) / eyes,                 // corner to corner: shrinks when the lips round
          open: D(13, 14) / eyes,                   // gap between the lips
          lips: (D(0, 17)) / eyes,                  // outer lip height: grows as the lips push out and round
          mouth: { x: (lm[13].x + lm[14].x) / 2, y: (lm[13].y + lm[14].y) / 2 },
        };
      }
    } catch (e) {
      // If the GPU path keeps failing, carry on without it rather than seeing no face at all.
      if (++fails > 8 && delegate === 'GPU') {
        delegate = 'CPU'; fails = 0; lastT = -1;
        try { tracker.close(); } catch (_) {}
        tracker = null;
        create('CPU').then(t => { tracker = t; }).catch(() => {});
      }
    }
    data.bitmap.close();
    self.postMessage({ type: 'result', face: out, infer: performance.now() - t0, delegate });
  }
};
