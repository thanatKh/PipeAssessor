/* ============================================================================
   Repair Advisor — a standalone, always-available recommendation tool keyed by
   finding/damage type, no longer nested inside (or gated by) the ASME B31.3
   assessment. For the four wall-loss types (WALL_LOSS_TYPES) a live B31.3
   result — when available — REPLACES the generic type guidance with today's
   precise numeric recommendation (paAdvisorItems). That recommendation is both
   status-aware (OK / MONITOR / REPAIR) AND mechanism-aware: it takes the finding
   type so External / Internal / CUI / CUS corrosion each get remediation matched
   to the damage (external removal+recoat vs. internal process-side control vs.
   CUI insulation restoration vs. CUS support-detail fix). At OK it still calls
   out arresting the active corrosion (removal → recoat), and at REPAIR it always
   offers Replacement / Spool Replacement as an option, not only above 80% loss.
   Non-wall-loss types always get their own dedicated content, regardless of any
   stray B31.3 result.

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

/* The four WALL_LOSS_TYPES are all corrosion mechanisms, but the remediation differs by WHERE the
   metal loss is and WHAT drives it, so advice must be mechanism-aware — not one-size-fits-all:
    - external : surface corrosion, arrested by removal + recoat (+ CP).
    - cui      : external-under-insulation; also needs insulation/cladding + weatherproofing restored.
    - cus      : external-at-support; also needs the support detail fixed so water can't pool again.
    - internal : loss is on the bore — external coating does nothing; must be addressed process-side. */
type CorrMech = 'external' | 'internal' | 'cui' | 'cus';

function corrMechOf(findingType?: string | null): CorrMech {
  if (findingType === 'Internal Corrosion') return 'internal';
  if (findingType && findingType.startsWith('CUI')) return 'cui';
  if (findingType && findingType.startsWith('CUS')) return 'cus';
  return 'external';
}

/* Per-mechanism remediation phrasing, kept self-contained (each body is a full sentence) so it can
   be dropped into any status section without grammar-stitching. `arrest` = how to stop the active
   mechanism (used at OK/MONITOR, where the wall itself is still acceptable); `cleanAccess` = how to
   expose/clean the defect so its true extent is known before a REPAIR method is chosen;
   `postRepair` = how to stop recurrence after a structural repair is placed. */
const CORR_MITIGATION: Record<CorrMech, { label: string; arrest: string; cleanAccess: string; postRepair: string }> = {
  external: {
    label: 'ขจัดการกัดกร่อนและซ่อม Coating (External):',
    arrest: 'ขจัดสนิม/ผลิตภัณฑ์การกัดกร่อนออกจนถึงเนื้อโลหะดี (Surface Prep ตาม SSPC-SP) วัดความหนาที่เหลือซ้ำหลังทำความสะอาด แล้วเคลือบ Coating ระบบใหม่ที่เข้ากันได้เพื่อหยุดยั้งการกัดกร่อนต่อเนื่อง พร้อมตรวจสอบระบบ Cathodic Protection (ถ้ามี)',
    cleanAccess: 'ขจัดผลิตภัณฑ์การกัดกร่อนออกจนถึงเนื้อโลหะดีก่อน แล้ววัด UT ซ้ำเพื่อกำหนดขอบเขตและความลึกที่แท้จริงของข้อบกพร่อง ก่อนเลือกวิธีซ่อม',
    postRepair: 'หลังซ่อม ให้เคลือบ Coating ระบบใหม่ทับบริเวณที่ซ่อมและพื้นที่ข้างเคียง และตรวจสอบ Cathodic Protection เพื่อป้องกันการกัดกร่อนเกิดซ้ำ'
  },
  cui: {
    label: 'ขจัดการกัดกร่อนและฟื้นฟูระบบป้องกัน (CUI):',
    arrest: 'รื้อ Insulation/Cladding ออก ขจัดการกัดกร่อนจนถึงเนื้อโลหะดี วัดความหนาซ้ำ เคลือบ Coating ทนอุณหภูมิที่เหมาะสม แล้วติดตั้ง Insulation/Cladding และระบบกันน้ำ (Weatherproofing) กลับให้สมบูรณ์เพื่อป้องกันน้ำซึม ตาม API 583 — หากตำแหน่งนี้ไม่จำเป็นต้องมีฉนวน พิจารณาถอดออกถาวร',
    cleanAccess: 'รื้อ Insulation/Cladding ออกให้พ้นบริเวณกัดกร่อน ขจัดผลิตภัณฑ์การกัดกร่อนจนถึงเนื้อโลหะดี แล้ววัด UT ซ้ำเพื่อกำหนดขอบเขตข้อบกพร่องที่แท้จริง ก่อนเลือกวิธีซ่อม',
    postRepair: 'หลังซ่อม ให้เคลือบ Coating ใหม่ แล้วติดตั้ง Insulation/Cladding และระบบกันน้ำกลับให้สมบูรณ์ตาม API 583 เพื่อป้องกัน CUI เกิดซ้ำ'
  },
  cus: {
    label: 'ขจัดการกัดกร่อนและปรับปรุงจุดรองรับ (CUS):',
    arrest: 'ผ่อน/ถอด Support เพื่อเข้าถึง ขจัดการกัดกร่อนจนถึงเนื้อโลหะดี วัดความหนาซ้ำ เคลือบ Coating ใหม่ แล้วปรับปรุงรายละเอียดจุดรองรับ (ติดตั้งแผ่นรอง/Isolation Pad, ยกท่อให้พ้นจุดสะสมน้ำ, ปรับปรุงการระบายน้ำ) เพื่อไม่ให้เกิดการกัดกร่อนซ้ำที่ตำแหน่งเดิม',
    cleanAccess: 'ผ่อน/ถอด Support เพื่อเข้าถึงจุดกัดกร่อน ขจัดผลิตภัณฑ์การกัดกร่อนจนถึงเนื้อโลหะดี แล้ววัด UT ซ้ำเพื่อกำหนดขอบเขตข้อบกพร่องที่แท้จริง ก่อนเลือกวิธีซ่อม',
    postRepair: 'หลังซ่อม ให้เคลือบ Coating ใหม่ และปรับปรุงรายละเอียดจุดรองรับ (แผ่นรอง/Isolation Pad, ยกท่อพ้นจุดสะสมน้ำ, ปรับการระบายน้ำ) เพื่อไม่ให้เกิดการกัดกร่อนซ้ำ'
  },
  internal: {
    label: 'ควบคุมการกัดกร่อนภายใน (Internal):',
    arrest: 'การกัดกร่อนอยู่ที่ผิวในซึ่งการเคลือบภายนอกไม่ช่วยหยุดยั้ง ต้องแก้ที่ต้นเหตุด้านกระบวนการ เช่น การเติมสารยับยั้งการกัดกร่อน (Corrosion Inhibitor), การกำจัดน้ำ/ตะกอน (Dewatering/Pigging), การควบคุมความเร็วการไหล และพิจารณาบุผิวภายใน (Internal Lining) หากเหมาะสม',
    cleanAccess: 'การกัดกร่อนอยู่ผิวในจึงไม่สามารถขจัดจากภายนอกได้ — ใช้การทำ UT Mapping/Grid หรือ Profile Radiography เพื่อกำหนดขอบเขตและความลึกของข้อบกพร่องก่อนเลือกวิธีซ่อม',
    postRepair: 'หลังซ่อม ต้องแก้ที่ต้นเหตุด้านกระบวนการ (Corrosion Inhibitor, Dewatering/Pigging, ควบคุมความเร็วการไหล) เพื่อไม่ให้การกัดกร่อนภายในดำเนินต่อและทำให้การซ่อมเสียหายซ้ำ',
  }
};

/* PCC-2 / API-driven advisor content, now mechanism-aware (see CORR_MITIGATION) and driven by a
   computeB313 result. `findingType` selects the corrosion mechanism so the remediation matches the
   damage; when omitted it defaults to the external-surface case. Used for the four WALL_LOSS_TYPES
   once a valid result exists (see resolveAdvisor for the precedence rule). */
export function paAdvisorItems(res: B313Result | null | undefined, findingType?: string | null): AdvisorItem[] {
  if (!res || res.hasErrors) {
    return [{ title: '', body: 'ยังไม่มีผลการคำนวณ กรุณาแก้ไขข้อผิดพลาดแล้วคำนวณใหม่', sub: [] }];
  }

  const mech = CORR_MITIGATION[corrMechOf(findingType)];

  if (res.status === 'OK') {
    // Wall thickness passes, but a corrosion finding means the mechanism is still live — arresting
    // it (removal + recoat / process control) is the actual action here, not just "keep watching".
    return [
      { title: 'ความสอดคล้องด้านความดัน (PCC-2):', body: 'ความหนาผนังท่อสูงกว่าขีดจำกัดออกแบบรวมค่าเผื่อการกัดกร่อน ยังไม่จำเป็นต้องซ่อมแซมส่วนรับความดันในขณะนี้ — อย่างไรก็ตาม กลไกการกัดกร่อนยังดำเนินอยู่และต้องได้รับการหยุดยั้งเพื่อไม่ให้ลุกลาม', sub: [] },
      { title: mech.label, body: mech.arrest, sub: [] },
      { title: 'การตรวจติดตาม:', body: 'รักษาความถี่การตรวจสอบตามปกติ และติดตามแนวโน้มการสูญเสียความหนาที่ระดับ Nominal พร้อมทวนสอบอัตราการกัดกร่อน (Corrosion Rate) หลังการหยุดยั้งกลไก', sub: [] }
    ];
  }

  if (res.status === 'MONITOR') {
    const items: AdvisorItem[] = [];
    if (res.t_meas < res.t_struct) {
      items.push({ title: 'ความแข็งแรงเชิงโครงสร้าง (API 574):', body: 'ความหนาที่เหลืออยู่ต่ำกว่าเกณฑ์ขั้นต่ำเชิงโครงสร้าง ให้ตรวจสอบช่วงพาดท่อว่ามีการแอ่นตัวหรือไม่ และตรวจสอบระยะห่างของ Support เพื่อป้องกันการโก่งงอหรือวิบัติ', sub: [] });
    }
    items.push(
      { title: 'ใกล้ถึงขีดจำกัด — เร่งหยุดยั้งการกัดกร่อน:', body: 'ความหนาเข้าใกล้ขีดจำกัดออกแบบ/โครงสร้าง การหยุดยั้งกลไกการกัดกร่อนตั้งแต่ตอนนี้จะช่วยยืดอายุการใช้งานและอาจหลีกเลี่ยงการซ่อมเชิงโครงสร้างได้', sub: [] },
      { title: mech.label, body: mech.arrest, sub: [] },
      { title: 'แผนการตรวจติดตาม:', body: 'ติดตามแนวโน้มความหนาด้วยการวัด UT แบบ Grid เฉพาะจุด และทวนสอบอัตราการกัดกร่อน (Corrosion Rate) เพื่อยืนยันว่าการหยุดยั้งได้ผล', sub: [] },
      { title: '', body: 'วางแผนประเมินซ้ำก่อนถึงรอบหยุดซ่อมบำรุงครั้งถัดไป และเตรียมแผนซ่อมสำรองไว้หากแนวโน้มยังลดลงต่อเนื่อง', sub: [] }
    );
    return items;
  }

  // REPAIR status: metal loss is below the acceptable limit — a repair method must be selected.
  // Every option below is legitimate; Replacement is always offered (not only at >80% loss) so the
  // engineer weighs a permanent fix against a reinforcing/temporary one every time.
  const items: AdvisorItem[] = [];
  const pctLoss = (1 - (res.t_meas / res.t_nom)) * 100;
  if (pctLoss > 80) {
    items.push({ title: 'วิกฤต (PCC-2 Part 3):', body: 'การสูญเสียเนื้อโลหะเกิน 80% ของความหนา Nominal — แนะนำอย่างยิ่งให้เปลี่ยนท่อช่วงที่เสียหาย (Spool Replacement) โดยเร็ว แทนการซ่อมเสริม', sub: [] });
  }
  items.push(
    { title: 'ขจัดการกัดกร่อน/กำหนดขอบเขตก่อนซ่อม:', body: mech.cleanAccess, sub: [] },
    { title: 'Composite Repair (PCC-2 Part 2):', body: 'ใช้วัสดุห่อหุ้มชนิดไม่ใช่โลหะที่ผ่านการออกแบบทางวิศวกรรม (เช่น Carbon Fiber/Epoxy) กับจุดบกพร่องที่ไม่มีการรั่วไหล เพื่อคืนความสามารถในการรับความดัน — เหมาะกับการเสริมกำลังโดยไม่ใช้ Hot Work', sub: [] },
    { title: 'Welded Repair (PCC-2 Part 3):', body: '', sub: [
      'Type B Full-Encirclement Split Sleeve ออกแบบให้รับความดันได้เต็มพิกัด',
      'การเชื่อมพอกเนื้อโลหะ (ต้องมี WPS/PQR ที่ผ่านการรับรอง, Pre-heat ก่อนเชื่อม, และ NDT หลังเชื่อม)'
    ] },
    { title: 'Mechanical Repair (PCC-2 Part 4):', body: 'ใช้ Mechanical Clamp ที่ผ่านการออกแบบทางวิศวกรรม หรือกล่องครอบ (เหมาะเมื่อมีข้อจำกัดด้าน Hot Work หรือการเชื่อม — มักเป็นมาตรการชั่วคราว)', sub: [] },
    { title: 'Replacement / Spool Replacement (PCC-2 Part 3):', body: 'ตัดและเปลี่ยนท่อช่วงที่เสียหายด้วยท่อใหม่ตามสเปกเดิม — เป็นทางเลือกที่ให้ความน่าเชื่อถือสูงสุดและเป็นการซ่อมถาวร ควรพิจารณาเทียบกับการซ่อมเสริมทุกครั้ง โดยเฉพาะเมื่อ:', sub: [
      'ความเสียหายมีขอบเขตกว้างหรือมีหลายจุดในช่วงท่อเดียวกัน',
      'อายุการใช้งานที่เหลือสั้นจนการซ่อมเสริม/ชั่วคราวไม่คุ้มค่า',
      'รูปทรงหรือตำแหน่งไม่เหมาะกับ Sleeve/Clamp/Composite',
      'เคยซ่อมที่ตำแหน่งเดิมแล้วเกิดปัญหาซ้ำ'
    ] },
    { title: 'หลังการซ่อม — ป้องกันการเกิดซ้ำ:', body: mech.postRepair, sub: [] }
  );
  return items;
}

const STATUS_SUMMARY: Record<B313Result['status'], string> = {
  OK: 'ความหนาผนังท่ออยู่ในเกณฑ์ที่ยอมรับได้ — ยังไม่จำเป็นต้องซ่อมส่วนรับความดัน แต่ยังต้องหยุดยั้งกลไกการกัดกร่อนที่ดำเนินอยู่',
  MONITOR: 'ใกล้ถึงขีดจำกัดด้านออกแบบ/โครงสร้าง — เร่งหยุดยั้งการกัดกร่อน เพิ่มความถี่การตรวจติดตาม และวางแผนประเมินซ้ำ',
  REPAIR: 'ต่ำกว่าเกณฑ์ที่ยอมรับได้ — เลือกวิธีซ่อมหรือเปลี่ยนท่อตามแนวทางด้านล่าง'
};

/* Standards backing the numeric guidance above — surfaced (with the needsReview caveat) on every
   numeric result so the engineer sees what it's grounded in and that it still wants a sign-off. */
const NUMERIC_STANDARDS_NOTE = 'อ้างอิง ASME B31.3 (การประเมินความหนา), ASME PCC-2 (วิธีซ่อม/เปลี่ยนท่อ), API 570/574/583 และแนวปฏิบัติ SSPC/NACE (การขจัดการกัดกร่อน/Coating)';

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
   finding type: applies the same whether the underlying damage is corrosion, a dent, CUI, etc.

   Summary line is deliberately leak-first, not UT-first: a leak already requires immediate
   isolation/containment action regardless of whether a UT reading exists yet. UT only sharpens
   the *permanent* repair method selection (Composite/Sleeve/Clamp/Replacement) — it is never a
   prerequisite for the immediate safety response. resolveAdvisor swaps this in as the leading
   summary (instead of the base entry's own summary, e.g. the wall-loss "need UT first" pending
   line) whenever isLeaking is true, so the banner never reads as "wait for UT before acting". */
const LEAKING_OVERLAY: FindingAdvisorEntry = {
  summary: 'พบการรั่วไหล — ดำเนินการด้านความปลอดภัย/กักเก็บทันที ไม่ต้องรอผลวัด UT ก่อน (UT ใช้เพื่อเลือกวิธีซ่อมถาวรในขั้นตอนถัดไป)',
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
 * When isLeaking is true, LEAKING_OVERLAY's items are prepended to the base entry's items, AND
 * LEAKING_OVERLAY's own summary replaces the base entry's summary as the lead line — a leak is an
 * immediate safety condition, so the banner must never lead with the base entry's non-leak framing
 * (e.g. the wall-loss-pending entry's "need a UT reading before advice" line, which would misread
 * as "wait for UT before acting" when a leak is already present and containment can't wait).
 */
export function resolveAdvisor(findingType: string | null | undefined, res: B313Result | null | undefined, isLeaking?: boolean): ResolvedAdvisor | null {
  if (!findingType) return null;

  let base: ResolvedAdvisor;
  if (WALL_LOSS_TYPES.includes(findingType)) {
    if (res && !res.hasErrors) {
      base = { summary: STATUS_SUMMARY[res.status], items: paAdvisorItems(res, findingType), standardsNote: NUMERIC_STANDARDS_NOTE, needsReview: true, isNumeric: true };
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
    summary: LEAKING_OVERLAY.summary,
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

  // Determine card theme color
  let themeClass = 'info';
  let bannerTitle = 'ASME PCC-2 / API 570 GUIDANCE';
  if (isLeaking) {
    themeClass = 'danger';
    bannerTitle = 'ACTIVELY LEAKING — EMERGENCY CONTAINMENT (ASME PCC-2)';
  } else if (res?.status === 'REPAIR') {
    themeClass = 'danger';
    bannerTitle = 'CRITICAL REPAIR REQUIRED (ASME PCC-2)';
  } else if (res?.status === 'MONITOR') {
    themeClass = 'warning';
    bannerTitle = 'INTEGRITY MONITORING STRATEGY';
  } else if (res?.status === 'OK') {
    themeClass = 'success';
    bannerTitle = 'OPERATIONAL INTEGRITY COMPLIANT';
  }

  const itemsHtml = resolved.items.map(item => {
    const titleText = item.title ? escHtml(item.title) : 'คำแนะนำทางวิศวกรรม:';
    const bodyText = escHtml(item.body);
    const subHtml = item.sub.length
      ? `<div class="advisor-sub-group">${item.sub.map(s => `<div class="advisor-sub-item">${escHtml(s)}</div>`).join('')}</div>`
      : '';
    return `
      <tr class="advisor-item-row">
        <td class="advisor-item-title">${titleText}</td>
        <td class="advisor-item-body">
          ${bodyText ? `<div class="advisor-body-text">${bodyText}</div>` : ''}
          ${subHtml}
        </td>
      </tr>
    `;
  }).join('');

  const noteHtml = resolved.standardsNote
    ? `<div class="advisor-standards-note"><strong>[Standard Reference]</strong> ${escHtml(resolved.standardsNote)}${resolved.needsReview ? ' <em>(คำแนะนำทั่วไป — โปรดตรวจสอบกับมาตรฐานทางวิศวกรรมของโครงการ)</em>' : ''}</div>`
    : '';

  root.innerHTML = `
    <div class="advisor-container ${themeClass}">
      <div class="advisor-header-card">
        <div class="advisor-banner-tag">${bannerTitle}</div>
        <div class="advisor-summary-text">${escHtml(resolved.summary)}</div>
      </div>
      <div class="advisor-body-pad">
        <table class="advisor-items-grid">
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>
        ${noteHtml}
      </div>
    </div>
  `;
}
