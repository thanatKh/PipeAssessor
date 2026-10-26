/* ============================================================================
   DEV-ONLY worst-case data for the dashboard (break-ui skill). Loaded only when
   `import.meta.env.DEV` and the URL carries ?data=worst|empty|one|huge — the
   production build drops the import entirely. Kept as the regression fixture for
   the next change to the dashboard: flip the toggle at the bottom of the page.

   Every value is something this register can really hold (text columns are
   unbounded in db/schema.sql, the form has no maxlength, Excel import accepts any
   number) — not random noise.
   ============================================================================ */

type Row = Record<string, unknown>;

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 86400000));
const daysAhead = (n: number) => iso(new Date(today.getTime() + n * 86400000));

let seq = 0;
function row(over: Row): Row {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    terminal: 'KBY', status: 'Open', finding_type: 'External Corrosion', severity: 'Medium',
    pipe_tag: null, location_desc: 'Pipe rack 5', description: null, is_leaking: false,
    inspection_date: daysAgo(30), created_at: new Date(today.getTime() - 30 * 86400000).toISOString(),
    target_date: null, next_check_date: null, estimated_cost: null, lat: null, lng: null,
    depth_mm: null, defect_length_mm: null, defect_width_mm: null,
    ...over,
  };
}

// One dataset, many failures — spread across the first rows (what is on screen first).
export function worstCase(): Row[] {
  seq = 0;
  return [
    // 1. long tag + leaking + overdue + needs engineer at once (badges compete for one line)
    row({ pipe_tag: '906100-P-8"-D31101-N-SPOOL-REPLACEMENT-PHASE-2-REV-B', is_leaking: true, severity: 'High',
      finding_type: 'CUI (Corrosion Under Insulation)', status: 'Repair Planned', target_date: daysAgo(40), estimated_cost: 12345678900,
      location_desc: 'Berth 2 LPG loading arm', inspection_date: '1970-01-01' }),
    // 2. Thai location with no spaces (Thai is written without word spaces — unbreakable for CSS)
    row({ location_desc: 'แนวท่อน้ำมันดิบขาเข้าจากท่าเทียบเรือหมายเลขสองไปยังถังเก็บD90912ฝั่งตะวันออกใกล้ประตูทางเข้าหลัก', is_leaking: true, severity: 'High',
      description: 'ท่อรั่วซึมบริเวณแนวเชื่อม '.repeat(40) }),
    // 3. one-character location, no tag, no type-friendly data
    row({ location_desc: 'J', finding_type: 'Other', severity: null }),
    // 4. 2,000-character pasted description with newlines + the third terminal
    row({ pipe_tag: '901-1"-A', terminal: 'BRP', description: ('Line one of the vendor report.\nSecond line copied from the PDF. ').repeat(35), severity: 'Low' }),
    // 5. negative cost (Excel import accepts it) + future inspection date
    row({ pipe_tag: '920503-3"-D1105-N', estimated_cost: -5000, inspection_date: daysAhead(20), severity: 'High' }),
    // 6. identical names (several real findings share a location name)
    row({ location_desc: 'Sub Sea ริมหาด BSRC', terminal: 'SRC', inspection_date: daysAgo(336) }),
    row({ location_desc: 'Sub Sea ริมหาด BSRC', terminal: 'SRC', inspection_date: daysAgo(12) }),
    // 7. overdue monitoring with a very old re-check date
    row({ pipe_tag: '907301-2"-C1101-N', status: 'Monitoring', next_check_date: daysAgo(900), severity: 'Medium' }),
    // 8. huge cost on a single finding (budget total width)
    row({ pipe_tag: '909118-2"-C1101-C-75', estimated_cost: 987654321, severity: 'Medium' }),
    // 9. resolved rows (completion %, status bar segments)
    row({ pipe_tag: '905036-8"-D1101-C-25', status: 'Repaired' }),
    row({ pipe_tag: '906100-8"-D3101-N', status: 'Closed' }),
    // 10. 300 new findings in one month (trend peak scale) — imported vendor report
    ...Array.from({ length: 300 }, (_, i) => row({ pipe_tag: `IMP-${String(i + 1).padStart(4, '0')}`, location_desc: `Imported row ${i + 1}`,
      inspection_date: daysAgo(15), severity: (['High', 'Medium', 'Low'] as const)[i % 3] })),
  ];
}

export function oneFinding(): Row[] {
  seq = 0;
  return [row({ pipe_tag: '912105-4"-D1101-N', is_leaking: true, severity: 'High', estimated_cost: 1 })];
}

export function huge(n = 1200): Row[] {
  seq = 0;
  const T = ['KBY', 'SRC', 'BRP'], S = ['Open', 'Open', 'Monitoring', 'Repair Planned', 'Repaired', 'Closed'];
  return Array.from({ length: n }, (_, i) => row({
    pipe_tag: `${900000 + i}-${(i % 12) + 1}"-D${1100 + (i % 50)}-N`, terminal: T[i % 3], status: S[i % S.length],
    is_leaking: i % 41 === 0, severity: (['High', 'Medium', 'Low'] as const)[i % 3],
    inspection_date: daysAgo(i % 365), target_date: i % 7 === 0 ? daysAgo(i % 30) : null,
    lat: 13.08 + (i % 40) * 0.0004, lng: 100.87 + (i % 30) * 0.0005,
  }));
}

export function fixtureFor(name: string): Row[] | null {
  if (name === 'worst') return worstCase();
  if (name === 'empty') return [];
  if (name === 'one') return oneFinding();
  if (name === 'huge') return huge();
  return null;
}
