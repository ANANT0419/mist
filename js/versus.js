// One match: two cameras, one thing to draw, a fair judge, and a prize for the better drawing.
window.Mist = window.Mist || {};

Mist.Versus = class {
  constructor(app, net, remote) {
    this.app = app; this.net = net; this.remote = remote;
    this.seq = 0;
    this.design = 0;
    this.mine = []; this.theirs = [];
    this.outbox = [];
    this.lastBreath = 0;
    this.wantAgain = { me: false, them: false };
    this.ui = {
      root: document.getElementById('vs'), title: document.getElementById('vs-title'), sub: document.getElementById('vs-sub'),
      card: document.getElementById('vs-card'), cardSvg: document.getElementById('vs-card-svg'), cardName: document.getElementById('vs-card-name'),
      timer: document.getElementById('vs-timer'), bar: document.getElementById('vs-bar'),
      ghosts: [document.getElementById('vs-ghost-0'), document.getElementById('vs-ghost-1')],
      scores: [document.getElementById('vs-score-0'), document.getElementById('vs-score-1')],
      tags: [document.getElementById('vs-tag-0'), document.getElementById('vs-tag-1')],
      blow: document.getElementById('vs-blow'),
    };
    net.onMessage = m => this.onMessage(m);
    net.onClose = () => this.rivalLeft();
    this.flush = setInterval(() => this.sendStrokes(), 50);
  }

  start() {
    const a = this.app;
    this.ui.root.hidden = false;
    a.enterSplit(this.remote);
    this.connectHooks();
    if (this.net.isHost) this.runRound();
  }

  connectHooks() {
    const a = this.app;
    a.hooks.stroke = (ax, ay, bx, by, kind, r) => this.localStroke(ax, ay, bx, by, kind, r);
    a.hooks.breath = (s, x, y) => this.localBreath(s, x, y);
  }

  // Everything travels in "design space" (centred, screen heights), so players with
  // differently shaped windows still line up.
  get paneAspect() { return this.app.R.aspect / 2; }

  localStroke(ax, ay, bx, by, kind, r) {
    const pa = this.paneAspect;
    const toD = (x, y) => [(x * 2 - .5) * pa, y - .5];
    const [dax, day] = toD(ax, ay), [dbx, dby] = toD(bx, by);
    this.outbox.push({ k: kind, r, s: [dax, day, dbx, dby] });
    if (this.mine.length < 3000) this.mine.push(dbx, dby);
  }

  sendStrokes() {
    if (!this.outbox.length) return;
    const groups = new Map();
    for (const o of this.outbox) {
      const key = o.k + ':' + o.r.toFixed(4);
      if (!groups.has(key)) groups.set(key, { t: 'st', k: o.k, r: +o.r.toFixed(4), p: [] });
      const p = groups.get(key).p;
      for (const v of o.s) p.push(+v.toFixed(4));
    }
    this.outbox.length = 0;
    for (const g of groups.values()) this.net.send(g);
  }

  localBreath(s, x, y) {
    const now = performance.now();
    if (now - this.lastBreath < 66 && s > 0) return;
    if (s === 0 && this.sentZero) return;
    this.sentZero = s === 0;
    this.lastBreath = now;
    this.net.send({ t: 'br', s: +s.toFixed(2), x: +((x * 2 - .5) * this.paneAspect).toFixed(3), y: +(y - .5).toFixed(3) });
  }

  onMessage(m) {
    if (m.t === 'st') {
      const pa = this.paneAspect;
      for (let i = 0; i + 3 < m.p.length; i += 4) {
        const ax = (.5 + m.p[i] / pa) / 2 + .5, ay = m.p[i + 1] + .5, bx = (.5 + m.p[i + 2] / pa) / 2 + .5, by = m.p[i + 3] + .5;
        this.app.addRemoteStroke(ax, ay, bx, by, m.k, m.r);
        if (this.theirs.length < 3000) this.theirs.push(m.p[i + 2], m.p[i + 3]);
      }
    } else if (m.t === 'br') {
      this.app.setRemoteBreath(m.s, (.5 + m.x / this.paneAspect) / 2 + .5, m.y + .5);
    } else if (m.t === 'phase') {
      this.applyPhase(m);
    } else if (m.t === 'result') {
      this.showResult(m.scores[1], m.scores[0]);
    } else if (m.t === 'pz') {
      if (this.prize) this.prize.onRemote(m);
    } else if (m.t === 'again') {
      this.wantAgain.them = true;
      this.tryAgain();
    }
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async runRound() {
    const prev = this.design;
    do { this.design = Math.floor(Math.random() * Mist.Designs.LIST.length); } while (this.design === prev && this.seq);
    const id = ++this.seq;
    const go = async (p, ms) => {
      const m = { t: 'phase', p, ms, design: this.design };
      this.net.send(m);
      this.applyPhase(m);
      await this.sleep(ms);
      return id === this.seq;
    };
    if (!await go('meet', 2600)) return;
    if (!await go('reveal', 4200)) return;
    if (!await go('count', 3000)) return;
    if (!await go('play', this.playMs || 40000)) return;
    if (!await go('judge', 1600)) return;
    this.judge();
  }

  judge() {
    const R = this.app.R;
    const grid = R.readFog();
    const pts = Mist.Designs.sample(this.design);
    const half = grid.w >> 1, pa = this.paneAspect;
    const a = Mist.Designs.score(grid, 0, half, pts, pa);
    const b = Mist.Designs.score(grid, half, grid.w, pts, pa);
    this.lastJudge = { a, b };
    this.net.send({ t: 'result', scores: [a.score, b.score] });
    this.showResult(a.score, b.score);
  }

  applyPhase(m) {
    const { ui, app } = this;
    this.phase = m.p;
    this.design = m.design;
    clearInterval(this.timerInt);
    ui.timer.hidden = true;
    ui.blow.hidden = true;
    if (m.p === 'meet') {
      this.mine = []; this.theirs = [];
      this.prize = null;
      this.wantAgain = { me: false, them: false };
      app.setOverlay(null);
      document.getElementById('prize').hidden = true;
      ui.root.classList.remove('prize-on');
      app.resetSplit(this.remote);
      this.connectHooks();
      this.setGhosts(0);
      ui.scores.forEach(s => { s.hidden = true; s.textContent = ''; });
      ui.tags.forEach(t => t.classList.remove('win'));
      document.getElementById('keep-card').hidden = true;
      this.title('Matched', 'Say hi. In a moment you’ll both get the same drawing.');
      app.sound.cue('match');
    } else if (m.p === 'reveal') {
      const d = Mist.Designs.LIST[m.design];
      ui.cardSvg.innerHTML = `<path d="${d.d}"/>`;
      ui.cardName.textContent = d.name;
      ui.card.hidden = false;
      this.title('', '');
      this.setGhosts(.42);
    } else if (m.p === 'count') {
      ui.card.hidden = true;
      let n = 3;
      this.title(String(n), 'Get ready to blow');
      app.sound.cue('count');
      this.countInt = setInterval(() => {
        n--;
        if (n > 0) { this.title(String(n), 'Get ready to blow'); app.sound.cue('count'); }
        else clearInterval(this.countInt);
      }, 1000);
    } else if (m.p === 'play') {
      clearInterval(this.countInt);
      this.title('Blow', '');
      app.sound.cue('go');
      setTimeout(() => { if (this.phase === 'play') this.title('', ''); }, 1000);
      app.setAllowed(true, true);
      this.setGhosts(.3);
      ui.blow.hidden = false;
      setTimeout(() => { ui.blow.hidden = true; }, 7000);
      const end = performance.now() + m.ms;
      ui.timer.hidden = false;
      this.timerInt = setInterval(() => {
        const left = Math.max(0, end - performance.now());
        ui.bar.style.transform = `scaleX(${left / m.ms})`;
        ui.timer.dataset.low = left < 8000 ? '1' : '0';
      }, 100);
    } else if (m.p === 'judge') {
      app.setAllowed(false, false);
      this.title('Hands off the glass', 'Comparing your drawings');
      this.setGhosts(.85);
    }
  }

  title(t, s) {
    this.ui.title.textContent = t;
    this.ui.sub.textContent = s;
    this.ui.title.classList.remove('pop');
    void this.ui.title.offsetWidth;
    if (t) this.ui.title.classList.add('pop');
  }

  setGhosts(op) {
    const d = Mist.Designs.LIST[this.design];
    const S = Mist.Designs.scale(this.paneAspect);
    for (const g of this.ui.ghosts) {
      g.style.opacity = op;
      g.style.setProperty('--size', `${S * 100}vh`);
      g.innerHTML = `<path d="${d.d}"/>`;
    }
  }

  showResult(mine, theirs) {
    const { ui, app } = this;
    this.phase = 'results';
    this.title('', '');
    // The prize has to be earned: a real attempt is required, even to win by default.
    const MIN = 15;
    const best = Math.max(mine, theirs);
    const nobody = best < MIN;
    const iWon = mine > theirs, tie = mine === theirs;
    const finals = [mine, theirs];
    ui.scores.forEach((el, i) => { el.hidden = false; el.textContent = '0'; });
    const t0 = performance.now();
    const roll = () => {
      const k = Math.min(1, (performance.now() - t0) / 1500), e = 1 - (1 - k) ** 3;
      ui.scores.forEach((el, i) => { el.textContent = Math.round(finals[i] * e); });
      if (k < 1) requestAnimationFrame(roll);
    };
    roll();
    setTimeout(() => { for (let i = 0; i < 2; i++) ui.scores[i].textContent = finals[i]; }, 1600);
    if (nobody) {
      setTimeout(() => { this.title('Nobody drew it', 'No prize this time. Blow on the glass, then trace the shape.'); app.sound.cue('lose'); }, 1700);
      setTimeout(() => { if (this.net.isHost && this.phase === 'results') this.runRound(); }, 6000);
      return;
    }
    setTimeout(() => {
      if (tie) { ui.tags.forEach(t => t.classList.add('win')); this.title('A perfect tie', 'You both earned it'); app.sound.cue('win'); }
      else {
        ui.tags[iWon ? 0 : 1].classList.add('win');
        this.title(iWon ? 'You drew it better' : 'They drew it better', '');
        app.sound.cue(iWon ? 'win' : 'lose');
      }
    }, 1700);
    setTimeout(() => this.startPrize(iWon || tie, tie), 5200);
  }

  startPrize(mineWon, tie) {
    const { ui, app } = this;
    this.title('', '');
    ui.scores.forEach(s => { s.hidden = true; });
    this.setGhosts(0);
    const pts = mineWon ? this.mine : this.theirs;
    this.prize = new Mist.Prize({
      app, mine: mineWon, tie,
      video: mineWon ? app.camEl : this.remote,
      ribbon: pts, ribbonSide: mineWon ? 0 : 1, paneAspect: this.paneAspect,
      send: m => this.net.send(m),
      onAgain: () => { this.wantAgain.me = true; this.net.send({ t: 'again' }); this.tryAgain(); },
    });
    ui.root.classList.add('prize-on');
    app.setOverlay(this.prize);
  }

  tryAgain() {
    if (!this.wantAgain.me || !this.wantAgain.them) {
      if (this.wantAgain.me && this.prize) this.prize.waitingForRival();
      return;
    }
    this.ui.root.classList.remove('prize-on');
    this.app.setOverlay(null);
    if (this.net.isHost) this.runRound();
  }

  rivalLeft() {
    this.seq++;
    clearInterval(this.timerInt);
    this.app.setAllowed(false, false);
    this.app.hint('Your rival left the match.', 6000);
    document.getElementById('vs-left').hidden = false;
  }
};
