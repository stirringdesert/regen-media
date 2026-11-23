# pdfprobe.py <pdf>: JSON with per-page boxes (pt), colour operators, thinnest stroke (pt), image count. Used by types/print.mjs.
import sys, json, math
from pypdf import PdfReader
from pypdf.generic import ContentStream

def mul(a, b):  # PDF matrices [a b c d e f]
    return [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3], a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3], a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]]

def walk(reader, res, content, ctm, st, depth=0):
    try:
        ops = ContentStream(content, reader).operations
    except Exception as e:
        st['err'] = str(e)[:80]; return
    stack, lw = [], st.get('lw', 1.0)
    for args, op in ops:
        op = op.decode() if isinstance(op, bytes) else str(op)
        if op == 'q': stack.append((ctm, lw))
        elif op == 'Q' and stack: ctm, lw = stack.pop()
        elif op == 'cm': ctm = mul([float(x) for x in args], ctm)
        elif op == 'w': lw = float(args[0])
        elif op in ('rg', 'RG'): st['rgb'] += 1
        elif op in ('k', 'K'): st['cmyk'] += 1
        elif op in ('g', 'G'): st['gray'] += 1
        elif op in ('sc', 'scn', 'SC', 'SCN'):
            n = len([a for a in args if isinstance(a, (int, float)) or hasattr(a, 'as_numeric') or str(type(a)).find('Float') >= 0 or str(type(a)).find('Number') >= 0])
            if n == 3: st['rgb'] += 1
            elif n == 4: st['cmyk'] += 1
            elif n == 1: st['gray'] += 1
        elif op in ('cs', 'CS'):
            try:
                nm = str(args[0])
                if nm == '/DeviceRGB': st['rgb'] += 1
                elif nm == '/DeviceCMYK': st['cmyk'] += 1
                elif nm == '/DeviceGray': st['gray'] += 1
                else:
                    cs = res['/ColorSpace'][nm]; cs = cs.get_object()
                    name = str(cs[0]) if isinstance(cs, list) else str(cs)
                    n = 0
                    if name == '/ICCBased': n = cs[1].get_object().get('/N', 0)
                    if n == 3 or name == '/CalRGB': st['rgb'] += 1
                    elif n == 4: st['cmyk'] += 1
                    elif n == 1 or name == '/CalGray': st['gray'] += 1
                    else: st['other'] += 1
            except Exception: st['other'] += 1
        elif op in ('S', 's', 'B', 'B*', 'b', 'b*'):
            sc = math.sqrt(abs(ctm[0]*ctm[3]-ctm[1]*ctm[2]))
            wpt = lw * sc
            st['strokes'] += 1
            if st['min'] is None or wpt < st['min']: st['min'] = wpt
            if wpt < 0.25: st['thin'] += 1
        elif op == 'sh': st['shading'] += 1
        elif op == 'gs':
            try:
                g = res['/ExtGState'][str(args[0])].get_object()
                if '/SMask' in g and str(g['/SMask']) != '/None': st['smask'] += 1
                for k in ('/CA', '/ca'):
                    if k in g and float(g[k]) < 1: st['alpha'] += 1
            except Exception: pass
        elif op == 'Do' and depth < 6:
            try:
                xo = res['/XObject'][str(args[0])].get_object()
                if xo.get('/Subtype') == '/Image':
                    st['images'] += 1
                    c = xo.get('/ColorSpace'); c = c.get_object() if c is not None else None
                    nm = str(c[0]) if isinstance(c, list) else str(c)
                    if nm == '/ICCBased': nm += str(c[1].get_object().get('/N'))
                    st['imgcs'][nm] = st['imgcs'].get(nm, 0) + 1
                elif xo.get('/Subtype') == '/Form':
                    m = [float(x) for x in xo.get('/Matrix', [1, 0, 0, 1, 0, 0])]
                    sub = dict(st); sub['lw'] = lw
                    walk(reader, xo.get('/Resources', res) or res, xo, mul(m, ctm), st, depth + 1)
            except Exception: pass

def main(path):
    r = PdfReader(path)
    out = {'pages': [], 'encrypted': r.is_encrypted}
    for p in r.pages:
        box = lambda b: [float(x) for x in b] if b is not None else None
        mb = p.mediabox; tb = p.trimbox if '/TrimBox' in p else None; bb = p.bleedbox if '/BleedBox' in p else None
        st = dict(rgb=0, cmyk=0, gray=0, other=0, strokes=0, thin=0, min=None, images=0, imgcs={}, shading=0, smask=0, alpha=0)
        try:
            res = p.get('/Resources') or {}
            res = res.get_object() if hasattr(res, 'get_object') else res
            walk(r, res, p.get_contents(), [1, 0, 0, 1, 0, 0], st)
        except Exception as e: st['err'] = str(e)[:80]
        rot = int(p.get('/Rotate', 0) or 0)
        out['pages'].append(dict(media=box(mb), trim=box(tb) if tb is not None else None, bleed=box(bb) if bb is not None else None, rotate=rot, **st))
    print(json.dumps(out))
main(sys.argv[1])
