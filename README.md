<h1>Pipe Assessor</h1>

<p>
    Pipe Assessor is a Supabase-backed findings tracker for piping inspection programs, with a full
    <strong>ASME B31.3</strong> wall-thickness assessment workbench built in. Every abnormal finding
    from a vendor inspection is logged and tracked through a status lifecycle (Open &rarr; Monitoring
    / Repair Planned &rarr; Repaired &rarr; Closed) until it's resolved — the goal is that no finding
    is ever forgotten. When a finding involves wall loss, the built-in workbench evaluates required
    thickness and Maximum Allowable Working Pressure (MAWP) per ASME B31.3, checks against API 574
    structural minimums, and suggests a repair category per ASME PCC-2 — producing a live status
    (OK / MONITOR / REPAIR), a cross-section diagram, and a generated PDF engineering report.
</p>

<hr>

<h2>Features</h2>
<ul>
    <li><strong>Findings dashboard:</strong> a satellite map + KPI summary (completion ring, outstanding repair budget, status counts, findings-by-type radar) alongside a filterable, searchable register of every finding.</li>
    <li><strong>Full lifecycle tracking:</strong> each finding moves through Open, Monitoring, Repair Planned, Repaired, and Closed, with a full status-change history and overdue tracking against target/re-inspection dates.</li>
    <li><strong>ASME B31.3 assessment workbench:</strong> dual input modes (wall-loss depth or measured minimum thickness, auto-derived from each other), required-thickness and MAWP calculations, a cross-section visualization, and a live OK / MONITOR / REPAIR status.</li>
    <li><strong>ASME PCC-2 repair advisor:</strong> repair category recommendations (composite wraps, welded sleeves, mechanical clamps, etc.) based on the assessment result.</li>
    <li><strong>Remaining-life estimate:</strong> given a corrosion rate, estimates time remaining until the pipe reaches its minimum required thickness.</li>
    <li><strong>Photo records:</strong> as-found and after-repair photos per finding, with camera capture support on mobile.</li>
    <li><strong>PDF reports:</strong> a per-finding engineering report (assessment inputs, results, governing equations, PCC-2 recommendation, site map, photos, history) and a management-summary PDF across the filtered register.</li>
    <li><strong>Excel/CSV import and export:</strong> bulk-import findings and the master pipe-tag line list from a spreadsheet; export the register to CSV or PDF.</li>
    <li><strong>Quick calculator:</strong> a standalone what-if workbench (reachable from the header) for a one-off calculation that doesn't save anything.</li>
</ul>

<hr>

<h2>Developing</h2>
<p>
    The app is a <strong>Vite + Vanilla TypeScript</strong> build (no framework). Install dependencies
    once with <code>npm install</code>, then:
</p>
<ul>
    <li><code>npm run dev</code> — start the Vite dev server with hot reload.</li>
    <li><code>npm run build</code> — produce the production bundle in <code>dist/</code>.</li>
    <li><code>npm run preview</code> — serve the built <code>dist/</code> locally.</li>
    <li><code>npm run typecheck</code> — run the TypeScript checker.</li>
    <li><code>npm run test</code> — run the ASME B31.3 engine's numeric-identity regression test (Vitest).</li>
</ul>
<p>
    The heavy libraries (jsPDF, SheetJS) are loaded on demand, so they only download when a report or
    spreadsheet is actually generated. Full functionality requires signing in and a network connection
    (Supabase). See <code>CLAUDE.md</code> for the module layout, architecture notes, and conventions.
</p>

<hr>

<h2>Equations</h2>
<p>
    The wall-thickness engine implements the ASME B31.3 required-thickness and MAWP equations for
    internal pressure design.
</p>

<h4>Required Wall Thickness</h4>
<p>
    $$t = \frac{PD}{2(SEW + PY)}$$
</p>
<p>
    Where:
</p>
<ul>
    <li>$P$ = Internal design gauge pressure (MPa)</li>
    <li>$D$ = Outside diameter of pipe (mm)</li>
    <li>$S$ = Allowable stress (MPa)</li>
    <li>$E$ = Longitudinal joint factor</li>
    <li>$W$ = Weld strength reduction factor</li>
    <li>$Y$ = Coefficient from the B31.3 table</li>
</ul>

<h4>Maximum Allowable Working Pressure (MAWP)</h4>
<p>
    The MAWP is a re-arranged version of the required thickness equation:
</p>
<p>
    $$P = \frac{2SEWt}{D - 2Yt}$$
</p>
<p>
    Two MAWP values are computed:
</p>
<ul>
    <li>MAWP (no CA) — the headline figure, using $t_{use} = t_{meas}$ (current condition at the measured thickness).</li>
    <li>MAWP (with CA) — a secondary reference, using $t_{use} = t_{meas} - CA$.</li>
</ul>
<p>
    Pressure is entered in bar or psi and converted to MPa internally.
</p>

<hr>

<h2>Tech stack</h2>
<p>
    Vite + TypeScript (Vanilla, no framework) for the app shell; Supabase (Postgres + Storage + Auth)
    for the backend; Leaflet for the satellite map; jsPDF + jspdf-autotable for PDF generation; SheetJS
    for Excel/CSV import and export; Basecoat for the design-system component styles.
</p>

<hr>

<h2>License</h2>
<p>
    This project is not licensed. Feel free to use and modify it for your own purposes.
</p>
