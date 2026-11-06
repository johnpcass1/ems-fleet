import type { Context } from 'hono';
import type { AppEnv } from './env';
import { Tx, SEQ, first } from './db';
import { HttpError, bad, forbidden, notFound, conflict, uid } from './http';
import { canOnVehicle, canWorkWO, FULL_READ } from '../shared/perm';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES } from '../shared/constants';
import { hasPerm } from '../shared/perm';

/** Identify the real file type from its first bytes. The declared type is never trusted on its own. */
export function sniff(b: Uint8Array): string | null {
  const eq = (o: number, s: number[]) => s.every((x, i) => b[o + i] === x);
  if (b.length >= 5 && eq(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (b.length >= 3 && eq(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (b.length >= 8 && eq(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (b.length >= 12 && eq(0, [0x52, 0x49, 0x46, 0x46]) && eq(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'; // RIFF....WEBP
  return null;
}
export function safeFilename(n: string) {
  const base = String(n || 'file').split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\;<>:*?|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned || 'file';
}
const asciiName = (n: string) => n.replace(/[^\x20-\x7e]/g, '_');
const MAX_FILES_PER_ENTITY = 25;

async function authorize(c: Context<AppEnv>, entityType: string, entityId: string) {
  const user = c.var.user;
  if (entityType === 'issue') {
    const is = await first<any>(c.env.DB, 'SELECT vehicle_id FROM issues WHERE id = ?', entityId);
    if (!is) throw notFound('That problem no longer exists.');
    const v = await first<any>(c.env.DB, 'SELECT base_id FROM vehicles WHERE id = ?', is.vehicle_id);
    if (!canOnVehicle(user, 'report', v?.base_id)) throw forbidden();
    return;
  }
  if (entityType === 'work_order') {
    const wo = await first<any>(c.env.DB, 'SELECT vehicle_id, mechanic_id FROM work_orders WHERE id = ?', entityId);
    if (!wo) throw notFound('That work order no longer exists.');
    const v = await first<any>(c.env.DB, 'SELECT base_id FROM vehicles WHERE id = ?', wo.vehicle_id);
    if (!(canWorkWO(user, { mechanicId: wo.mechanic_id }, v?.base_id) || canOnVehicle(user, 'createWO', v?.base_id))) throw forbidden();
    return;
  }
  throw bad('entity_type must be issue or work_order.');
}

export async function uploadAttachment(c: Context<AppEnv>) {
  const len = Number(c.req.header('content-length') || 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) throw new HttpError(413, 'That file is over 20 MB.', 'too_large');
  let form: FormData;
  try { form = await c.req.formData(); } catch { throw bad('Send the file as a form upload.'); }
  const entityType = String(form.get('entity_type') || '');
  const entityId = String(form.get('entity_id') || '');
  const file = form.get('file');
  if (!entityId || !(file instanceof File)) throw bad('Choose a file to attach.');
  await authorize(c, entityType, entityId);
  if (!file.size) throw bad('That file is empty.');
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'That file is over 20 MB.', 'too_large');
  const buf = new Uint8Array(await file.arrayBuffer());
  const real = sniff(buf);
  if (!real || !UPLOAD_TYPES.includes(real)) throw new HttpError(415, 'Only PDF, JPEG, PNG or WebP files can be attached.', 'unsupported_type');
  const declared = (file.type || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (declared && declared !== 'application/octet-stream' && declared !== real) throw new HttpError(415, 'The file does not match its type. Only real PDF, JPEG, PNG or WebP files can be attached.', 'type_mismatch');
  const n = await first<any>(c.env.DB, 'SELECT COUNT(*) AS n FROM attachments WHERE entity_type = ? AND entity_id = ?', entityType, entityId);
  if ((n?.n || 0) >= MAX_FILES_PER_ENTITY) throw conflict(`A record can hold up to ${MAX_FILES_PER_ENTITY} files.`);

  const id = uid('f');
  const key = `attachments/${id}`;
  const name = safeFilename(file.name);
  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: real } });
  const parentTable = entityType === 'issue' ? 'issues' : 'work_orders';
  const tx = new Tx(c.env.DB, c.var.user);
  tx.run('INSERT INTO attachments (id, entity_type, entity_id, r2_key, name, content_type, size, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)', id, entityType, entityId, key, name, real, buf.length, tx.at, tx.at, c.var.user.id);
  tx.run(`UPDATE ${parentTable} SET seq=${SEQ}, updated_at=? WHERE id=?`, tx.at, entityId);
  tx.audit('attachment.add', entityType, entityId, null, { id, name, type: real, size: buf.length });
  try { await tx.commit(); } catch (e) { await c.env.FILES.delete(key).catch(() => {}); throw e; }
  return c.json({ ok: true, id, name, type: real, size: buf.length });
}

export async function downloadAttachment(c: Context<AppEnv>) {
  const user = c.var.user;
  if (!FULL_READ.includes(user.role)) throw forbidden();
  const a = await first<any>(c.env.DB, 'SELECT * FROM attachments WHERE id = ?', c.req.param('id'));
  if (!a) throw notFound();
  const obj = await c.env.FILES.get(a.r2_key);
  if (!obj) throw notFound('The file is missing from storage.');
  const isPdf = a.content_type === 'application/pdf';
  const h = new Headers();
  h.set('Content-Type', a.content_type);
  h.set('Content-Length', String(obj.size));
  const nm = safeFilename(a.name);
  h.set('Content-Disposition', `inline; filename="${asciiName(nm)}"; filename*=UTF-8''${encodeURIComponent(nm)}`);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Cache-Control', 'private, max-age=3600');
  h.set('Content-Security-Policy', isPdf ? "frame-ancestors 'none'" : "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(obj.body, { headers: h });
}

export async function deleteAttachment(c: Context<AppEnv>) {
  const user = c.var.user;
  if (!hasPerm(user.role, 'delAttach')) throw forbidden();
  const a = await first<any>(c.env.DB, 'SELECT * FROM attachments WHERE id = ?', c.req.param('id'));
  if (!a) throw notFound();
  const parentTable = a.entity_type === 'issue' ? 'issues' : 'work_orders';
  const tx = new Tx(c.env.DB, user);
  tx.run('DELETE FROM attachments WHERE id = ?', a.id);
  tx.run(`UPDATE ${parentTable} SET seq=${SEQ}, updated_at=? WHERE id=?`, tx.at, a.entity_id);
  tx.audit('attachment.delete', a.entity_type, a.entity_id, { id: a.id, name: a.name }, null);
  await tx.commit();
  await c.env.FILES.delete(a.r2_key);
  return c.json({ ok: true });
}
