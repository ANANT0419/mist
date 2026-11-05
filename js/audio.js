// Synthesised sound (no audio files).
window.Mist = window.Mist || {};

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function smooth(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

Mist.Sound = class {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.wipeLevel = 0;
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = buf; noise.loop = true;

    // Wipe: airy hiss in the upper band, kept clear of the band the breath detector listens to.
    this.wipeF = ctx.createBiquadFilter();
    this.wipeF.type = 'bandpass'; this.wipeF.frequency.value = 3000; this.wipeF.Q.value = .8;
    this.wipeG = ctx.createGain(); this.wipeG.gain.value = 0;
    noise.connect(this.wipeF).connect(this.wipeG).connect(ctx.destination);

    // Squeak: the faint rub of skin on wet glass.
    this.sq = ctx.createOscillator();
    this.sq.type = 'triangle'; this.sq.frequency.value = 1800;
    this.sqG = ctx.createGain(); this.sqG.gain.value = 0;
    this.sq.connect(this.sqG).connect(ctx.destination);
    this.sq.start();

    // Breath, for the Space key.
    this.brF = ctx.createBiquadFilter();
    this.brF.type = 'lowpass'; this.brF.frequency.value = 1300;
    this.brG = ctx.createGain(); this.brG.gain.value = 0;
    noise.connect(this.brF).connect(this.brG).connect(ctx.destination);
    noise.start();
  }

  // speed in screen heights per second, fist = 0|1
  wipe(speed, fist) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = this.enabled ? clamp01(speed / 2.2) : 0;
    this.wipeG.gain.setTargetAtTime(on * (fist ? .05 : .026), t, .035);
    this.wipeF.frequency.setTargetAtTime((fist ? 1900 : 2800) + on * 1800, t, .05);
    const stick = 1 + .5 * Math.sin(t * 37) * Math.sin(t * 11.3);
    const sq = this.enabled && !fist ? smooth(.22, .8, speed) * (1 - smooth(1.6, 3.2, speed)) : 0;
    this.sqG.gain.setTargetAtTime(sq * .0065 * Math.max(0, stick), t, .03);
    this.sq.frequency.setTargetAtTime(1500 + speed * 620, t, .06);
  }

  breathe(s) {
    if (!this.ctx) return;
    this.brG.gain.setTargetAtTime(this.enabled ? s * .055 : 0, this.ctx.currentTime, s > 0 ? .1 : .22);
  }

  // Short synthesised cues for the game.
  tone(freq, start, dur, gain, type = 'sine', slide = 0) {
    const ctx = this.ctx, t = ctx.currentTime + start;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(.03, dur * .2));
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + .02);
  }

  burst(start, dur, gain, freq, q = 1) {
    const ctx = this.ctx, t = ctx.currentTime + start;
    const len = Math.ceil(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; g.gain.value = gain;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t);
  }

  cue(name) {
    if (!this.ctx || !this.enabled) return;
    const chord = (notes, gap, dur, gain, type) => notes.forEach((n, i) => this.tone(n, i * gap, dur, gain, type));
    if (name === 'match') chord([392, 523, 659], .09, .7, .05);
    else if (name === 'count') this.tone(880, 0, .16, .05, 'triangle');
    else if (name === 'go') chord([659, 880, 1175], .03, .6, .05, 'triangle');
    else if (name === 'win') chord([523, 659, 784, 1047, 1319], .1, 1.3, .05);
    else if (name === 'lose') chord([392, 330], .16, .9, .035);
    else if (name === 'rise') { this.tone(110, 0, 2.2, .06, 'sawtooth', 5); this.tone(220, 0, 2.2, .03, 'sine', 5); }
    else if (name === 'open') { chord([261, 392, 523, 784, 1047, 1568], .025, 1.8, .045); this.burst(0, .7, .18, 900, .6); }
    else if (name === 'style') { this.tone(1760, 0, .28, .025); this.burst(0, .18, .05, 4200, 2); }
    else if (name === 'beat') { this.tone(62, 0, .2, .2); this.tone(58, .17, .24, .15); }
    else if (name === 'shatter') {
      this.burst(0, .9, .4, 3400, .5); this.burst(.03, .5, .25, 7000, 1);
      for (let i = 0; i < 9; i++) this.tone(1800 + Math.random() * 3400, .03 + Math.random() * .55, .3, .018);
    }
  }
};
