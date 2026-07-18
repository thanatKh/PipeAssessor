<h1>Pipe Assessor – v15</h1>

<p>
    Pipe Assessor is a web-based tool designed to evaluate the integrity of pipes with metal loss, based on the <strong>ASME B31.3</strong> code for pressure piping. It helps users determine if a pipe's remaining wall thickness meets the required standards and provides an estimated remaining life and repair recommendations. The tool is particularly useful for field engineers and inspectors during integrity assessments.
</p>

<hr>

<h2>Features</h2>
<ul>
    <li><strong>Dual Input Modes:</strong> Users can input either the <strong>wall loss depth</strong> (in mm) or the <strong>measured minimum wall thickness</strong> ($t_{meas}$) directly. The app automatically calculates the other value.</li>
    <li><strong>ASME B31.3 Compliance:</strong> The tool's calculations are based on the formulas provided in the ASME B31.3 pressure piping code, including the required thickness equation and Maximum Allowable Working Pressure (MAWP) calculation.</li>
    <li><strong>Visual Representation:</strong> A graphical output shows the relationship between the nominal wall thickness, measured thickness, and the required thickness (including corrosion allowance) for a clear, at-a-glance assessment.</li>
    <li><strong>Status &amp; Warnings:</strong> The tool provides a clear status (<strong>OK</strong>, <strong>MONITOR</strong>, or <strong>REPAIR</strong>) and relevant warnings based on a calculated margin between the measured and required thickness.</li>
    <li><strong>Repair Advisor:</strong> The application offers repair recommendations based on the pipe's status, referencing <strong>ASME PCC-2</strong> categories (e.g., composite wraps, welded sleeves, mechanical clamps).</li>
    <li><strong>Remaining Life Calculation:</strong> By entering a corrosion rate (CR), the tool can estimate the remaining life of the pipe until it reaches its minimum required thickness.</li>
    <li><strong>Printable PDF Report:</strong> The results, including all inputs and calculations, can be saved as a clean, single-page PDF report.</li>
</ul>

<hr>

<h2>Developing</h2>
<p>
    On the <code>refactor/vite-migration</code> branch the app is a <strong>Vite + Vanilla-TypeScript</strong> build. Install dependencies once with <code>npm install</code>, then:
</p>
<ul>
    <li><code>npm run dev</code> — start the Vite dev server (hot reload).</li>
    <li><code>npm run build</code> — produce the production bundle in <code>dist/</code>.</li>
    <li><code>npm run preview</code> — serve the built <code>dist/</code> locally.</li>
    <li><code>npm run typecheck</code> — run the TypeScript checker.</li>
    <li><code>npm run test</code> — run the ASME B31.3 engine numeric-identity test (Vitest).</li>
</ul>
<p>
    The heavy libraries (jsPDF, SheetJS) are loaded on demand, so they only download when a report or spreadsheet is actually generated. Full functionality requires sign-in and a network connection (Supabase). See <code>CLAUDE.md</code> for the module layout.
</p>

<h2>Usage</h2>
<p>
    In the app, follow these steps:
</p>
<ol>
    <li><strong>Header Meta:</strong> Enter the pipe's identifying information, such as <strong>Tag</strong>, <strong>Location</strong>, and <strong>P&amp;ID</strong>.</li>
    <li><strong>Inputs:</strong>
        <ul>
            <li>Select the <strong>Nominal Pipe Size (NPS)</strong> and <strong>Schedule</strong> from the dropdown menus. The tool uses a subset of ASME B36.10M data for pipe dimensions.</li>
            <li>Choose your input mode: <strong>Wall loss depth</strong> or <strong>Measured minimum</strong> thickness.</li>
            <li>Enter the measured thickness or wall loss depth, along with the <strong>Corrosion Allowance (CA)</strong>.</li>
            <li>Input the <strong>Design Pressure (P)</strong>, <strong>Allowable Stress (S)</strong>, and other factors as required by ASME B31.3 ($E, W, Y$).</li>
            <li>(Optional) Enter a <strong>Corrosion Rate (CR)</strong> to calculate the estimated remaining life.</li>
        </ul>
    </li>
    <li><strong>Calculation:</strong> Click the <strong>Calculate</strong> button to perform the assessment. The results, graphs, and recommendations will be displayed in the sections below.</li>
    <li><strong>Save:</strong> Click <strong>Save as PDF</strong> to generate a printable report.</li>
</ol>

<hr>

<h2>Equations</h2>
<p>
    The core calculations are based on the ASME B31.3 code for internal pressure design. The required thickness ($t$) is calculated using the following formulas:
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
    <li>$Y$ = Coefficient from B31.3 table</li>
</ul>

<h4>Maximum Allowable Working Pressure (MAWP)</h4>
<p>
    The MAWP is a re-arranged version of the required thickness equation:
</p>
<p>
    $$P = \frac{2SEWt}{D - 2Yt}$$
</p>
<p>
    The tool calculates two MAWP values:
</p>
<ul>
    <li>MAWP (with CA): Uses the thickness value of $t_{use} = t_{meas} - CA$.</li>
    <li>MAWP (no CA): Uses the thickness value of $t_{use} = t_{meas}$.</li>
</ul>
<p>
    <strong>Note:</strong> The application handles the unit conversions between bar (for user input) and MPa (for calculations).
</p>

<hr>

<h2>Libraries and Dependencies</h2>
<p>
    This application is self-contained within a single HTML file and does not rely on external libraries or frameworks. It uses standard HTML, CSS, and JavaScript.
</p>

<hr>

<h2>License</h2>
<p>
    This project is not licensed. Feel free to use and modify it for your own purposes.
</p>

</body>
</html>
