/** Photo and PDF handling: downscale photos in the browser, then upload to the server. */
import { api, ApiError, syncNow } from './api';
import { D, S } from './state';
import { toast, uerr } from './util';

const FILE_EXT: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const FILE_TYPES = new Set(Object.values(FILE_EXT));
export const MAX_BYTES = 20 * 1024 * 1024, MAX_EDGE = 1600, KEEP_BYTES = 600 * 1024;
const PHOTO_MSG = 'This photo format isn’t supported — try JPEG or PNG';
/** Uploads in progress, shown under the Attachments heading: "coll:id" -> [{name,state}]. */
export const UP: Record<string, { name: string; state: string }[]> = {};
export const pending: { file: File; preview: string | null }[] = [];
let onProgress: () => void = () => {};
export const setProgressHook = (f: () => void) => { onProgress = f; };

export function fileType(f: File): string | null {
  if (f.type) return FILE_TYPES.has(f.type) ? f.type : null;
  return FILE_EXT[(String(f.name).split('.').pop() || '').toLowerCase()] || null;
}
export const safeAsset = (id: any) => /^[A-Za-z0-9_-]{1,64}$/.test(String(id));
function validateFile(f: File) {
  if (!f.size) return 'That file is empty.';
  if (f.size > MAX_BYTES) return 'That file is over 20 MB.';
  if (!fileType(f)) return 'Only PDF, JPEG, PNG or WebP files can be attached.';
  return null;
}
async function decodeImage(file: File): Promise<any> {
  if ((window as any).createImageBitmap) { try { return await createImageBitmap(file); } catch { /* fall through */ } }
  return await new Promise((res, rej) => {
    const u = URL.createObjectURL(file), im = new Image();
    im.onload = () => { URL.revokeObjectURL(u); res(im); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode')); };
    im.src = u;
  });
}
/** Downscale to max 1600 px (long edge), JPEG 0.82. Small, already-fine photos are kept as they are. */
async function prepareImage(file: any): Promise<File> {
  let img: any;
  try { img = await decodeImage(file); } catch { throw uerr(PHOTO_MSG); }
  const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight, long = Math.max(w, h);
  if (!w || !h) throw uerr(PHOTO_MSG);
  if (file.size <= KEEP_BYTES && long <= MAX_EDGE) { if (img.close) img.close(); file._prepared = true; return file; }
  const k = Math.min(1, MAX_EDGE / long), cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(img, 0, 0, cw, ch);
  if (img.close) img.close();
  const blob: Blob | null = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  if (!blob) throw uerr(PHOTO_MSG);
  if (k === 1 && blob.size >= file.size && fileType(file) === 'image/jpeg') { file._prepared = true; return file; }
  const nf: any = new File([blob], String(file.name).replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  nf._prepared = true;
  return nf;
}
export async function normalizeFile(f: any): Promise<File> {
  if (f._prepared) return f;
  const t = fileType(f);
  if (t && t.startsWith('image/')) f = await prepareImage(f);
  else if (!t && ((f.type || '').startsWith('image/') || /\.(heic|heif|gif|bmp|tiff?)$/i.test(f.name))) throw uerr(PHOTO_MSG);
  const bad = validateFile(f);
  if (bad) throw uerr(bad);
  return f;
}
function uploadMsg(e: any) {
  if (e && e.user) return e.message;
  return 'Upload failed.';
}
const ENTITY: Record<string, string> = { issues: 'issue', workOrders: 'work_order' };

export async function attachFiles(coll: string, docId: string, files: File[]) {
  const key = coll + ':' + docId;
  let ok = 0;
  for (const f0 of files) {
    const entry = { name: f0.name, state: 'Uploading…' };
    (UP[key] = UP[key] || []).push(entry);
    onProgress();
    try {
      const f = await normalizeFile(f0);
      const form = new FormData();
      form.set('entity_type', ENTITY[coll]);
      form.set('entity_id', docId);
      form.set('file', f, f.name);
      await api('POST', '/attachments', undefined, { form });
      await syncNow();
      ok++;
      toast(`${f0.name} attached`);
    } catch (e: any) {
      console.warn('attach failed', e);
      toast(uploadMsg(e), true); // includes "Photo and PDF uploads are turned off for now." when the server says uploads_disabled; the record itself is already saved
    }
    UP[key] = (UP[key] || []).filter((x) => x !== entry);
    onProgress();
  }
  return ok;
}
export async function removeAttachment(coll: string, docId: string, assetId: string) {
  if (!D[coll][docId]) return;
  await api('DELETE', `/attachments/${assetId}`);
  await syncNow();
}
export const fileUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/file`;
void S; void ApiError;
