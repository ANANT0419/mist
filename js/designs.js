// What players are asked to draw, and how a drawing is judged.
window.Mist = window.Mist || {};

Mist.Designs = (() => {
  const LIST = [
    { name: 'Crescent and star', d: 'M62 14A38 38 0 1 0 62 86A30 30 0 1 1 62 14Z M74 34L77 43L86 43L79 49L82 58L74 52L66 58L69 49L62 43L71 43Z' },
    { name: 'Lotus', d: 'M50 78C36 60 38 34 50 20C62 34 64 60 50 78Z M50 78C30 74 18 56 18 38C34 42 44 56 50 78 M50 78C70 74 82 56 82 38C66 42 56 56 50 78 M20 86C36 80 64 80 80 86' },
    { name: 'Leaf', d: 'M20 80C18 44 44 16 84 16C86 54 58 82 20 80Z M20 80C40 62 58 42 72 28 M40 62L38 44 M40 62L58 64 M56 45L55 30 M56 45L72 46' },
    { name: 'Paper boat', d: 'M14 62L86 62L72 84L28 84Z M50 62L50 16L74 54L50 54' },
    { name: 'Mountain at sunrise', d: 'M8 82L36 38L52 60L66 44L92 82Z M66 28A10 10 0 1 0 46 28A10 10 0 1 0 66 28Z' },
    { name: 'Growing heart', d: 'M50 88C18 66 12 42 28 32C40 26 50 36 50 46C50 36 60 26 72 32C88 42 82 66 50 88Z M50 46C50 32 50 24 50 16 M50 20C58 10 68 12 72 14C68 22 58 24 50 20' },
  ];

  const scale = paneAspect => Math.min(.72, .9 * paneAspect);

  // Points along the outline, in design space: centred, in screen heights, y up.
  function sample(index, n = 320) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.setAttribute('d', LIST[index].d);
    const subpaths = LIST[index].d.split(/(?=M)/).map(s => s.trim()).filter(Boolean);
    const lens = subpaths.map(sp => { svg.setAttribute('d', sp); return svg.getTotalLength(); });
    const total = lens.reduce((a, b) => a + b, 0);
    const pts = [];
    subpaths.forEach((sp, k) => {
      svg.setAttribute('d', sp);
      const c = Math.max(4, Math.round(n * lens[k] / total));
      for (let i = 0; i < c; i++) {
        const p = svg.getPointAtLength(lens[k] * i / c);
        pts.push([(p.x - 50) / 100, (50 - p.y) / 100]);
      }
    });
    return pts;
  }

  // Judge the glass itself. A cell counts as drawn if it's clear of fog, so scribbles count against
  // you, re-fogging really does undo a mistake, and skipping the blow leaves the whole pane "drawn".
  // grid: {g,w,h} fog 0..1. x0,x1: the pane's span in the grid. paneAspect: pane width / height.
  function score(grid, x0, x1, pts, paneAspect, opts = {}) {
    const { g, w, h } = grid;
    const pw = x1 - x0;
    const S = opts.scale ?? scale(paneAspect);
    const clearAt = opts.clearAt ?? .5;
    const tol = .014 * h;                       // a steady line stays this close, in cells
    const toCell = ([dx, dy]) => [x0 + (.5 + dx * S / paneAspect) * pw, (.5 + dy * S) * h];

    const clear = new Uint8Array(w * h);
    let clearCount = 0;
    const m = 3;                                 // ignore the pane's very edge
    for (let y = m; y < h - m; y++) for (let x = x0 + m; x < x1 - m; x++) {
      if (g[y * w + x] < clearAt) { clear[y * w + x] = 1; clearCount++; }
    }

    // Every measure is graded by distance, so a steadier hand always scores a little higher
    // and exact ties are rare. A line is about this wide, in cells, from its centre:
    const halfLine = .0095 * h + .4;
    const reach = tol * 1.3;
    const R = Math.ceil(halfLine + reach);
    const cells = pts.map(toCell);
    const nearest = new Float32Array(w * h).fill(1e9);
    for (const [cx, cy] of cells) {
      const ix = Math.round(cx), iy = Math.round(cy);
      for (let y = Math.max(0, iy - R); y <= Math.min(h - 1, iy + R); y++)
        for (let x = Math.max(0, ix - R); x <= Math.min(w - 1, ix + R); x++) {
          const d2 = (x - cx) ** 2 + (y - cy) ** 2;
          if (d2 < nearest[y * w + x]) nearest[y * w + x] = d2;
        }
    }

    // Precision: what you cleared should sit on the design.
    let onTarget = 0;
    for (let i = 0; i < clear.length; i++) {
      if (!clear[i] || nearest[i] === 1e9) continue;
      const over = Math.sqrt(nearest[i]) - halfLine;
      onTarget += over <= 0 ? 1 : Math.max(0, 1 - over / reach);
    }
    const precision = clearCount ? onTarget / clearCount : 0;

    // Recall: the design should be traced, all the way round.
    let got = 0;
    const search = Math.ceil(reach);
    for (const [cx, cy] of cells) {
      const ix = Math.round(cx), iy = Math.round(cy);
      let best2 = 1e9;
      for (let y = Math.max(0, iy - search); y <= Math.min(h - 1, iy + search); y++)
        for (let x = Math.max(0, ix - search); x <= Math.min(w - 1, ix + search); x++) {
          if (!clear[y * w + x]) continue;
          const d2 = (x - cx) ** 2 + (y - cy) ** 2;
          if (d2 < best2) best2 = d2;
        }
      if (best2 < 1e9) got += Math.max(0, 1 - Math.max(0, Math.sqrt(best2) - .8) / reach);
    }
    const recall = got / cells.length;

    // A pane that's mostly clear means you never really fogged it (or wiped it all away).
    const paneCells = (pw - 2 * m) * (h - 2 * m);
    const fogged = 1 - clearCount / paneCells;
    const fogFactor = Math.min(1, fogged / .6);

    const f1 = recall + precision > 0 ? 2 * recall * precision / (recall + precision) : 0;
    // Squared, so the gap between a good drawing and a messy one is obvious on the scoreboard.
    return { score: Math.round(100 * f1 * f1 * fogFactor), recall, precision, fogged, clearCount };
  }

  return { LIST, sample, score, scale };
})();
