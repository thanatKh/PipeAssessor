/* ============================================================================
   Repair Advisor — a standalone, always-available recommendation tool keyed by
   finding/damage type, no longer nested inside (or gated by) the ASME B31.3
   assessment. For the four wall-loss types (WALL_LOSS_TYPES) a live B31.3
   result — when available — REPLACES the generic type guidance with today's
   precise numeric recommendation (paAdvisorItems, unchanged logic, moved here
   from the old embedded advisor). Non-wall-loss types always get their own
   dedicated content, regardless of any stray B31.3 result.

   Leaking is orthogonal to finding type (a corrosion/dent/CUI finding can
   independently be actively leaking or not — it is NOT its own finding type,
   see core/constants.ts), so it's modeled as a separate `isLeaking` flag:
   resolveAdvisor prepends LEAKING_OVERLAY's safety-first items on top of
   whatever the base finding type resolves to, whenever isLeaking is true.

   Content review note: the guidance for the non-wall-loss types (Coating,
   Pipe Support Defect, Dent, Other) and the leaking overlay is a best-effort
   draft grounded in standards believed relevant (SSPC/NACE, API 570/579-1/583,
   PCC-2 Parts 3/4/6) — not verified domain expertise. Flagged with needsReview
   for an engineer's sign-off pass; safe to ship as general guidance meanwhile.
   ============================================================================ */
import type { B313Result } from '../types/models';
import { WALL_LOSS_TYPES } from '../core/constants';

export interface AdvisorItem {
  title: string;
  body: string;
  sub: string[];
}

export interface FindingAdvisorEntry {
  /** One-line framing shown as the panel's lead-in. */
  summary: string;
  items: AdvisorItem[];
  /** Optional short standards citation line. */
  standardsNote?: string;
  /** Content that should get an engineer's sign-off pass before being treated as authoritative. */
  needsReview?: boolean;
}

export interface ResolvedAdvisor extends FindingAdvisorEntry {
  /** true when items came from a live B31.3 result rather than the generic type table. */
  isNumeric: boolean;
}

/* Pure PCC-2 advisor content, driven purely by a computeB313 result — unchanged from the
   pre-refactor version, just relocated. Used only for the four WALL_LOSS_TYPES once a valid
   result is available; see resolveAdvisor below for the precedence rule. */
export function paAdvisorItems(res: B313Result | null | undefined): AdvisorItem[] {
  if (!res || res.hasErrors) {
    return [{ title: '', body: 'ยังไม่มีผลการคำนวณ กรุณาแก้ไขข้อผิดพลาดแล้วคำนวณใหม่', sub: [] }];
  }

  if (res.status === 'OK') {
    return [
      { title: 'ความสอดคล้องตาม PCC-2:', body: 'ความหนาผนังท่อสูงกว่าขีดจำกัดออกแบบรวมค่าเผื่อการกัดกร่อน ไม่จำเป็นต้องซ่อมแซมโครงสร้าง', sub: [] },
      { title: 'คำแนะนำการตรวจติดตาม:', body: 'รักษาความถี่การตรวจสอบตามปกติ และติดตามแนวโน้มการสูญเสียความหนาที่ระดับ Nominal', sub: [] }
    ];
  }

  if (res.status === 'MONITOR') {
    const items: AdvisorItem[] = [];
    if (res.t_meas < res.t_struct) {
      items.push({ title: 'ความแข็งแรงเชิงโครงสร้าง (API 574):', body: 'ความหนาที่เหลืออยู่ต่ำกว่าเกณฑ์ขั้นต่ำเชิงโครงสร้าง ให้ตรวจสอบช่วงพาดท่อว่ามีการแอ่นตัวหรือไม่ และตรวจสอบระยะห่างของ Support เพื่อป้องกันการโก่งงอหรือวิบัติ', sub: [] });
    }
    items.push(
      { title: 'แผนการตรวจติดตาม:', body: 'ติดตามแนวโน้มความหนาด้วยการวัด UT แบบ Grid เฉพาะจุด และตรวจสอบอัตราการกัดกร่อน (Corrosion Rate)', sub: [] },
      { title: 'การป้องกัน (PCC-2 Part 5):', body: 'ปรับปรุงความสมบูรณ์ของ Coating ภายนอกหรือระบบ Cathodic Protection เพื่อลดการกัดกร่อนเฉพาะจุด', sub: [] },
      { title: '', body: 'วางแผนประเมินซ้ำก่อนถึงรอบหยุดซ่อมบำรุงครั้งถัดไป', sub: [] }
    );
    return items;
  }

  // REPAIR Status Recommendations
  const items: AdvisorItem[] = [];
  const pctLoss = (1 - (res.t_meas / res.t_nom)) * 100;
  if (pctLoss > 80) {
    items.push({ title: 'วิกฤต (PCC-2 Part 3):', body: 'การสูญเสียเนื้อโลหะเกิน 80% ของความหนา Nominal แนะนำให้เปลี่ยนท่อทั้งท่อนโดยเร็ว', sub: [] });
  }
  items.push(
    { title: 'Composite Repair (PCC-2 Part 2):', body: 'สามารถใช้วัสดุห่อหุ้มชนิดไม่ใช่โลหะที่ผ่านการออกแบบทางวิศวกรรม (เช่น Carbon Fiber/Epoxy) กับจุดบกพร่องที่ไม่มีการรั่วไหล เพื่อคืนความสามารถในการรับความดัน', sub: [] },
    { title: 'Welded Repair (PCC-2 Part 3):', body: '', sub: [
      'Type B Full-Encirclement Split Sleeve ออกแบบให้รับความดันได้เต็มพิกัด',
      'การเชื่อมพอกเนื้อโลหะ (ต้องมี WPS/PQR ที่ผ่านการรับรอง, Pre-heat ก่อนเชื่อม, และ NDT หลังเชื่อม)'
    ] },
    { title: 'Mechanical Repair (PCC-2 Part 4):', body: 'ใช้ Mechanical Clamp ที่ผ่านการออกแบบทางวิศวกรรม หรือกล่องครอบป้องกันการรั่วไหล (เหมาะเมื่อมีข้อจำกัดด้าน Hot Work หรือการเชื่อม)', sub: [] }
  );
  return items;
}

const STATUS_SUMMARY: Record<B313Result['status'], string> = {
  OK: 'ความหนาผนังท่ออยู่ในเกณฑ์ที่ยอมรับได้ — ยังไม่จำเป็นต้องซ่อมแซมตามค่าที่วัดได้ในขณะนี้',
  MONITOR: 'ใกล้ถึงขีดจำกัดด้านออกแบบ/โครงสร้าง — เพิ่มความถี่การตรวจติดตามและวางแผนประเมินซ้ำ',
  REPAIR: 'ต่ำกว่าเกณฑ์ที่ยอมรับได้ — วางแผนซ่อมแซมตามแนวทางด้านล่าง'
};

/* Generic, always-available guidance shown for a wall-loss finding type before a valid B31.3
   result exists yet (no reading entered, panel off, or the current inputs have errors). */
const WALL_LOSS_PENDING_ENTRY: FindingAdvisorEntry = {
  summary: 'กลไกการสูญเสียความหนาผนังท่อ — ต้องมีค่าที่วัดได้จาก UT จึงจะให้คำแนะนำที่แม่นยำได้',
  items: [
    { title: 'ขั้นตอนถัดไป:', body: 'บันทึกค่าความหนาที่วัดได้จาก UT แล้วทำการประเมินตาม ASME B31.3 เพื่อรับคำแนะนำการซ่อมแซมที่แม่นยำ (Composite Repair, Welded Sleeve, Mechanical Clamp หรือเปลี่ยนท่อ — คัดเลือกตามเปอร์เซ็นต์ความหนาที่เหลืออยู่ ตาม PCC-2 Parts 2–4)', sub: [] }
  ]
};

/* Safety-first guidance prepended to whatever the base finding type resolves to, whenever the
   "Actively Leaking" flag is set — see resolveAdvisor's isLeaking parameter below. Independent of
   finding type: applies the same whether the underlying damage is corrosion, a dent, CUI, etc. */
const LEAKING_OVERLAY: FindingAdvisorEntry = {
  summary: 'ข้อค้นพบที่เกี่ยวข้องกับความปลอดภัย — ตรวจสอบสถานะการแยกระบบก่อนวางแผนซ่อมแซม',
  standardsNote: 'คำแนะนำทั่วไปตาม API 570 และขั้นตอนฉุกเฉินของหน่วยงาน — โปรดตรวจสอบกับเอกสารขั้นตอนตอบสนองเหตุฉุกเฉินของหน่วยงานของท่าน',
  needsReview: true,
  items: [
    { title: 'Immediate Safety:', body: 'ตรวจสอบสถานะการแยกระบบ/ควบคุมการรั่วไหล และยืนยันว่าได้รายงานการรั่วไหลตามขั้นตอนฉุกเฉินของหน่วยงานแล้ว ก่อนวางแผนซ่อมแซม', sub: [] },
    { title: 'Root Cause:', body: 'ตรวจสอบว่าการรั่วไหลเกิดจากจุดบกพร่องด้านความหนาผนังท่อ (ให้ทำการประเมิน B31.3 หากมีค่าที่วัดจาก UT) ข้อต่อ/Gasket ชำรุด หรือรอยแตกร้าว — วิธีซ่อมแซมขึ้นอยู่กับสาเหตุ', sub: [] },
    { title: 'Interim Containment (PCC-2 Part 4):', body: 'อาจใช้ Leak Containment Clamp แบบยึดด้วยสลักเกลียวเป็นมาตรการชั่วคราวเท่านั้น โดยต้องออกแบบให้รับความดันออกแบบของท่อได้ ระหว่างรอการซ่อมแซมถาวร', sub: [] },
    { title: 'Spool Replacement:', body: 'หากไม่สามารถซ่อมแซมจุดรั่วไหลในตำแหน่งเดิมได้อย่างน่าเชื่อถือ (ความเสียหายรุนแรง/ทะลุผนังท่อ, รูปทรงไม่เหมาะกับ Sleeve/Clamp หรือมีการรั่วไหลซ้ำที่ตำแหน่งเดิม) ให้ตัดและเปลี่ยนท่อช่วงที่เสียหาย', sub: [] }
  ]
};

/* Per-finding-type advisor content for the non-wall-loss FINDING_TYPES entries, plus a
   CUI/CUS-specific procedural note layered onto the shared wall-loss pending entry above. */
export const REPAIR_ADVISOR_BY_FINDING: Record<string, FindingAdvisorEntry> = {
  'CUI (Corrosion Under Insulation)': {
    summary: WALL_LOSS_PENDING_ENTRY.summary,
    items: [
      ...WALL_LOSS_PENDING_ENTRY.items,
      { title: 'ข้อสังเกตการเข้าถึง:', body: 'โดยทั่วไปต้องรื้อ Insulation/Cladding ออกที่ตำแหน่งพบข้อบกพร่องก่อน จึงจะสามารถวัดค่าได้', sub: [] }
    ]
  },
  'CUS (Corrosion Under Support)': {
    summary: WALL_LOSS_PENDING_ENTRY.summary,
    items: [
      ...WALL_LOSS_PENDING_ENTRY.items,
      { title: 'ข้อสังเกตการเข้าถึง:', body: 'โดยทั่วไปต้องผ่อนคลาย Support ชั่วคราวหรือถอด Clamp ออกที่ตำแหน่งพบข้อบกพร่องก่อน จึงจะสามารถวัดค่าได้', sub: [] }
    ]
  },

  'Coating / Painting Damage': {
    summary: 'ความเสียหายของ Coating/สี — โดยตัวมันเองไม่ใช่การซ่อมแซมส่วนที่รับความดัน',
    standardsNote: 'คำแนะนำทั่วไปตามแนวปฏิบัติ SSPC/NACE สำหรับการซ่อม Coating ไม่ใช่หัวข้อของ ASME PCC-2 (PCC-2 ครอบคลุมการซ่อมส่วนที่รับความดัน ไม่ใช่ Coating)',
    needsReview: true,
    items: [
      { title: 'Surface Prep & Recoat:', body: 'ทำความสะอาดเฉพาะจุดตามระดับ Surface Prep ที่กำหนด (ตามมาตรฐาน SSPC-SP) แล้วเคลือบด้วยระบบที่เข้ากันได้กับ Coating เดิม ก่อนที่โลหะฐานจะเริ่มเกิดการกัดกร่อน', sub: [] },
      { title: 'Inspect Substrate:', body: 'ตรวจสอบว่ายังไม่มีการกัดกร่อนเกิดขึ้นใต้ Coating ที่เสียหาย หากพบการสูญเสียเนื้อโลหะ ให้บันทึกเป็นข้อค้นพบประเภทการกัดกร่อนแยกต่างหาก และทำการประเมินความหนาผนังท่อสำหรับข้อค้นพบนั้น', sub: [] },
      { title: 'CUI Risk Check:', body: 'หากความเสียหายอยู่ใต้ Insulation ให้พิจารณาเป็นพื้นที่เสี่ยง CUI ตาม API 583 และจัดลำดับความสำคัญในการตรวจสอบ', sub: [] }
    ]
  },

  'Pipe Support Defect': {
    summary: 'ความบกพร่องของ Support — อยู่นอกขอบเขตของ ASME PCC-2 (เป็นเรื่องโครงสร้าง ไม่ใช่ส่วนรับความดัน)',
    standardsNote: 'คำแนะนำทั่วไปตามแนวปฏิบัติการตรวจสอบสภาพ Support ของ API 570 และประเภท Support ตาม MSS SP-58/SP-69 — ยังไม่ได้รับการยืนยันจากผู้เชี่ยวชาญ โปรดตรวจสอบมาตรฐานที่ใช้บังคับกับหน่วยงานของท่าน',
    needsReview: true,
    items: [
      { title: 'Inspect for Loss of Function:', body: 'ตรวจสอบว่ามี Shoe ชำรุด/หายไป, Hanger Rod หัก, Roller ติดขัด หรือช่วงพาดท่อแอ่นตัวหรือไม่', sub: [] },
      { title: 'Verify Span & Sag:', body: 'เปรียบเทียบช่วงพาดท่อที่อยู่ติดกันกับเกณฑ์ระยะห่าง Support/การแอ่นตัวตาม API 570', sub: [] },
      { title: 'Correct or Replace:', body: 'ซ่อมแซมหรือเปลี่ยน Support ตามแบบเดิม ก่อนที่จะก่อให้เกิดความเค้นเพิ่มเติมต่อแนวท่อ', sub: [] }
    ]
  },

  'Dent / Mechanical Damage': {
    summary: 'ข้อบกพร่องด้านรูปทรง — ไม่สามารถประเมินได้ด้วยการคำนวณความหนาผนังท่อเพียงอย่างเดียว',
    standardsNote: 'คำแนะนำทั่วไปตาม ASME PCC-2 Part 3 และเกณฑ์การยอมรับ Dent ตาม API 579-1/ASME FFS-1 Part 5',
    needsReview: true,
    items: [
      { title: 'Dent Assessment (API 579-1/ASME FFS-1 Part 5, PCC-2 Part 3):', body: 'ความลึกของ Dent การมี Gouge หรือรอยเชื่อมร่วมด้วย และความเข้มข้นของ Strain ล้วนส่งผลต่อความเหมาะสมในการใช้งาน Dent ที่มี Gouge ร่วมด้วยหรืออยู่ใกล้แนวเชื่อมมีความเสี่ยงสูงกว่า', sub: [] },
      { title: 'Secondary Check:', body: 'หากมีการบางลงของผนังท่อที่วัดได้บริเวณ Dent ด้วย ให้บันทึกค่าความหนาและทำการประเมิน B31.3 เป็นการตรวจสอบเพิ่มเติม — แต่ยังคงต้องมีการประเมิน FFS เฉพาะสำหรับรูปทรงของ Dent นั้นด้วย', sub: [] },
      { title: 'Repair Options (PCC-2 Part 3/4):', body: 'การเชื่อมพอกเนื้อ/เจียร Gouge ที่เกี่ยวข้อง (หากตื้นและเป็นไปตามที่มาตรฐานอนุญาต) หรือใช้ Full-Encirclement Sleeve ขึ้นอยู่กับผลการประเมิน FFS', sub: [] },
      { title: 'Spool Replacement:', body: 'กรณีผลการประเมิน FFS ไม่ผ่านเกณฑ์ (ความลึก/Strain เกินกำหนด, มีรอยแตกร้าวร่วมด้วย หรือไม่ผ่านเกณฑ์การยอมรับ) ให้เปลี่ยนท่อช่วงที่เสียหายแทนการซ่อมแซมในตำแหน่งเดิม', sub: [] }
    ]
  },

  'Other': {
    summary: 'ประเภทข้อค้นพบยังไม่ได้จัดหมวดหมู่การซ่อมแซมเฉพาะ',
    items: [
      { title: 'ขั้นตอนถัดไป:', body: 'บันทึกรายละเอียดความผิดปกติให้ครบถ้วน (รูปถ่าย, ขนาด, ตำแหน่ง) และปรึกษาวิศวกรด้านท่อ/วัสดุ เพื่อกำหนดแนวทางมาตรฐานที่เหมาะสม (ASME PCC-2, API 579-1/FFS-1 หรือการทบทวนพื้นฐานการออกแบบ) ก่อนวางแผนซ่อมแซม', sub: [] }
    ]
  }
};

/**
 * Resolve the advisor content for a finding type, optionally informed by a live B31.3 result and
 * whether the finding is actively leaking (orthogonal to finding type — see core/constants.ts).
 *
 * Precedence for the base entry:
 *  1. Wall-loss type + valid (non-null, non-errored) result → precise numeric advice (paAdvisorItems).
 *  2. Wall-loss type + no/errored result → generic "record a reading" entry (with CUI/CUS access note).
 *  3. Non-wall-loss type → its own dedicated entry, regardless of any stray B31.3 result.
 *  4. Empty/unknown finding type → null (caller renders an empty-state prompt).
 *
 * When isLeaking is true, LEAKING_OVERLAY's items are prepended to the base entry's items (the
 * base entry's own summary stays the lead line — avoids juggling two summary strings).
 */
export function resolveAdvisor(findingType: string | null | undefined, res: B313Result | null | undefined, isLeaking?: boolean): ResolvedAdvisor | null {
  if (!findingType) return null;

  let base: ResolvedAdvisor;
  if (WALL_LOSS_TYPES.includes(findingType)) {
    if (res && !res.hasErrors) {
      base = { summary: STATUS_SUMMARY[res.status], items: paAdvisorItems(res), isNumeric: true };
    } else {
      const pending = REPAIR_ADVISOR_BY_FINDING[findingType] || WALL_LOSS_PENDING_ENTRY;
      base = { ...pending, isNumeric: false };
    }
  } else {
    const entry = REPAIR_ADVISOR_BY_FINDING[findingType];
    if (!entry) return null;
    base = { ...entry, isNumeric: false };
  }

  if (!isLeaking) return base;
  return {
    ...base,
    items: [...LEAKING_OVERLAY.items, ...base.items],
    standardsNote: [LEAKING_OVERLAY.standardsNote, base.standardsNote].filter(Boolean).join(' '),
    needsReview: base.needsReview || LEAKING_OVERLAY.needsReview
  };
}

function escHtml(s: string): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Render resolved advisor content into `root` (full innerHTML replace — no internal state, so a
 * plain render function is the right level of ceremony; unlike paCreateAssessView there's no
 * drag handle or hover-highlight to preserve across renders).
 */
export function paRenderRepairAdvisor(root: HTMLElement, findingType: string | null | undefined, res: B313Result | null | undefined, isLeaking?: boolean): void {
  const resolved = resolveAdvisor(findingType, res, isLeaking);
  if (!resolved) {
    root.innerHTML = '<p class="hint" style="margin:0;">เลือกประเภทข้อค้นพบเพื่อดูคำแนะนำการซ่อมแซม</p>';
    return;
  }

  const itemsHtml = resolved.items.map(item => {
    const lead = item.title ? `<strong>${escHtml(item.title)}</strong> ` : '';
    const subList = item.sub.length ? `<ul>${item.sub.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>` : '';
    return `<li>${lead}${escHtml(item.body)}${subList}</li>`;
  }).join('');

  const noteHtml = resolved.standardsNote
    ? `<p class="hint" style="margin:8px 0 0;">${escHtml(resolved.standardsNote)}${resolved.needsReview ? ' <em>(คำแนะนำทั่วไป — โปรดตรวจสอบกับมาตรฐานทางวิศวกรรมของโครงการ)</em>' : ''}</p>`
    : '';

  root.innerHTML = `
    <p class="hint" style="margin:0 0 10px;">${escHtml(resolved.summary)}</p>
    <ul class="advisor-list">${itemsHtml}</ul>
    ${noteHtml}`;
}
