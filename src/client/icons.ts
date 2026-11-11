/** Inline SVG icons from lucide, only the ones the app uses (so the rest is tree-shaken away). 16px, 1.75 stroke. */
import {
  Menu, LayoutDashboard, Radio, TriangleAlert, ClipboardList, CalendarClock, Truck, Package, ChartColumn, Settings, Users,
  Maximize, Minimize, ArrowRightLeft, Ellipsis, Search, Paperclip, X, ChevronDown, ChevronRight, ChevronLeft, Plus, FileText, Image,
  PanelLeftClose, PanelLeftOpen, LogOut, KeyRound, Inbox, Wrench, Pencil, Download, Gauge, CircleAlert, Clock, Check, ShieldCheck, History, ListFilter, Building2, ClipboardCheck, ListChecks, ChevronUp, Trash2,
} from 'lucide';

type Node = [string, Record<string, string | number>][];
const ICONS: Record<string, Node> = {
  menu: Menu, board: LayoutDashboard, dispatch: Radio, alert: TriangleAlert, issues: ClipboardList, 'work-orders': Wrench, pm: CalendarClock,
  vehicles: Truck, parts: Package, reports: ChartColumn, setup: Settings, users: Users, maximize: Maximize, minimize: Minimize,
  move: ArrowRightLeft, more: Ellipsis, search: Search, clip: Paperclip, x: X, down: ChevronDown, right: ChevronRight, left: ChevronLeft, plus: Plus,
  file: FileText, image: Image, collapse: PanelLeftClose, expand: PanelLeftOpen, logout: LogOut, key: KeyRound, inbox: Inbox, edit: Pencil,
  download: Download, gauge: Gauge, info: CircleAlert, clock: Clock, check: Check, roles: ShieldCheck, activity: History, filter: ListFilter, agencies: Building2, buscheck: ClipboardCheck, buschecks: ListChecks, up: ChevronUp, trash: Trash2,
} as any;

export function icon(name: string, cls = ''): string {
  const n = ICONS[name];
  if (!n) return '';
  const body = n.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
