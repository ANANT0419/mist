// WebGL2 plumbing: programs, render targets, and the per-frame pass order.
window.Mist = window.Mist || {};

Mist.Renderer = class {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This GPU cannot render to floating point textures');
    }
    this.gl = gl;
    this.MAXSEG = 24;
    this.segA = new Float32Array(this.MAXSEG * 4);
    this.segB = new Float32Array(this.MAXSEG * 4);
    this.frame = 0;
    this.quality = 1;
    this.scene = 0;
    this.videoTex = null;
    this.video = null;
    this.videoFlip = false;
    this.videoDim = 1;
    this.split = null;
    this.breathData = new Float32Array(8);

    const S = Mist.shaders;
    this.tri = gl.createVertexArray();
    gl.bindVertexArray(this.tri);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.pts = gl.createVertexArray();
    gl.bindVertexArray(this.pts);
    this.ptBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const prog = (fs, vs = S.VS) => this.program(vs, fs);
    this.p = {
      sim: prog(S.SIM), glass: prog(S.GLASS), copy: prog(S.COPY), video: prog(S.VIDEO),
      down: prog(S.DOWN), up: prog(S.UP),
      carve: prog(S.CARVE, S.POINT_VS), drop: prog(S.DROP, S.POINT_VS),
      scenes: [prog(S.CITY), prog(S.DUSK), prog(S.AURORA)],
    };

    this.noise = this.bake(S.BAKE_NOISE, 512);
    this.tips = new Float32Array(6);
    this.resize();
  }

  program(vsSrc, fsSrc) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.bindAttribLocation(p, 0, vsSrc.includes('in vec4 a') ? 'a' : 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace('[0]', '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  target(w, h, { hdr = true, mip = false, repeat = false } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, w, h, mip };
  }

  free(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  bind(t) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : this.canvas.width, t ? t.h : this.canvas.height);
  }

  use(P, samplers = {}) {
    const gl = this.gl;
    gl.useProgram(P.p);
    let unit = 0;
    for (const k in samplers) {
      if (P.u[k] === undefined) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, samplers[k]);
      gl.uniform1i(P.u[k], unit++);
    }
  }

  full() {
    this.gl.bindVertexArray(this.tri);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  bake(fs, size) {
    const gl = this.gl;
    const t = this.target(size, size, { hdr: false, mip: true, repeat: true });
    this.bind(t);
    this.use(this.program(Mist.shaders.VS, fs));
    this.full();
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(1, window.innerWidth), cssH = Math.max(1, window.innerHeight);
    const w = Math.max(2, Math.round(cssW * dpr * this.quality));
    const h = Math.max(2, Math.round(cssH * dpr * this.quality));
    this.cssW = cssW; this.cssH = cssH;
    this.pxScale = w / cssW;
    this.aspect = cssW / cssH;
    this.canvas.width = w; this.canvas.height = h;

    // Scene at half res, capped, with a blur chain hanging off it.
    const sMax = 1280, sk = Math.min(.5, sMax / w);
    const sw = Math.max(2, Math.round(w * sk)), sh = Math.max(2, Math.round(h * sk));
    this.free(this.sceneT);
    this.sceneT = this.target(sw, sh);
    (this.chainD || []).forEach(t => this.free(t));
    (this.chainU || []).forEach(t => this.free(t));
    this.chainD = []; this.chainU = [];
    for (let i = 1; i <= 4; i++) {
      this.chainD.push(this.target(Math.max(2, sw >> i), Math.max(2, sh >> i)));
    }
    for (let i = 3; i >= 1; i--) {
      this.chainU.push(this.target(Math.max(2, sw >> i), Math.max(2, sh >> i)));
    }
    this.sceneDirty = true;

    // Fog field: keep whatever is already on the glass across resizes.
    const fMax = 2048, fk = Math.min(1, fMax / w);
    const fw = Math.max(2, Math.round(w * fk)), fh = Math.max(2, Math.round(h * fk));
    if (!this.fA || this.fA.w !== fw || this.fA.h !== fh) {
      const oldA = this.fA, oldB = this.fB;
      this.fA = this.target(fw, fh);
      this.fB = this.target(fw, fh);
      if (oldA) {
        gl.disable(gl.BLEND);
        this.bind(this.fA);
        this.use(this.p.copy, { uS: oldA.tex });
        this.full();
        this.free(oldA); this.free(oldB);
      }
    }
    this.fieldScale = fw / cssW;

    this.free(this.dropT);
    this.dropT = this.target(w, h);
  }

  setVideo(video, flip, dim = 1) {
    this.video = video;
    this.videoFlip = flip;
    this.videoDim = dim;
    if (video && !this.videoTex) {
      const gl = this.gl;
      this.videoTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    this.sceneDirty = true;
  }

  // Two live cameras side by side: left is you, right is your rival.
  setSplit(left, right) {
    this.split = [left, right];
    this.video = null;
    for (const k of ['texA', 'texB']) {
      if (this[k]) continue;
      const gl = this.gl;
      this[k] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this[k]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    this.sceneDirty = true;
  }

  drawVideo(v, tex, x, y, w, h, aspect, flip) {
    const gl = this.gl;
    gl.viewport(x, y, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    const P = this.p.video;
    this.use(P, { uV: tex });
    const c = this.cover(v.videoWidth, v.videoHeight, aspect);
    gl.uniform2f(P.u.uCover, c.x, c.y);
    gl.uniform1f(P.u.uFlip, flip ? 1 : 0);
    gl.uniform1f(P.u.uDim, this.videoDim);
    this.full();
  }

  drawScene(t) {
    const gl = this.gl;
    const v = this.video;
    if (this.split) {
      const ready = this.split.map(el => el && el.readyState >= 2 && el.videoWidth > 0);
      const times = this.split.map(el => el ? el.currentTime : 0);
      const changed = !this.lastSplitT || times[0] !== this.lastSplitT[0] || times[1] !== this.lastSplitT[1];
      if (!changed && !this.sceneDirty) return;
      this.lastSplitT = times;
      gl.disable(gl.BLEND);
      this.bind(this.sceneT);
      gl.clearColor(.03, .04, .07, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const w = this.sceneT.w, h = this.sceneT.h, half = w >> 1, pa = this.aspect / 2;
      this.videoDim = 1;
      if (ready[0]) this.drawVideo(this.split[0], this.texA, 0, 0, half, h, pa, true);
      if (ready[1]) this.drawVideo(this.split[1], this.texB, half, 0, w - half, h, pa, true);
      this.blurChain();
      this.sceneDirty = false;
      return;
    }
    if (v) {
      // Upload and blur only when the camera actually delivered a new frame.
      if (v.readyState < 2 || !v.videoWidth) return;
      if (v.currentTime === this.lastVideoTime && !this.sceneDirty) return;
      this.lastVideoTime = v.currentTime;
    } else if (!this.sceneDirty && this.frame % 2) {
      return;  // procedural scenes change slowly: every other frame is plenty
    }
    gl.disable(gl.BLEND);
    this.bind(this.sceneT);
    if (v) {
      this.drawVideo(v, this.videoTex, 0, 0, this.sceneT.w, this.sceneT.h, this.aspect, this.videoFlip);
    } else {
      const P = this.p.scenes[this.scene];
      this.use(P, { uN: this.noise.tex });
      gl.uniform1f(P.u.uT, t);
      gl.uniform1f(P.u.uA, this.aspect);
      this.full();
    }
    this.blurChain();
    this.sceneDirty = false;
  }

  blurChain() {
    const gl = this.gl;
    const pass = (P, src, dst, k) => {
      this.bind(dst);
      this.use(P, { uS: src.tex });
      gl.uniform2f(P.u.uTx, k / src.w, k / src.h);
      this.full();
    };
    let src = this.sceneT;
    for (const d of this.chainD) { pass(this.p.down, src, d, 1); src = d; }
    for (const u of this.chainU) { pass(this.p.up, src, u, 1.25); src = u; }
  }

  // How a video is cropped to fill the screen. Hand tracking must use this same crop,
  // or the line would not land under the fingertip.
  cover(vw, vh, ca = this.aspect) {
    const va = vw / vh;
    return { x: va > ca ? ca / va : 1, y: va > ca ? 1 : va / ca };
  }

  // strokes: [{ax,ay,bx,by,r,kind,mem,seed}], consumes up to MAXSEG and returns how many it used.
  simulate(dt, t, breaths, strokes, evap, clean) {
    const gl = this.gl;
    const P = this.p.sim;
    const n = Math.min(strokes.length, this.MAXSEG);
    for (let i = 0; i < n; i++) {
      const s = strokes[i];
      this.segA.set([s.ax, s.ay, s.bx, s.by], i * 4);
      this.segB.set([s.r, s.kind, s.mem, s.seed], i * 4);
    }
    gl.disable(gl.BLEND);
    this.bind(this.fB);
    this.use(P, { uF: this.fA.tex, uN: this.noise.tex });
    gl.uniform2f(P.u.uTexel, 1 / this.fA.w, 1 / this.fA.h);
    gl.uniform1f(P.u.uA, this.aspect);
    gl.uniform1f(P.u.uDt, dt);
    gl.uniform1f(P.u.uT, t);
    gl.uniform1f(P.u.uEvap, evap);
    gl.uniform1f(P.u.uClean, clean);
    gl.uniform1f(P.u.uFrame, this.frame % 977);
    for (let i = 0; i < 2; i++) {
      const b = breaths[i];
      this.breathData.set(b ? [b.x, b.y, b.r, b.s] : [0, 0, 0, 0], i * 4);
    }
    gl.uniform4fv(P.u.uBreath, this.breathData);
    gl.uniform1f(P.u.uSplit, this.split ? 1 : 0);
    gl.uniform1i(P.u.uSegN, n);
    gl.uniform4fv(P.u.uSegA, this.segA);
    gl.uniform4fv(P.u.uSegB, this.segB);
    this.full();
    [this.fA, this.fB] = [this.fB, this.fA];
    return n;
  }

  // Read the fog back as a small grid: how the round is judged. What's on the glass is what counts.
  readFog(w = 300, h = 180) {
    const gl = this.gl;
    if (!this.fogRead || this.fogRead.w !== w) { this.free(this.fogRead); this.fogRead = this.target(w, h, { hdr: false }); }
    gl.disable(gl.BLEND);
    this.bind(this.fogRead);
    this.use(this.p.copy, { uS: this.fA.tex });
    this.full();
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const g = new Float32Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = px[i * 4] / 255;
    return { g, w, h };
  }

  points(data, n) {
    const gl = this.gl;
    gl.bindVertexArray(this.pts);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 4), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, n);
  }

  drawDrops(drops) {
    const gl = this.gl;
    if (drops.carveN) {
      this.bind(this.fA);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
      this.use(this.p.carve);
      this.points(drops.carves, drops.carveN);
    }
    this.bind(this.dropT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (drops.count) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.use(this.p.drop);
      this.points(drops.sprites, drops.count);
      gl.blendEquation(gl.FUNC_ADD);
    }
    gl.disable(gl.BLEND);
  }

  composite(t, look, fade) {
    const gl = this.gl;
    const P = this.p.glass;
    this.bind(null);
    this.use(P, {
      uS: this.sceneT.tex, uBlur: this.chainU[this.chainU.length - 1].tex, uMid: this.chainD[1].tex,
      uF: this.fA.tex, uD: this.dropT.tex, uN: this.noise.tex,
    });
    gl.uniform2f(P.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(P.u.uFTexel, 1 / this.fA.w, 1 / this.fA.h);
    gl.uniform2f(P.u.uLook, look.x, look.y);
    gl.uniform3fv(P.u.uTip, this.tips);
    gl.uniform1f(P.u.uA, this.aspect);
    gl.uniform1f(P.u.uFade, fade);
    this.full();
    this.frame++;
  }
};
