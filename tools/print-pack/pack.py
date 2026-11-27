#!/usr/bin/env python3
"""Print pack: Booklet Fold "Print PDF" exports -> one printer-ready PDF (agent tool, run by Claude).

  python3 tools/print-pack/pack.py FRONT.pdf BACK.pdf DIELINE.pdf -o OUT.pdf [--profile fogra39|fogra39-300|fogra51|fogra52|PATH.icc]

Needs: ghostscript, pikepdf, Pillow, numpy; profiles from apt package icc-profiles (/usr/share/color/icc).
Input file names carry the geometry the plugin wrote: <name>_<side>_<W>x<H>mm_b<bleed>_s<slug>.pdf
What it does:
  1. Scales each page to real size (Figma 1 px = 1 pt; a 4 px/mm design scale is fixed here).
  2. Art pages -> CMYK through the chosen profile (relative colorimetric); black text and lines -> 100% K, big black fills -> rich 60/40/40/100
     (deeper on matte stock; --k-black for K only).
  3. Dieline page: magenta -> spot "CutContour", cyan -> spot "Fold", both overprint, nothing else on the page.
  4. Merges pages (front, back, dieline), sets TrimBox / BleedBox on every page, adds the output intent.
  5. Report: page size, trim, bleed, max total ink (TAC) per page, and a CMYK soft-proof PNG (rendered back through the profile).
Output is CMYK with an output intent and page boxes in the spirit of PDF/X-4; conformance is not validated here.
"""
import argparse, os, re, subprocess, sys, tempfile
import pikepdf
from pikepdf import Name, Array, Dictionary

ICC = '/usr/share/color/icc/'
PROFILES = {'fogra39': ('ISOcoated_v2_eci.icc', 'FOGRA39', 'Coated FOGRA39 (ISO 12647-2:2004)', 330),
            'fogra39-300': ('ISOcoated_v2_300_eci.icc', 'FOGRA39', 'Coated FOGRA39, TAC 300%', 300),
            'fogra51': ('PSOcoated_v3.icc', 'FOGRA51', 'PSO Coated v3 (FOGRA51)', 300),
            'fogra52': ('PSOuncoated_v3_FOGRA52.icc', 'FOGRA52', 'PSO Uncoated v3 (FOGRA52)', 300)}
PT = 72 / 25.4


def geo(path):
    m = re.search(r'_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm_b(\d+(?:\.\d+)?)_s(\d+(?:\.\d+)?)', os.path.basename(path))
    if not m: sys.exit(f'no geometry in file name: {path} (expected _<W>x<H>mm_b<bleed>_s<slug>)')
    return tuple(float(v) for v in m.groups())


def gs(args):
    r = subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER'] + args, capture_output=True, text=True)
    if r.returncode: sys.exit('ghostscript failed: ' + (r.stderr or r.stdout)[-600:])


def to_size(src, dst, wpt, hpt, cmyk=None):
    a = ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.6', '-dFIXEDMEDIA', '-dPDFFitPage',
         f'-dDEVICEWIDTHPOINTS={wpt:.3f}', f'-dDEVICEHEIGHTPOINTS={hpt:.3f}', '-dAutoRotatePages=/None',
         '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dAutoFilterColorImages=false',
         '-dColorImageFilter=/FlateEncode', '-dEmbedAllFonts=true', '-dSubsetFonts=true']
    if cmyk:
        a += ['-sColorConversionStrategy=CMYK', '-sProcessColorModel=DeviceCMYK', f'-sOutputICCProfile={cmyk}',
              '-dRenderIntent=1', '-dBlackText', '-dOverrideICC']   # not -dBlackVector: in pdfwrite it turns dark blues black
    else:   # dieline: plain conversion so RGB magenta lands on exactly 0/100/0/0
        a += ['-sColorConversionStrategy=CMYK', '-sProcessColorModel=DeviceCMYK', '-dUseFastColor']
    gs(a + ['-o', dst, src])


def spot(pdf, name, cmyk):
    fn = pdf.make_indirect(Dictionary(FunctionType=2, Domain=[0, 1], C0=[0, 0, 0, 0], C1=list(cmyk), N=1))
    return Array([Name.Separation, Name('/' + name), Name.DeviceCMYK, fn])


def dieline_spots(pdf):
    page = pdf.pages[0]
    def sub(d, k):
        if k not in d: d[k] = Dictionary()
        return d[k]
    res = sub(page.obj, '/Resources'); cs = sub(res, '/ColorSpace'); gsd = sub(res, '/ExtGState')
    cs['/CutContour'] = spot(pdf, 'CutContour', (0, 1, 0, 0)); cs['/Fold'] = spot(pdf, 'Fold', (1, 0, 0, 0))
    gsd['/GSop'] = Dictionary(Type=Name.ExtGState, OP=True, op=True, OPM=1)
    out, hits = [pikepdf.ContentStreamInstruction([Name.GSop], pikepdf.Operator('gs'))], {'CutContour': 0, 'Fold': 0}
    for ops, op in pikepdf.parse_content_stream(page):
        o = str(op)
        if o in ('K', 'k') and len(ops) == 4:
            c, m, y, k = (float(v) for v in ops)
            nm = 'CutContour' if m > .9 and c < .1 else 'Fold' if c > .9 else None
            if nm:
                hits[nm] += 1
                out.append(pikepdf.ContentStreamInstruction([Name('/' + nm)], pikepdf.Operator('CS' if o == 'K' else 'cs')))
                out.append(pikepdf.ContentStreamInstruction([1], pikepdf.Operator('SCN' if o == 'K' else 'scn')))
                continue
        out.append(pikepdf.ContentStreamInstruction(ops, op))
    page.obj['/Contents'] = pdf.make_stream(pikepdf.unparse_content_stream(out))
    return hits


def fix_black(pdf, rich):
    """RGB black arrives as ~4-colour 'rich' black after ICC conversion: thin lines and small type then smear on misregistration.
    Every such colour becomes 100% K; with rich=True filled areas get 60/40/40/100 instead (deep black for big areas)."""
    n = 0
    for page in pdf.pages:
        ins, out = list(pikepdf.parse_content_stream(page)), []
        for j, (ops, op) in enumerate(ins):
            o = str(op)
            if o in ('k', 'K') and len(ops) == 4:
                c, m, y, k = (float(v) for v in ops)
                if k > .85 and c > .5 and m > .4 and y > .4:
                    fill = o == 'k' and rich and any(str(x[1]) in ('f', 'F', 'f*', 'B', 'b') for x in ins[j + 1:j + 4])
                    ops = [.6, .4, .4, 1] if fill else [0, 0, 0, 1]; n += 1
            out.append(pikepdf.ContentStreamInstruction(ops, op))
        page.obj['/Contents'] = pdf.make_stream(pikepdf.unparse_content_stream(out))
    return n


def tac(pdf_path, tmp):
    """max total ink per page (%), from a 50 dpi CMYK render; small 2x2 smoothing so single anti-aliased pixels do not count"""
    import numpy as np
    from PIL import Image
    gs(['-sDEVICE=tiff32nc', '-r50', '-o', os.path.join(tmp, 't%d.tif'), pdf_path])
    out, i = [], 1
    while os.path.exists(os.path.join(tmp, f't{i}.tif')):
        a = np.asarray(Image.open(os.path.join(tmp, f't{i}.tif')), dtype=np.float32).sum(axis=2) / 2.55
        a = (a[:-1, :-1] + a[1:, :-1] + a[:-1, 1:] + a[1:, 1:]) / 4
        out.append(round(float(a.max()))); i += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('front'); ap.add_argument('back', nargs='?'); ap.add_argument('dieline', nargs='?')
    ap.add_argument('-o', '--out', required=True); ap.add_argument('--profile', default='fogra39')
    ap.add_argument('--k-black', action='store_true', help='all black 100% K (default: big black fills 60/40/40/100, text and lines 100% K)')
    a = ap.parse_args()
    prof = PROFILES.get(a.profile) or (a.profile, 'Custom', os.path.basename(a.profile), 300)
    icc = prof[0] if os.path.isabs(prof[0]) else ICC + prof[0]
    if not os.path.exists(icc): sys.exit(f'profile not found: {icc} (apt-get install icc-profiles)')
    W, H, b, s = geo(a.front)
    wpt, hpt = (W + 2 * b + 2 * s) * PT, (H + 2 * b + 2 * s) * PT
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for i, (src, art) in enumerate([(a.front, True), (a.back, True), (a.dieline, False)]):
            if not src: continue
            if geo(src) != (W, H, b, s): sys.exit(f'{src}: geometry differs from the front page')
            dst = os.path.join(tmp, f'p{i}.pdf'); to_size(src, dst, wpt, hpt, icc if art else None); parts.append((dst, art))
        out = pikepdf.new(); hits = None; blacks = 0
        for dst, art in parts:
            p = pikepdf.open(dst)
            if not art: hits = dieline_spots(p)
            else: blacks += fix_black(p, not a.k_black)
            out.pages.extend(p.pages)
        for pg in out.pages:
            x0, y0 = s * PT, s * PT
            pg.obj['/TrimBox'] = [x0, y0, x0 + W * PT, y0 + H * PT]
            pg.obj['/BleedBox'] = [x0 - b * PT, y0 - b * PT, x0 + (W + b) * PT, y0 + (H + b) * PT]
        with open(icc, 'rb') as f: data = f.read()
        prof_stream = out.make_stream(data); prof_stream['/N'] = 4
        out.Root['/OutputIntents'] = Array([Dictionary(Type=Name.OutputIntent, S=Name.GTS_PDFX, OutputConditionIdentifier=prof[1],
                                                       RegistryName='http://www.color.org', Info=prof[2], DestOutputProfile=prof_stream)])
        with out.open_metadata() as meta: meta['dc:title'] = os.path.splitext(os.path.basename(a.out))[0]
        out.save(a.out)
        t = tac(a.out, tmp)
        proof = os.path.splitext(a.out)[0] + '-proof.png'
        gs(['-sDEVICE=png16m', '-r40', '-dUseTrimBox=false', f'-sDefaultCMYKProfile={icc}', '-o', os.path.join(tmp, 'v%d.png'), a.out])
        from PIL import Image
        ims = [Image.open(os.path.join(tmp, f'v{i}.png')) for i in range(1, len(out.pages) + 1)]
        sheet = Image.new('RGB', (sum(i.width for i in ims) + 20 * (len(ims) + 1), max(i.height for i in ims) + 40), (200, 200, 200))
        x = 20
        for im in ims: sheet.paste(im, (x, 20)); x += im.width + 20
        sheet.save(proof)
    lim = prof[3]
    tl = ', '.join(f'p{i + 1} {v}%' + (' OVER' if v > lim and (i < len(t) - 1 or not hits) else '') for i, v in enumerate(t))
    print(f'OK {a.out}: {len(out.pages)} pages {wpt / PT:.1f}x{hpt / PT:.1f} mm, trim {W:g}x{H:g}, bleed {b:g} mm, {prof[1]}; '
          f'max ink {tl} (limit {lim}%); black set to K {blacks}x; dieline spots {hits}; proof {proof}')


if __name__ == '__main__':
    main()
