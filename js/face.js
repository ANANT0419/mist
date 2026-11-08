// Watches for the face you make when you blow on glass.
window.Mist = window.Mist || {};

Mist.Face = class {
  constructor(video) {
    this.video = video;
    this.worker = null;
    this.running = false;
    this.busy = false;
    this.t = 0;
    this.nextSend = 0;
    this.face = null;
    this.seen = 0;
    this.infer = 0;
    this.blow = new Mist.BlowDetector();
    this.strength = 0;
  }

  start() {
    if (this.worker) { this.running = true; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = this.worker = new Worker('js/face-worker.js');
      const timer = setTimeout(() => reject(new Error('Face tracker timed out')), 45000);
      w.onerror = e => { clearTimeout(timer); reject(new Error(e.message || 'Worker failed')); };
      w.onmessage = ({ data }) => {
        if (data.type === 'ready') { clearTimeout(timer); this.running = true; resolve(); }
        else if (data.type === 'error') { clearTimeout(timer); reject(new Error(data.message)); }
        else if (data.type === 'result') {
          this.busy = false;
          this.infer += (data.infer - this.infer) * .1;
          if (data.face) { this.face = data.face; this.seen = performance.now(); }
        }
      };
      w.postMessage({ type: 'init' });
    });
  }

  // Called every display frame; returns how hard you are blowing, 0..1.
  update(now, dt) {
    if (!this.running) return 0;
    const v = this.video;
    if (!this.busy && now >= this.nextSend && v.videoWidth && v.readyState >= 2) {
      this.busy = true;
      this.nextSend = now + 28;      // read the face as often as the camera allows
      this.t += 33;
      const k = Math.min(1, 480 / v.videoWidth);
      createImageBitmap(v, { resizeWidth: Math.round(v.videoWidth * k), resizeHeight: Math.round(v.videoHeight * k), resizeQuality: 'low' })
        .then(bitmap => this.worker.postMessage({ type: 'frame', bitmap, t: this.t }, [bitmap]))
        .catch(() => { this.busy = false; });
    }
    const fresh = this.face && now - this.seen < 400;
    this.strength = this.blow.update(fresh ? this.face : null, dt);
    return this.strength;
  }

  get mouth() { return this.face && performance.now() - this.seen < 400 ? this.face.mouth : null; }
};
