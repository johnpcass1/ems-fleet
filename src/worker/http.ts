import { z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
export const bad = (m: string, code?: string) => new HttpError(400, m, code);
export const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found.') => new HttpError(404, m, 'not_found');
export const conflict = (m: string, code = 'conflict') => new HttpError(409, m, code);

/** Parse and validate input. The first problem becomes a plain-English 400. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    const path = i.path.length ? i.path.join('.') + ': ' : '';
    throw bad(path + i.message);
  }
  return r.data;
}

export const nowISO = () => new Date().toISOString();

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function uid(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return `${prefix}-${Date.now().toString(36)}${s}`;
}

// ---- reusable zod pieces ----
export const zId = z.string().trim().min(1).max(80);
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-05.');
export const zText = (max: number) => z.string().trim().max(max);
export const zNum = z.number().finite();
