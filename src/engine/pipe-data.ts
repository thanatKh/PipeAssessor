/* ============================================================================
   ASME B31.3 reference tables — EXTRACTED VERBATIM (line-sliced) from the
   pre-migration src/legacy/shared.js. Do not hand-edit values: the numeric-identity
   regression (src/engine/compute.test.ts) depends on these being unchanged.
   ============================================================================ */
import type { PipeSize, Material } from '../types/models';

export const PA_PIPE_DATABASE: Record<string, PipeSize> = {
  '1/2"': {
    od: 21.34,
    schedules: {
      '40': { t: 2.77, label: 'Sch 40 (STD)' },
      '80': { t: 3.73, label: 'Sch 80 (XS)' },
      '160': { t: 4.78, label: 'Sch 160' },
      'XXS': { t: 7.47, label: 'Sch XXS' }
    }
  },
  '3/4"': {
    od: 26.67,
    schedules: {
      '40': { t: 2.87, label: 'Sch 40 (STD)' },
      '80': { t: 3.91, label: 'Sch 80 (XS)' },
      '160': { t: 5.56, label: 'Sch 160' },
      'XXS': { t: 7.82, label: 'Sch XXS' }
    }
  },
  '1"': {
    od: 33.40,
    schedules: {
      '40': { t: 3.38, label: 'Sch 40 (STD)' },
      '80': { t: 4.55, label: 'Sch 80 (XS)' },
      '160': { t: 6.35, label: 'Sch 160' },
      'XXS': { t: 9.09, label: 'Sch XXS' }
    }
  },
  '1-1/4"': {
    od: 42.16,
    schedules: {
      '40': { t: 3.56, label: 'Sch 40 (STD)' },
      '80': { t: 4.85, label: 'Sch 80 (XS)' },
      '160': { t: 6.35, label: 'Sch 160' },
      'XXS': { t: 9.70, label: 'Sch XXS' }
    }
  },
  '1-1/2"': {
    od: 48.26,
    schedules: {
      '40': { t: 3.68, label: 'Sch 40 (STD)' },
      '80': { t: 5.08, label: 'Sch 80 (XS)' },
      '160': { t: 7.14, label: 'Sch 160' },
      'XXS': { t: 10.15, label: 'Sch XXS' }
    }
  },
  '2"': {
    od: 60.33,
    schedules: {
      '10': { t: 2.77, label: 'Sch 10' },
      '40': { t: 3.91, label: 'Sch 40 (STD)' },
      '80': { t: 5.54, label: 'Sch 80 (XS)' },
      '160': { t: 8.74, label: 'Sch 160' },
      'XXS': { t: 11.07, label: 'Sch XXS' }
    }
  },
  '2-1/2"': {
    od: 73.03,
    schedules: {
      '10': { t: 3.05, label: 'Sch 10' },
      '40': { t: 5.16, label: 'Sch 40 (STD)' },
      '80': { t: 7.01, label: 'Sch 80 (XS)' },
      '160': { t: 9.53, label: 'Sch 160' },
      'XXS': { t: 14.02, label: 'Sch XXS' }
    }
  },
  '3"': {
    od: 88.90,
    schedules: {
      '10': { t: 3.05, label: 'Sch 10' },
      '40': { t: 5.49, label: 'Sch 40 (STD)' },
      '80': { t: 8.08, label: 'Sch 80 (XS)' },
      '160': { t: 11.13, label: 'Sch 160' },
      'XXS': { t: 15.24, label: 'Sch XXS' }
    }
  },
  '4"': {
    od: 114.30,
    schedules: {
      '10': { t: 3.05, label: 'Sch 10' },
      '40': { t: 6.02, label: 'Sch 40 (STD)' },
      '80': { t: 8.56, label: 'Sch 80 (XS)' },
      '120': { t: 11.13, label: 'Sch 120' },
      '160': { t: 13.49, label: 'Sch 160' },
      'XXS': { t: 17.12, label: 'Sch XXS' }
    }
  },
  '6"': {
    od: 168.28,
    schedules: {
      '10': { t: 3.40, label: 'Sch 10' },
      '40': { t: 7.11, label: 'Sch 40 (STD)' },
      '80': { t: 10.97, label: 'Sch 80 (XS)' },
      '120': { t: 14.27, label: 'Sch 120' },
      '160': { t: 18.26, label: 'Sch 160' },
      'XXS': { t: 21.95, label: 'Sch XXS' }
    }
  },
  '8"': {
    od: 219.08,
    schedules: {
      '10': { t: 3.76, label: 'Sch 10' },
      '20': { t: 6.35, label: 'Sch 20' },
      '30': { t: 7.04, label: 'Sch 30' },
      '40': { t: 8.18, label: 'Sch 40 (STD)' },
      '60': { t: 10.31, label: 'Sch 60' },
      '80': { t: 12.70, label: 'Sch 80 (XS)' },
      '100': { t: 15.09, label: 'Sch 100' },
      '120': { t: 18.26, label: 'Sch 120' },
      '140': { t: 20.62, label: 'Sch 140' },
      '160': { t: 23.01, label: 'Sch 160' },
      'XXS': { t: 22.23, label: 'Sch XXS' }
    }
  },
  '10"': {
    od: 273.05,
    schedules: {
      '10': { t: 4.19, label: 'Sch 10' },
      '20': { t: 6.35, label: 'Sch 20' },
      '30': { t: 7.80, label: 'Sch 30' },
      '40': { t: 9.27, label: 'Sch 40 (STD)' },
      '60': { t: 12.70, label: 'Sch 60 (XS)' },
      '80': { t: 15.09, label: 'Sch 80' },
      '100': { t: 18.26, label: 'Sch 100' },
      '120': { t: 21.44, label: 'Sch 120' },
      '140': { t: 25.40, label: 'Sch 140' },
      '160': { t: 28.58, label: 'Sch 160' }
    }
  },
  '12"': {
    od: 323.85,
    schedules: {
      '10': { t: 4.57, label: 'Sch 10' },
      '20': { t: 6.35, label: 'Sch 20' },
      '30': { t: 8.38, label: 'Sch 30' },
      '40': { t: 10.31, label: 'Sch 40 (STD)' },
      '60': { t: 14.27, label: 'Sch 60' },
      '80': { t: 17.48, label: 'Sch 80 (XS)' },
      '100': { t: 21.44, label: 'Sch 100' },
      '120': { t: 25.40, label: 'Sch 120' },
      '140': { t: 28.58, label: 'Sch 140' },
      '160': { t: 33.32, label: 'Sch 160' }
    }
  },
  '14"': {
    od: 355.60,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 7.92, label: 'Sch 20' },
      '30': { t: 9.53, label: 'Sch 30 (STD/XS)' },
      '40': { t: 11.13, label: 'Sch 40' },
      '60': { t: 15.09, label: 'Sch 60' },
      '80': { t: 19.05, label: 'Sch 80' },
      '100': { t: 23.83, label: 'Sch 100' },
      '120': { t: 27.79, label: 'Sch 120' },
      '140': { t: 31.75, label: 'Sch 140' },
      '160': { t: 35.71, label: 'Sch 160' }
    }
  },
  '16"': {
    od: 406.40,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 7.92, label: 'Sch 20' },
      '30': { t: 9.53, label: 'Sch 30 (STD)' },
      '40': { t: 12.70, label: 'Sch 40 (XS)' },
      '60': { t: 16.66, label: 'Sch 60' },
      '80': { t: 21.44, label: 'Sch 80' },
      '100': { t: 26.19, label: 'Sch 100' },
      '120': { t: 30.96, label: 'Sch 120' },
      '140': { t: 36.53, label: 'Sch 140' },
      '160': { t: 40.49, label: 'Sch 160' }
    }
  },
  '18"': {
    od: 457.20,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 7.92, label: 'Sch 20' },
      '30': { t: 11.13, label: 'Sch 30 (STD)' },
      '40': { t: 14.27, label: 'Sch 40 (XS)' },
      '60': { t: 19.05, label: 'Sch 60' },
      '80': { t: 23.83, label: 'Sch 80' },
      '100': { t: 29.36, label: 'Sch 100' },
      '120': { t: 34.93, label: 'Sch 120' },
      '140': { t: 39.67, label: 'Sch 140' },
      '160': { t: 45.24, label: 'Sch 160' }
    }
  },
  '20"': {
    od: 508.00,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 9.53, label: 'Sch 20 (STD)' },
      '30': { t: 12.70, label: 'Sch 30 (XS)' },
      '40': { t: 15.09, label: 'Sch 40' },
      '60': { t: 20.62, label: 'Sch 60' },
      '80': { t: 26.19, label: 'Sch 80' },
      '100': { t: 32.54, label: 'Sch 100' },
      '120': { t: 38.10, label: 'Sch 120' },
      '140': { t: 44.45, label: 'Sch 140' },
      '160': { t: 50.01, label: 'Sch 160' }
    }
  },
  '24"': {
    od: 609.60,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 9.53, label: 'Sch 20 (STD)' },
      '30': { t: 14.27, label: 'Sch 30 (XS)' },
      '40': { t: 17.48, label: 'Sch 40' },
      '60': { t: 24.61, label: 'Sch 60' },
      '80': { t: 30.96, label: 'Sch 80' },
      '100': { t: 38.89, label: 'Sch 100' },
      '120': { t: 46.02, label: 'Sch 120' },
      '140': { t: 52.37, label: 'Sch 140' },
      '160': { t: 59.54, label: 'Sch 160' }
    }
  }
};

export const PA_MATERIALS: Material[] = [
  { name: 'Carbon Steel: ASTM A106 Gr. B / A53 Gr. B', stress: 137.9, code: 'A106B' },
  { name: 'Low-Temp Carbon Steel: ASTM A333 Gr. 6', stress: 137.9, code: 'A333' },
  { name: 'Carbon Steel: API 5L Gr. B', stress: 137.9, code: 'API5LB' },
  { name: 'High Yield Carbon Steel: API 5L X42', stress: 144.8, code: 'X42' },
  { name: 'High Yield Carbon Steel: API 5L X52', stress: 179.3, code: 'X52' },
  { name: 'High Yield Carbon Steel: API 5L X60', stress: 206.8, code: 'X60' },
  { name: 'Stainless Steel: ASTM A312 TP304', stress: 137.9, code: 'TP304' },
  { name: 'Stainless Steel: ASTM A312 TP316', stress: 137.9, code: 'TP316' },
  { name: 'Manual Input (Specify below)', stress: null, code: 'MANUAL' }
];
