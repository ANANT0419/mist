// Runs the hand tracker off the main thread, so inference can never stutter the display.
const BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let tracker = null;
let lastT = -1;
let vision = null;

// The CDN serves this bundle with a MIME type importScripts refuses, so load it as text.
async function loadVision() {
  if (vision) return vision;
  const res = await fetch(`${BASE}/vision_bundle.cjs`);
  if (!res.ok) throw new Error(`Could not fetch the tracker (${res.status})`);
  const module = { exports: {} };
  new Function('module', 'exports', await res.text())(module, module.exports);
  return (vision = module.exports);
}

async function create(delegate, numHands) {
  const { FilesetResolver, HandLandmarker } = await loadVision();
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numHands,
    minHandDetectionConfidence: .55,
    minHandPresenceConfidence: .55,
    minTrackingConfidence: .55,
  });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    let delegate = data.delegate || 'GPU';
    const numHands = data.numHands || 1;
    try {
      try { tracker = await create(delegate, numHands); }
      catch (e) { delegate = 'CPU'; tracker = await create('CPU', numHands); }
      self.postMessage({ type: 'ready', delegate });
    } catch (e) {
      self.postMessage({ type: 'error', message: String(e && e.message || e) });
    }
    return;
  }

  if (data.type === 'options') {
    try { await tracker.setOptions({ numHands: data.numHands }); } catch (e) { /* keep going */ }
    return;
  }

  if (data.type === 'frame') {
    const t0 = performance.now();
    let hands = [];
    try {
      // The tracker rejects any timestamp that doesn't move forward.
      const ts = lastT = Math.max(data.t, lastT + 1);
      const res = tracker.detectForVideo(data.bitmap, ts);
      hands = (res.landmarks || []).map((lm, i) => ({
        lm,
        world: res.worldLandmarks[i],
        score: res.handednesses?.[i]?.[0]?.score ?? 1,
      }));
    } catch (e) {
      self.postMessage({ type: 'frameError', message: String(e && e.message || e) });
    }
    data.bitmap.close();
    self.postMessage({ type: 'result', t: data.t, sent: data.sent, infer: performance.now() - t0, hands });
  }
};
