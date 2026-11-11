/**
 * Sending email (account invites and password reset links only).
 * Uses Resend's HTTP API: POST https://api.resend.com/emails with a Bearer key and JSON {from, to[], subject, html, text}.
 * See docs/EMAIL.md for setup. Nothing here is used unless both RESEND_API_KEY and MAIL_FROM are set.
 */
import type { Env } from './env';
import { ROLES, type Role } from '../shared/constants';

export type SendResult = { ok: true; id?: string } | { ok: false; reason: string };
export interface MailMessage { to: string; subject: string; text: string; html: string }
export interface Mailer { send(m: MailMessage): Promise<SendResult> }

export const RESEND_URL = 'https://api.resend.com/emails';

/** True when the app can send email: the secret key and the sender address are both set. */
export const emailEnabled = (env: Pick<Env, 'RESEND_API_KEY' | 'MAIL_FROM'>): boolean => !!(env.RESEND_API_KEY?.trim() && env.MAIL_FROM?.trim());

/** Development only: "MAIL_SINK=1" saves mail to R2 instead of sending it. Refused unless the app address is localhost. */
export function sinkActive(env: Env): boolean {
  if (env.MAIL_SINK !== '1') return false;
  try { const h = new URL(env.APP_URL).hostname; return h === 'localhost' || h === '127.0.0.1'; } catch { return false; }
}

export class ResendMailer implements Mailer {
  constructor(private key: string, private from: string) {}
  async send(m: MailMessage): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return { ok: false, reason: 'the email service could not be reached' };
    }
    let j: any = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (res.ok && j?.id) return { ok: true, id: String(j.id) };
    if (res.ok) return { ok: true };
    const msg = typeof j?.message === 'string' ? j.message.slice(0, 300) : '';
    if (res.status === 401) return { ok: false, reason: msg || 'the email API key was not accepted' };
    if (res.status === 429) return { ok: false, reason: msg || 'the email sending limit has been reached (free plan: 100 a day). Try again tomorrow' };
    return { ok: false, reason: msg || `the email service answered with error ${res.status}` };
  }
}

/** Development sink: one JSON file per message in R2 under dev-mail/. */
class SinkMailer implements Mailer {
  constructor(private bucket: R2Bucket) {}
  async send(m: MailMessage): Promise<SendResult> {
    const key = `dev-mail/${String(Date.now()).padStart(15, '0')}-${crypto.randomUUID().slice(0, 8)}.json`;
    await this.bucket.put(key, JSON.stringify({ ...m, at: new Date().toISOString() }));
    return { ok: true, id: key };
  }
}
export async function lastSinkMail(env: Env, to?: string): Promise<any | null> {
  const l = await env.FILES.list({ prefix: 'dev-mail/' });
  const keys = l.objects.map((o) => o.key).sort().reverse();
  for (const k of keys) {
    const o = await env.FILES.get(k);
    const j: any = o ? await o.json() : null;
    if (j && (!to || j.to === to)) return j;
  }
  return null;
}

export function getMailer(env: Env): Mailer | null {
  if (!emailEnabled(env)) return null;
  if (sinkActive(env)) return new SinkMailer(env.FILES);
  return new ResendMailer(env.RESEND_API_KEY!.trim(), env.MAIL_FROM!.trim());
}

/* ---------- message text (plain and short; no images, no tracking) ---------- */
const he = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const setPasswordLink = (env: Pick<Env, 'APP_URL'>, token: string) => `${env.APP_URL.replace(/\/+$/, '')}/set-password#t=${token}`;

export interface MailAgency { id: string; name: string }
/** "<Agency name> Fleet": what the emails call the product, so one agency's people never see another agency's name. */
const product = (a: MailAgency) => `${a.name} Fleet`;

function wrap(a: MailAgency, paragraphs: string[], link: string, linkLabel: string, after: string[]) {
  const text = [...paragraphs, `${linkLabel}\n${link}`, ...after, `Agency ID (needed to log in): ${a.id}`, `-- ${product(a)}`].join('\n\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1b1f23;max-width:540px">${paragraphs.map((p) => `<p>${he(p)}</p>`).join('')}<p><a href="${he(link)}" style="display:inline-block;padding:10px 16px;background:#b3261e;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">${he(linkLabel)}</a></p><p style="font-size:13px;color:#555">If the button does not work, copy this address into your browser:<br>${he(link)}</p>${after.map((p) => `<p style="font-size:13px;color:#555">${he(p)}</p>`).join('')}<p style="font-size:13px;color:#555">Agency ID (needed to log in): <b>${he(a.id)}</b></p><p style="font-size:13px;color:#555">${he(product(a))}</p></div>`;
  return { text, html };
}

export function inviteMessage(o: { to: string; name: string; inviter: string; role: Role | string; link: string; agency: MailAgency }): MailMessage {
  const role = ROLES[o.role as Role] || String(o.role);
  const m = wrap(
    o.agency,
    [`Hi ${o.name},`, `${o.inviter} has set up a ${product(o.agency)} account for you (role: ${role}). Choose your password to get started.`],
    o.link, 'Choose your password',
    ['This link works once and expires in 7 days. If it has expired, ask your fleet manager to send a new one.', 'If you were not expecting this, you can ignore this email.'],
  );
  return { to: o.to, subject: `Set up your ${product(o.agency)} account`, ...m };
}
export function resetMessage(o: { to: string; name: string; link: string; agency: MailAgency }): MailMessage {
  const m = wrap(
    o.agency,
    [`Hi ${o.name},`, `Someone asked to reset the password for your ${product(o.agency)} account. Use the link below to choose a new one.`],
    o.link, 'Reset your password',
    ['This link works once and expires in 1 hour.', 'If you did not ask for this, you can ignore this email. Your password has not changed.'],
  );
  return { to: o.to, subject: `Reset your ${product(o.agency)} password`, ...m };
}
