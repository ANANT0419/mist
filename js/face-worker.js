// Reads the face in its own worker, so it can never slow hand tracking or the display.
const BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
let tracker = null;

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
      let delegate = 'GPU';
      try { tracker = await create('GPU'); } catch (e) { delegate = 'CPU'; tracker = await create('CPU'); }
      self.postMessage({ type: 'ready', delegate });
    } catch (e) { self.postMessage({ type: 'error', message: String(e && e.message || e) }); }
    return;
  }
  if (data.type === 'frame') {
    const t0 = performance.now();
    let out = null;
    try {
      const res = tracker.detectForVideo(data.bitmap, data.t);
      const cats = res.faceBlendshapes?.[0]?.categories;
      const lm = res.faceLandmarks?.[0];
      if (cats && lm) {
        const s = {};
        for (const c of cats) s[c.categoryName] = c.score;
        out = {
          pucker: s.mouthPucker || 0, funnel: s.mouthFunnel || 0, puff: s.cheekPuff || 0, jaw: s.jawOpen || 0,
          smile: Math.max(s.mouthSmileLeft || 0, s.mouthSmileRight || 0),
          mouth: { x: (lm[13].x + lm[14].x) / 2, y: (lm[13].y + lm[14].y) / 2 },
        };
      }
    } catch (e) { /* a dropped frame is fine */ }
    data.bitmap.close();
    self.postMessage({ type: 'result', face: out, infer: performance.now() - t0 });
  }
};
