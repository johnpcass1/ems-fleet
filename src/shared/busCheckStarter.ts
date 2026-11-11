/**
 * The standard bus check list: the equipment sections of the New York State DOH-3780 ambulance check sheet (10/26), as a starting point.
 * Nothing is added to an agency automatically. A fleet manager or system administrator presses "Start from the standard list" on
 * Admin > Bus checks > Requirements, which copies this list into that agency; after that it is the agency's own list and can be edited freely.
 *
 * Converted from the sheet: "N/R" (not required) rows are left out; "R" rows are yes/no checks; "O" rows are optional; the rest are counts with a minimum.
 * The two oxygen rows that record readings are split in two each: a pressure (psi) and a test-expiry date for the portable cylinder and for the spare.
 * The item code (b.1, e.10, .26(c)(1)...) is the sheet's own reference and is shown as a small grey label. It is also the item's stable id for this list.
 */
import type { BusSection } from './buscheck';

export const STARTER_LIST_NAME = 'Standard ambulance';
export const STARTER_SECTIONS: BusSection[] = [
  {
    id: 'b', title: 'Airway & Oxygen Equipment / Sudden Cardiac Arrest Resuscitation', items: [
      { id: 'b.1', code: 'b.1', name: 'Adult BVM with mask', kind: 'count', min: 1 },
      { id: 'b.2', code: 'b.2', name: 'Adult oral airways, sizes 0, 1, 2, 3, 4, 5, 6', kind: 'count', min: 1, note: 'each size' },
      { id: 'b.3', code: 'b.3', name: 'Nasopharyngeal airways, sizes 18, 20, 24, 28, 32 Fr', kind: 'count', min: 1, note: 'each size' },
      { id: 'b.4', code: 'b.4', name: 'Pulse oximetry with adult and pediatric capability (pediatric optional)', kind: 'count', min: 1 },
      { id: 'b.5a-1', code: 'b.5a-1', name: 'Portable oxygen cylinder 1 pressure', kind: 'number', min: 1000, unit: 'psi' },
      { id: 'b.5a-2', code: 'b.5a-2', name: 'Portable oxygen cylinder 2 (spare) pressure', kind: 'number', min: 1000, unit: 'psi' },
      { id: 'b.5b', code: 'b.5b', name: 'All oxygen cylinders secured by commercial mount', kind: 'check' },
      { id: 'b.5c-1', code: 'b.5c-1', name: 'Portable oxygen cylinder 1 hydrostatic test', kind: 'date', note: 'Enter the date the test expires' },
      { id: 'b.5c-2', code: 'b.5c-2', name: 'Portable oxygen cylinder 2 (spare) hydrostatic test', kind: 'date', note: 'Enter the date the test expires' },
      { id: 'b.7', code: 'b.7', name: 'Adult non-rebreather masks and nasal cannulas', kind: 'count', min: 1, note: 'each' },
      { id: 'b.8', code: 'b.8', name: 'Portable suction (to 300 mmHg), battery or manual', kind: 'count', min: 1 },
      { id: 'b.10', code: 'b.10', name: 'Rigid suction catheters (optional if manual suction)', kind: 'count', min: 2 },
      { id: 'b.11', code: 'b.11', name: 'Soft sterile suction catheters (2 sizes)', kind: 'optional' },
      { id: 'b.12', code: 'b.12', name: 'AED with 2 sets of adult pads and 1 set of pediatric pads (or equivalent)', kind: 'count', min: 1 },
    ],
  },
  {
    id: 'c', title: 'Immobilization & Trauma Patient Management', items: [
      { id: 'c.2', code: 'c.2', name: 'Half-length spinal immobilization device with straps', kind: 'optional' },
      { id: 'c.3', code: 'c.3', name: 'Traction splinting device', kind: 'optional' },
      { id: 'c.4', code: 'c.4', name: 'Padded splint set or equivalent (2 sizes)', kind: 'count', min: 2, note: 'each size' },
      { id: 'c.5', code: 'c.5', name: 'Rigid extrication collars (adult, pediatric)', kind: 'count', min: 1, note: 'each size' },
      { id: 'c.7', code: 'c.7', name: 'Flexible litter', kind: 'optional' },
    ],
  },
  {
    id: 'd', title: 'Infant & Pediatric Airway, Oxygen & Resuscitation', items: [
      { id: 'd.1', code: 'd.1', name: 'Pediatric BVM', kind: 'count', min: 1 },
      { id: 'd.2', code: 'd.2', name: 'Pediatric masks (newborn, infant, child)', kind: 'count', min: 1, note: 'each size' },
      { id: 'd.3', code: 'd.3', name: 'Pediatric non-rebreather masks and nasal cannulas', kind: 'count', min: 1, note: 'each' },
      { id: 'd.4', code: 'd.4', name: 'Pediatric sterile suction catheters, 2 sizes (optional if manual device)', kind: 'count', min: 2, note: 'each size' },
      { id: 'd.5', code: 'd.5', name: 'Pediatric BP cuffs (infant, child)', kind: 'count', min: 1, note: 'each size' },
      { id: 'd.6', code: 'd.6', name: 'Pediatric stethoscope', kind: 'count', min: 1 },
      { id: 'd.7', code: 'd.7', name: 'Infant swaddler', kind: 'optional' },
      { id: 'd.8', code: 'd.8', name: 'Emergency OB supplies in a kit', kind: 'count', min: 1 },
      { id: 'd.9', code: 'd.9', name: 'Length-based resuscitation tape or equivalent', kind: 'optional' },
    ],
  },
  {
    id: 'e', title: 'Bleeding & Hemorrhage Control', items: [
      { id: 'e.1', code: 'e.1', name: 'Sterile gauze pads 4x4"', kind: 'count', min: 6 },
      { id: 'e.2', code: 'e.2', name: 'Tape, varying sizes', kind: 'count', min: 4, unit: 'rolls' },
      { id: 'e.3', code: 'e.3', name: 'Conforming gauze (2 sizes)', kind: 'count', min: 1, note: 'each size' },
      { id: 'e.4', code: 'e.4', name: 'Sterile multi-trauma dressing', kind: 'count', min: 2 },
      { id: 'e.5', code: 'e.5', name: 'Sterile gauze pads 5x9"', kind: 'count', min: 3 },
      { id: 'e.6', code: 'e.6', name: 'Trauma shears', kind: 'count', min: 1 },
      { id: 'e.7', code: 'e.7', name: 'Sterile burn sheets', kind: 'count', min: 1 },
      { id: 'e.8', code: 'e.8', name: 'Triangular bandages', kind: 'count', min: 3 },
      { id: 'e.9', code: 'e.9', name: 'Sterile saline (500 ml minimum)', kind: 'count', min: 1 },
      { id: 'e.10', code: 'e.10', name: 'Commercial chest seal', kind: 'count', min: 2 },
      { id: 'e.11', code: 'e.11', name: 'Commercial windlass tourniquet', kind: 'count', min: 2 },
    ],
  },
  {
    id: 'f', title: 'Miscellaneous & Special EMS Equipment (clean and sanitary)', items: [
      { id: 'f.6', code: 'f.6', name: 'Cloth or disposable blanket', kind: 'count', min: 2 },
      { id: 'f.8', code: 'f.8', name: 'Emesis containers or equivalent', kind: 'count', min: 1 },
      { id: 'f.9', code: 'f.9', name: 'Adult and large adult BP cuff', kind: 'count', min: 1, note: 'each' },
      { id: 'f.10', code: 'f.10', name: 'Adult stethoscope', kind: 'count', min: 1 },
      { id: 'f.11', code: 'f.11', name: 'Thermometer', kind: 'count', min: 1 },
      { id: 'f.12', code: 'f.12', name: 'Carrying case or equivalent', kind: 'count', min: 1 },
      { id: 'f.13', code: 'f.13', name: 'Chemical cold packs', kind: 'count', min: 1, note: 'each' },
      { id: 'f.14', code: 'f.14', name: 'Chemical hot packs', kind: 'optional' },
      { id: 'f.15', code: 'f.15', name: 'Single-use water-based lubricating jelly', kind: 'count', min: 2 },
      { id: 'f.16', code: 'f.16', name: 'Masks and goggles or equivalent', kind: 'count', min: 1, unit: 'pair' },
      { id: 'f.17', code: 'f.17', name: 'Latex-free disposable exam gloves (S, M, L)', kind: 'count', min: 4, unit: 'pairs', note: 'each size' },
      { id: 'f.18', code: 'f.18', name: 'Flashlight with batteries', kind: 'count', min: 1 },
      { id: 'f.19', code: 'f.19', name: 'Triage tags or equivalent for at least 20 patients', kind: 'check' },
    ],
  },
  {
    id: 'g', title: 'Safety Equipment', items: [
      { id: 'g.1', code: 'g.1', name: 'Flares (6) or equivalent (3)', kind: 'check' },
      { id: 'g.2', code: 'g.2', name: 'Fire extinguisher (5ABC or 10BC)', kind: 'count', min: 1 },
      { id: 'g.3', code: 'g.3', name: 'Portable CO detector with visual and audible alerts', kind: 'count', min: 1 },
      { id: 'g.4', code: 'g.4', name: 'High-visibility traffic vests', kind: 'count', min: 2 },
    ],
  },
  {
    id: 'h', title: 'Required BLS Medications & Adjuncts', items: [
      { id: 'h.1', code: 'h.1', name: 'Adult epinephrine auto-injector or equivalent', kind: 'count', min: 1, unit: 'dose' },
      { id: 'h.2', code: 'h.2', name: 'Pediatric epinephrine auto-injector or equivalent', kind: 'count', min: 2, unit: 'doses' },
      { id: 'h.3', code: 'h.3', name: 'Aspirin', kind: 'count', min: 2, unit: 'doses' },
      { id: 'h.4', code: 'h.4', name: 'Naloxone or equivalent', kind: 'count', min: 2, unit: 'doses' },
      { id: 'h.5', code: 'h.5', name: 'Bronchodilator (3 doses)', kind: 'optional' },
      { id: 'h.6', code: 'h.6', name: 'Nebulizer for adult and pediatric (1 dose)', kind: 'optional' },
      { id: 'h.7', code: 'h.7', name: 'Adult CPAP (2 mask sizes)', kind: 'optional' },
      { id: 'h.8', code: 'h.8', name: 'Blood glucose monitoring equipment', kind: 'check' },
      { id: 'h.9', code: 'h.9', name: 'Liquid glucose or equivalent', kind: 'count', min: 1, unit: 'dose' },
    ],
  },
  {
    id: 'v', title: 'General & Vehicle Requirements', items: [
      { id: '.21(a)', code: '.21(a)', name: 'Valid vehicle and health inspection', kind: 'check' },
      { id: '.21(b)', code: '.21(b)', name: 'Vehicle mechanical, tires, lights and warning devices working', kind: 'check' },
      { id: '.21(e)', code: '.21(e)', name: 'Agency name and logo on 3 sides', kind: 'check' },
      { id: '.21(n)', code: '.21(n)', name: 'Vehicle interior clean and sanitary', kind: 'check' },
      { id: '.24(c)', code: '.24(c)', name: 'Equipment clean, sanitary and working', kind: 'check' },
      { id: '.24(i)', code: '.24(i)', name: 'Fluids in plastic containers', kind: 'check' },
      { id: '.24(e)', code: '.24(e)', name: 'ALS equipment and drugs compartment locked', kind: 'check' },
      { id: '.24(h)', code: '.24(h)', name: 'Vehicle secured when not occupied', kind: 'check' },
      { id: '.26(c)(1)', code: '.26(c)(1)', name: 'Seatbelts', kind: 'check' },
      { id: '.26(c)(2)', code: '.26(c)(2)', name: 'Two-way radio with dispatch and medical control', kind: 'check' },
      { id: '.26(c)(3)', code: '.26(c)(3)', name: 'Reverse alarm (visual and audible) and rear-view camera', kind: 'check' },
      { id: '.26(c)(4)', code: '.26(c)(4)', name: 'Front-facing camera system', kind: 'check' },
      { id: '.26(c)(5-6)', code: '.26(c)(5-6)', name: 'Equipment secured and not interfering with vehicle safety', kind: 'check' },
      { id: '.26(c)(7)', code: '.26(c)(7)', name: 'Anti-theft device', kind: 'check' },
    ],
  },
];
