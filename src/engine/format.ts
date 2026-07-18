/* ============================================================================
   Display formatters (ported verbatim from asset/shared.js). Date/time are built
   from getDate()/getHours() etc. — NOT toLocale* — so dd Mmm yyyy + 24-hour time
   render identically regardless of the viewer's OS locale.
   ============================================================================ */

const PA_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type DateInput = Date | string | number | null | undefined;

/** dd Mmm yyyy; em-dash for anything unparseable (never "Invalid Date"). */
export function paFmtDate(v: DateInput): string {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d as any)) return '—';
  return `${String(d.getDate()).padStart(2, '0')} ${PA_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** 24-hour HH:mm. */
export function paFmtTime(v: DateInput): string {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d as any)) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** dd Mmm yyyy HH:mm. */
export function paFmtDateTime(v: DateInput): string {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d as any)) return '—';
  return `${paFmtDate(d)} ${paFmtTime(d)}`;
}

/** Full Thai Baht with separators: "฿1,250,000" / "—". */
export function paFmtBaht(n: number | null | undefined): string {
  return (n == null || !isFinite(n)) ? '—' : '฿' + Math.round(n).toLocaleString('en-US');
}

/** Abbreviated Baht for KPI tiles: "฿2.4M" / "฿450K" / "฿12,000" / "฿0". */
export function paFmtBahtShort(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '฿0';
  const a = Math.abs(n);
  if (a >= 1e6) return '฿' + (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  if (a >= 1e3) return '฿' + Math.round(n / 1e3) + 'K';
  return '฿' + Math.round(n).toLocaleString('en-US');
}

/** Fixed-decimal numeric display; em-dash for null/non-finite. */
export function paFmt(val: number | null | undefined, decimals = 2): string {
  return (val !== null && val !== undefined && isFinite(val)) ? Number(val).toFixed(decimals) : '—';
}
