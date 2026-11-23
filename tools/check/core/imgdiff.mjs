// Pixel diff done in the browser canvas (no image libs needed). Returns numbers; image only on request.
export async function pixelDiff(browser, a, b, { tol = 12, image = false } = {}) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([a, b, tol, image]) => {
      const load = async s => { const im = new Image(); im.src = 'data:image/png;base64,' + s; await im.decode(); return im; };
      const A = await load(a), B = await load(b);
      if (A.width !== B.width) return { pct: 100, note: `width ${A.width} vs ${B.width}` };
      const W = A.width, H = Math.max(A.height, B.height);
      const px = im => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0); return [c, x, x.getImageData(0, 0, W, H)]; };
      const [, , da] = px(A); const [cb, xb, db] = px(B);
      let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1; const out = image ? xb.createImageData(W, H) : null;
      for (let i = 0; i < da.data.length; i += 4) {
        const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]), Math.abs(da.data[i + 3] - db.data[i + 3]));
        const ch = d > tol; if (ch) { n++; const q = i / 4, x = q % W, y = (q / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (out) { out.data[i] = ch ? 255 : db.data[i] * .35; out.data[i + 1] = ch ? 40 : db.data[i + 1] * .35; out.data[i + 2] = ch ? 40 : db.data[i + 2] * .35; out.data[i + 3] = 255; }
      }
      const r = { pct: +(n / (W * H) * 100).toFixed(2), w: W, h: H, bbox: n ? [x0, y0, x1, y1] : null };
      if (out) { xb.putImageData(out, 0, 0); r.png = cb.toDataURL('image/png').split(',')[1]; }
      return r;
    }, [a.toString('base64'), b.toString('base64'), tol, image]);
  } finally { await page.close(); }
}
