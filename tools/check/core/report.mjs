// Output contract: one line per check (PASS/WARN/FAIL + reason), one summary line, <= ~30 stdout lines.
// Everything else goes to log.txt.
export class Report {
  constructor(maxLines = 30) { this.rows = []; this.extra = []; this.logLines = []; this.maxLines = maxLines; }
  add(status, name, reason = '') { this.rows.push({ status, name, reason }); this.logLines.push(`${status} ${name}: ${reason}`); }
  pass(n, r) { this.add('PASS', n, r); }
  warn(n, r) { this.add('WARN', n, r); }
  fail(n, r) { this.add('FAIL', n, r); }
  note(line) { this.extra.push(line); this.logLines.push(line); }   // printed non-check line (e.g. SHEET path)
  detail(text) { this.logLines.push('  ' + String(text).replace(/\n/g, '\n  ')); }   // log only
  count(s) { return this.rows.filter(r => r.status === s).length; }
  get failed() { return this.count('FAIL') > 0; }
  render(summary) {
    const lines = this.rows.map(r => `${r.status} ${r.name.padEnd(9)} ${r.reason}`.trimEnd().slice(0, 220));
    const keep = this.maxLines - 2 - this.extra.length;
    const out = lines.length > keep ? [...lines.slice(0, keep - 1), `... ${lines.length - keep + 1} more lines in log`] : lines;
    return [...out, ...this.extra, summary].join('\n');
  }
}
