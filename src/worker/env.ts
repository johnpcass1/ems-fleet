import type { Actor } from '../shared/perm';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  /** Public address of the app, e.g. https://fleet.example.gy. Used for the same-origin check. */
  APP_URL: string;
  /** PBKDF2 iterations for new password hashes. Calibrated for the Workers Free 10 ms CPU limit. See docs/SECURITY.md. */
  PBKDF2_ITERATIONS?: string;
  /**
   * Super user email address(es), comma separated, compared ignoring case and spaces. Set ONLY in wrangler.jsonc, so it changes only
   * with a code update. A super user has every permission and cannot be edited by anyone else. Empty or unset: nobody is a super user.
   */
  SUPERUSER_EMAILS?: string;
  /** Secret (never in wrangler.jsonc): Resend API key. Set with `npx wrangler secret put RESEND_API_KEY`. See docs/EMAIL.md. */
  RESEND_API_KEY?: string;
  /** Sender shown on emails, e.g. "GEMA Fleet <no-reply@example.org>". An address on a domain verified in Resend. */
  MAIL_FROM?: string;
  /** DEVELOPMENT ONLY. "1" saves emails to R2 instead of sending them, and only when APP_URL is localhost. Never set in wrangler.jsonc. */
  MAIL_SINK?: string;
}

export interface AuthUser extends Actor {
  mustChangePassword: boolean;
  sessionId: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser; ctx: ExecutionContext } };

/** Is this email address a super user? Compared trimmed and case-insensitively against SUPERUSER_EMAILS. */
export function isSuperuserEmail(env: { SUPERUSER_EMAILS?: string }, email: string | null | undefined): boolean {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return false;
  return String(env.SUPERUSER_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).includes(e);
}
export const isSuperuser = (env: { SUPERUSER_EMAILS?: string }, actor: { email: string }) => isSuperuserEmail(env, actor.email);
