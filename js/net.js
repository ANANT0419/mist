// Finding someone to play with, with no server of our own. Whoever arrives first holds a shared
// "lobby" name on PeerJS's free signalling service; the next person connects to that name and the
// two are paired. The holder then lets the name go, ready for the next two players.
window.Mist = window.Mist || {};

Mist.Net = class {
  constructor({ room = 'lobby', onStatus = () => {} } = {}) {
    this.lobby = `mist-v1-${room}`.replace(/[^a-zA-Z0-9-]/g, '');
    this.onStatus = onStatus;
    this.onMessage = () => {};
    this.onClose = () => {};
    this.peer = null; this.conn = null; this.call = null;
    this.isHost = false;
    this.cancelled = false;
    this.opts = { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } };
  }

  send(msg) { if (this.conn && this.conn.open) this.conn.send(msg); }

  cancel() {
    this.cancelled = true;
    if (this.peer) this.peer.destroy();
  }

  close() { this.cancelled = true; if (this.peer) this.peer.destroy(); }

  // Resolves with the rival's video stream once two players are joined.
  find(stream) {
    this.stream = stream;
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.tryHost();
    });
  }

  tryHost() {
    if (this.cancelled) return;
    this.onStatus('searching');
    const p = new Peer(this.lobby, this.opts);
    let settled = false;
    p.on('open', () => {
      settled = true;
      this.peer = p;
      this.isHost = true;
      this.onStatus('waiting');
      p.on('connection', c => this.hostAccept(p, c));
      p.on('call', call => {
        if (this.call) { call.close(); return; }
        this.call = call;
        call.answer(this.stream);
        call.on('stream', remote => this.paired(remote, p));
        call.on('close', () => this.lost());
      });
    });
    p.on('error', e => {
      if (e.type === 'unavailable-id' && !settled) { settled = true; p.destroy(); this.tryGuest(); return; }
      if (!settled) { settled = true; p.destroy(); this.retry(); return; }
      if (e.type === 'peer-unavailable') return;
      if (!this.conn) { this.peer = null; p.destroy(); this.retry(); }
    });
  }

  hostAccept(p, c) {
    if (this.conn) {
      c.on('open', () => { c.send({ t: 'busy' }); setTimeout(() => c.close(), 200); });
      return;
    }
    this.conn = c;
    c.on('open', () => c.send({ t: 'welcome' }));
    this.bindConn(c);
  }

  tryGuest() {
    if (this.cancelled) return;
    const p = new Peer(this.opts);
    this.peer = p;
    let fail = setTimeout(() => this.abandon(p), 7000);
    p.on('open', () => {
      const c = p.connect(this.lobby, { reliable: true });
      c.on('data', m => {
        if (m.t === 'busy') { clearTimeout(fail); this.abandon(p); return; }
        if (m.t === 'welcome' && !this.conn) {
          this.conn = c;
          clearTimeout(fail);
          fail = setTimeout(() => this.abandon(p), 15000);
          this.isHost = false;
          this.bindConn(c);
          const call = this.call = p.call(this.lobby, this.stream);
          call.on('stream', remote => { clearTimeout(fail); this.paired(remote, p); });
          call.on('close', () => this.lost());
        }
      });
    });
    p.on('error', e => { if (!this.conn || e.type === 'peer-unavailable') { clearTimeout(fail); this.abandon(p); } });
  }

  abandon(p) {
    if (this.matched) return;
    this.conn = null; this.call = null;
    p.destroy();
    this.retry();
  }

  retry() {
    if (this.cancelled || this.matched) return;
    setTimeout(() => this.tryHost(), 500 + Math.random() * 1200);
  }

  bindConn(c) {
    c.on('data', m => { if (m.t !== 'welcome' && m.t !== 'busy') this.onMessage(m); });
    c.on('close', () => this.lost());
  }

  paired(remote, p) {
    if (this.matched) return;
    this.matched = true;
    // Give the lobby name back shortly, so other players can pair up. The live link stays open.
    if (this.isHost) setTimeout(() => { if (!p.destroyed) p.disconnect(); }, 2500);
    this.onStatus('matched');
    this.resolve(remote);
  }

  lost() {
    if (this.closedOnce || !this.matched) return;
    this.closedOnce = true;
    this.onClose();
  }
};

// A practice rival for when nobody else is around. It speaks the same messages as a real player.
Mist.GhostNet = class {
  constructor({ skill = .55 } = {}) {
    this.isHost = true;
    this.onMessage = () => {};
    this.onClose = () => {};
    this.skill = skill;
    this.timers = [];
  }

  close() { this.closed = true; this.timers.forEach(clearInterval); clearInterval(this.anim); }

  stream() {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    const draw = () => {
      const t = performance.now() / 1000;
      const gr = g.createLinearGradient(0, 0, 0, 480);
      gr.addColorStop(0, '#1b2238'); gr.addColorStop(1, '#3a2c4d');
      g.fillStyle = gr; g.fillRect(0, 0, 640, 480);
      g.fillStyle = 'rgba(214,226,255,.55)';
      const y = 200 + Math.sin(t * 1.4) * 12;
      g.beginPath(); g.arc(320, y, 84, Math.PI, 0);
      for (let i = 0; i <= 8; i++) g.lineTo(404 - i * 21, y + 130 + (i % 2 ? -18 : 6) + Math.sin(t * 3 + i) * 5);
      g.closePath(); g.fill();
      g.fillStyle = '#20263c';
      g.beginPath(); g.arc(292, y - 8, 11, 0, 7); g.arc(348, y - 8, 11, 0, 7); g.fill();
    };
    draw();
    this.anim = setInterval(draw, 66);
    return c.captureStream(15);
  }

  send(m) {
    if (m.t === 'again') setTimeout(() => this.onMessage({ t: 'again' }), 900);
    if (m.t === 'phase' && m.p === 'play') this.playRound(m.design, m.ms);
    if (m.t === 'result' && m.scores[1] > m.scores[0] && m.scores[1] >= 15) this.performPrize();
  }

  // When the ghost wins, it uses its prize, so the loser has something to watch.
  performPrize() {
    const start = performance.now() + 8000;
    const hand = (cx, cy, roll) => {
      const out = [];
      const pts = [[0, 1], [-1.15, -.2], [-.35, 0], [-.4, -1.15], [-.1, 0], [-.12, -1.2], [.17, -1.1], [.4, 0], [.46, -.95]];
      const c = Math.cos(roll), s = Math.sin(roll), z = .12;
      for (const [x, y] of pts) out.push([+(cx + (x * c - y * s) * z * .56).toFixed(4), +(cy + (x * s + y * c) * z).toFixed(4)]);
      return out;
    };
    this.onMessage({ t: 'pz', ph: 'gift' });
    let stage = 'gift', styleN = 1, styleT = 0;
    const timer = setInterval(() => {
      if (this.closed) return clearInterval(timer);
      const t = (performance.now() - start) / 1000;
      if (t < 0) return;
      if (stage === 'gift') { stage = 'open'; this.onMessage({ t: 'pz', ph: 'open' }); }
      if (stage === 'open' && t > .85) { stage = 'play'; this.onMessage({ t: 'pz', ph: 'play' }); }
      const ang = Math.sin(t * .8) * .5, dx = Math.cos(ang) * .27, dy = Math.sin(ang) * .48;
      const life = stage === 'play' ? Math.max(0, 1 - (t - .85) / 10) : 1;
      if (t - styleT > 1.7 && stage === 'play') { styleT = t; styleN = (styleN + 1) % 6; }
      this.onMessage({ t: 'pz', h: [hand(.5 - dx, .52 - dy, ang * .4 - .25), hand(.5 + dx, .52 + dy, ang * .4 + .25)], life, st: styleN });
      if (stage === 'play' && life <= 0) {
        clearInterval(timer);
        this.onMessage({ t: 'pz', ph: 'shatter' });
        setTimeout(() => this.onMessage({ t: 'pz', ph: 'keep' }), 1900);
      }
    }, 33);
    this.timers.push(timer);
  }

  // Blows, then traces the design with an unsteady hand and a few gaps.
  playRound(index, ms) {
    const pts = Mist.Designs.sample(index, 240);
    const S = Mist.Designs.scale(this.paneAspect || .8);
    let i = 0, t = 0;
    const start = performance.now();
    // A hand that drifts off the line and back, and sometimes lifts.
    const amp = (1.15 - this.skill) * .042;
    const ph = [Math.random() * 6, Math.random() * 6, Math.random() * 6, Math.random() * 6];
    let dx = 0, dy = 0;
    const skip = () => Math.random() > this.skill + .36;
    const timer = setInterval(() => {
      if (this.closed) return clearInterval(timer);
      t = performance.now() - start;
      if (t < 2400) { this.onMessage({ t: 'br', s: 1, x: 0, y: -.05 }); return; }
      if (t < 2700) { this.onMessage({ t: 'br', s: 0, x: 0, y: -.05 }); return; }
      if (i >= pts.length || t > ms - 800) return clearInterval(timer);
      const seg = [];
      for (let k = 0; k < 3 && i + 1 < pts.length; k++, i++) {
        const jump = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) > .1;
        dx = amp * (Math.sin(i * .09 + ph[0]) * .7 + Math.sin(i * .23 + ph[1]) * .3);
        dy = amp * (Math.sin(i * .07 + ph[2]) * .7 + Math.sin(i * .19 + ph[3]) * .3);
        if (!jump && !skip()) seg.push((pts[i][0]) * S + dx, pts[i][1] * S + dy, pts[i + 1][0] * S + dx, pts[i + 1][1] * S + dy);
      }
      if (seg.length) this.onMessage({ t: 'st', k: 0, r: Mist.Hands.FINGER_R, p: seg });
    }, 70);
    this.timers.push(timer);
  }
};
