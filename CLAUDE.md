# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Rules

- **Do NOT push to git automatically**: Never run `git push` after code edits unless the user explicitly requests a push. The user prefers to review changes locally and push manually.

## What this is

Pipe Assessor is a single-file web app (`index.html`, ~4000 lines: HTML + `<style>` + `<script>`, no build step) that evaluates pipe wall-thickness integrity per **ASME B31.3** (required thickness / MAWP) and **ASME PCC-2** (repair category advice), with API 574 structural minimums as a secondary check. Field engineers/inspectors enter measured wall loss and get a status (OK / MONITOR / REPAIR), remaining life estimate, and a generated PDF engineering report.

No package.json or build tooling. Development consists of opening/editing `index.html` directly. CDN dependencies (pinned versions, loaded as static `defer` tags so the browser caches them for offline use):
- **Basecoat CSS 1.0.1** (`basecoat.cdn.min.css` + `basecoat.min.js`) — the user's preferred UI framework: shadcn/ui-style component classes (`.btn`, `.card`, `.input`, `.select`, `.field`) with brand colors mapped onto Basecoat's CSS variables (`--primary: #156B95`, etc.) in the first `<style>` block for both `:root` and `html.dark`.
- **jsPDF 2.5.2 + jspdf-autotable 3.8.4** — client-side PDF report generation. Do NOT bump versions without retesting (autotable 3.8.x pairs with jsPDF 2.x).

## Running / testing

- Open `index.html` directly in a browser (double-click or a static file server) — no build or install step.
- No automated test suite in the repo, but Playwright verification scripts are the established pattern: a scratchpad `baseline.js` (functional checklist: ERF overshoot pinning, validation paths, override switches, mode toggle, collapse+print force-open, reset confirm, theme persistence) and per-stage screenshot scripts (widths 1440/1024/820/390 × light/dark + print emulation), run via `node` with `APP_HTML` env var pointing at the file. Recreate these from the descriptions above if missing; verify in-browser rather than assuming correctness from code inspection.
- Note: headless Chromium does not paint iframe PDF viewers — verify generated PDF *content* by exporting the blob bytes and rendering pages with pdf.js (see the stage3-render.js pattern: base64 the blob out of the page, then render each page to canvas in a blank page with pdfjs-dist from CDN).

## Architecture

Everything lives in one file: `<head>` (CDN tags → Basecoat brand-variable override `<style>` → main app `<style>`) → HTML body (header with action buttons, mobile status strip + tab bar, two-column dashboard of `.card` sections) → single `<script>` block with all app logic. The generated PDF has no in-page dialog/iframe of its own — it opens in a new browser tab via the OS/browser's native PDF viewer (see `openPdfNative` below).

### Data flow

1. **Static data tables** (top of `<script>`): `PIPE_DATABASE` (NPS → OD + schedule→thickness, per ASME B36.10M) and `MATERIALS`. `getApi574Min(nps)` is the structural-minimum lookup.
2. **`initApp()`** (bottom of file) wires everything: theme restore (adds `.dark` to BOTH `body` and `documentElement` — Basecoat's dark component styles are gated on `html.dark`), renders `SCOPE_HTML` into `#scopeNotice`, calls `initSelections()`, `resetDefaults()`, `initHoverHighlighting()`, `initDragHandle()`, `initMobileTabs()`, and attaches `input` listeners → `recalc()`.
3. **Every input change → `recalc()` → `runCalculations()`** (pure-ish, reads form fields, does the B31.3 math, returns `res`). `window.lastRes` caches the last result.
4. **`recalc()` pushes `res` into the DOM**: results table, `drawSvgPipe(res)`, `updateRepairAdvisor(res)`, `updateDynamicEquations(res)`, gauges, and the mobile status strip (`#mStatusVal`/`#mErfVal`).
5. No separate state store — the DOM is the state.

### PDF report subsystem (all client-side)

- `savePDF()` — async entry point: guards `hasErrors` and `window.jspdf` (falls back to `window.print()` if the CDN never loaded), then `buildPdfReport(res)` → `openPdfNative(blob)`.
- `buildPdfReport(res)` — A4 report: white header strip with the full-color OR logo (embedded base64 `OR_LOGO_DATAURL`, generated from `asset/RGB_OR_Full color.png` downscaled to 600px — regenerate the base64 if the asset changes), document info table, colored status band, inputs table, Figure 1 cross-section, results table with PASS/CHECK verdicts + FFS recommendation note when checks fail, substituted equations (computed from `res`, not scraped from DOM), PCC-2 bullets via `getAdvisorItems(res)`, scope text from `SCOPE_TEXT`, signature block. **Only WinAnsi-safe characters** in PDF strings — jsPDF built-in fonts have no `≥`/`≤` glyphs (use `>=`/`<=`); em-dash/degree/bullet are fine.
- `svgToPngDataUrl(scale)` — serializes `#pipeSvg` to PNG for the PDF. Must inject a fixed light-palette `<style>` into the clone (CSS variables don't resolve in standalone SVGs; also keeps the diagram light in dark mode) and rewrite `<text>` font-family to Arial (Inter isn't available in the isolated SVG context). Strips the drag handle.
- `fetchLogoDataUrl()` — memoized, 3s timeout, resolves null on failure (expected on `file://`). Never draw a non-CORS `<img>` onto the SVG canvas — it taints it.
- `openPdfNative(blob)` — opens the PDF in a new tab using the **browser's own native PDF viewer**: no custom dialog, no iframe. Implementation is deliberately narrow: `URL.createObjectURL(blob)` on a real `<a href=... target="_blank" rel="noopener">` element, then `.click()`. Two other approaches were tried and both fail on `file://` (this app's primary no-build deployment mode) — do not reintroduce them: (1) `window.open('', '_blank')` followed by setting `.location` on the resulting blank tab hits `net::ERR_ABORTED`, because that blank tab can end up with a different opaque origin than its opener, and a `blob:` URL only resolves within the origin that created it; (2) a `data:` URL sidesteps that origin issue but Chromium blocks top-level navigation to `data:` URLs outright (anti-phishing, ~Chrome 88+) — the tab lands on `about:blank#blocked` instead. A `blob:` URL opened via a direct anchor click from the same document that created it is the one combination that actually works. There is no Save/Print/Share UI of our own anymore — the native viewer supplies its own.
- The old `window.print()` path (`@media print` stylesheet + `beforeprint`/`afterprint` collapsible-card force-open) is kept fully functional for Ctrl+P.

### Mobile layout (<768px)

Bottom tab bar (`#mTabBar`) switches `body[data-mtab]` between `inputs`/`results`; the two `.dashboard` columns (`#colInputs`/`#colResults`) are the panes. Sticky status strip (`#mStatusStrip`) above the tab bar mirrors the banner (updated in both `recalc()` branches). There is no Calculate button — every input change recalculates live via `recalc()`; on mobile the user switches to the Results tab manually. All rules scoped to `@media (max-width: 767px)`; print forces both columns visible.

### Other key functions

- `runCalculations()` — core ASME B31.3 math; central place for calculation changes.
- `drawSvgPipe(res)` — SVG cross-section: a longitudinal wall-thickness *profile* (pipe wall unrolled into a straight strip, OD at top / nominal ID at bottom, in the `WALL_PLOT` constant's fixed pixel geometry), not a circular cutaway — the wall-loss pocket is a flat-bottomed dip with smooth shoulders (not a sharp V) drawn against horizontal limit lines (`t_req`, `t_req+CA`, `t_struct`), so a reader sees the dip visually cross a limit line when a check fails. viewBox is `0 0 500 270` — the extra width past the plot (`WALL_PLOT.right = 260`) is the leader-line label column; keep label text short enough to fit (labels are clipped in the PDF export path, which rasterizes the SVG at its exact viewBox size — unlike the live page, there's no forgiving extra width there). There is no side "wall gauge" panel — `#pipeSvg` has CSS `height: auto` so it scales by width alone at the true `500:270` ratio, filling `.svg-container` (`max-width: 900px`) rather than rendering at a fixed 500×270 and letterboxing.
- `getAdvisorItems(res)` — pure PCC-2 advisor content, shared by `updateRepairAdvisor()` (DOM) and the PDF.
- `updateDynamicEquations(res)` — on-screen equation blocks with substituted values.
- `initDragHandle()` — drag handle on the SVG adjusts wall-loss depth (vertical drag only, mapped through `WALL_PLOT`).
- `initHoverHighlighting()` / `HOVER_MAP` — cross-highlights SVG boundary/limit lines and their leader labels.

### Conventions to preserve

- Pressure entered in `bar`/`psi`, always converted to **MPa** internally (`pUnit` conversion in `runCalculations()`).
- Theme toggle sets `.dark` on **both** `body` (app CSS) and `html` (Basecoat), persisted to `localStorage`.
- Two input modes (wall-loss depth vs measured minimum) tracked via `.active` on `#modeSeg` buttons; mutually derivable (`t_meas = t_nom - depth`).
- Validation uses `aria-invalid="true"` attributes (Basecoat convention) + `.validation-alert` visibility; styled by a custom override rule, not Basecoat defaults alone.
- All numeric display formatting goes through `fmt(val, decimals)` (`—` for null/non-finite).
- Dense-engineering styling: JetBrains Mono + `tabular-nums` for all numeric values (`.res-val`, number inputs, equations), hairline borders, 12px spacing scale, `--radius: 0.5rem`. **Basecoat's `.card` ships its own 24px padding + gap** — the app zeroes those (`.card { padding: 0; gap: 0 }`) because spacing is managed via `.card-header`/`.card-body`; check for similar Basecoat spacing stacking when adopting new Basecoat components.
- Readability floor: 11px for anything meant to be actively read — field `label`s, `.hint`, `.validation-alert`, `.scope-notice`, equation legends, SVG cross-section labels. 10px is reserved for short uppercase badge/eyebrow-style text (`.res-section-title`, `.eq-status-badge`, `#mStatusStrip .m-strip-label`), where the bold weight + letter-spacing compensate. `.eq-box` (the static, non-substituted formula display) is `justify-content: flex-start` — don't recenter it; the internal `.fraction`'s own `text-align: center` is a different, necessary thing (centers the numerator/denominator over the fraction bar) and must stay.
- `.validation-alert` and `.hint` both carry real margin (6px) so an input's error message doesn't crowd the hint beneath it when both are visible at once; `.validation-alert + .hint` collapses the hint's own margin-top so the two don't double up.
- Transitions: the universal `* { transition: background-color, border-color, color, box-shadow, all 0.2s }` rule is the single source for state-change fades (focus rings, invalid-state rings, hover, theme toggle, the mobile tab bar's active-indicator box-shadow, etc.) — components should only declare their own `transition` for properties that rule doesn't cover (`transform`, SVG `r`/`stroke`/`fill`/`opacity`, `width`/`left` for gauge fills). When a state class changes a property, double-check it's actually in the relevant transition list — `.drag-handle.dragging` changing `stroke` without `stroke` in `.drag-handle`'s transition list was exactly this bug (fixed).
- Code-compliance box (`.compliance-box`, ids `compB313`/`comp574`/`ffsNote`): PASS/FAIL per ASME B31.3 (margin ≥ 0) and API RP 574 (t_meas ≥ t_struct), updated in both `recalc()` branches; when either fails, an API 579-1/B31G FFS recommendation note is shown (and mirrored in the PDF results section).
- Semantic status colors (`--ok-color`/`--warn-color`/`--danger-color`) and cross-section limit colors (`--limit-reqca`/`--limit-req`/`--limit-struct`) are CSS variables in `:root`/`body.dark`, each tuned per-theme — never hardcode their hex values in CSS or SVG attributes (the pressure gauge zones and cross-section limit lines/labels once did, which silently pinned them to one theme's shade regardless of which theme was active; a stray `[data-theme="dark"]` selector on the ERF gauge pointer/tip was dead CSS for the same reason, since theme is toggled via `.dark` on `body`/`html`, not a `data-theme` attribute — the pointer stayed black in dark mode until fixed to `var(--text-color)`). The `--limit-*` values are deliberately dark/saturated 700–800-tier shades (not the brighter 500-tier line colors elsewhere) so 11px bold SVG label text clears WCAG AA (4.5:1) against the near-white `--svg-bg` — this matters most for the PDF/print export, which always uses the light-theme values via the injected style block in `svgToPngDataUrl` (keep that block's hardcoded hex list in sync if `--limit-*`/`--svg-*` light values ever change).
- `SCOPE_HTML`/`SCOPE_TEXT` is the single source for the Scope & Limitations text (DOM notice + PDF section) — edit it in one place only.
