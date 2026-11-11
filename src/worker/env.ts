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
  /**
   * The home agency: the agency code the super user's account must belong to. Default 'GEMA'. An account with a super user's email in
   * any OTHER agency is an ordinary account. Set in wrangler.jsonc (top level and env.staging), so it also changes only with a code update.
   */
  SUPERUSER_AGENCY?: string;
  /** Secret (never in wrangler.jsonc): Resend API key. Set with `npx wrangler secret put RESEND_API_KEY`. See docs/EMAIL.md. */
  RESEND_API_KEY?: string;
  /** Sender shown on emails, e.g. "Fleet maintenance <no-reply@example.org>" (the same for every agency). An address on a domain verified in Resend. */
  MAIL_FROM?: string;
  /** DEVELOPMENT ONLY. "1" saves emails to R2 instead of sending them, and only when APP_URL is localhost. Never set in wrangler.jsonc. */
  MAIL_SINK?: string;
}

export interface AuthUser extends Actor {
  mustChangePassword: boolean;
  sessionId: string;
  /** Name of the agency the request works in (`agencyId`) and of the account's own agency. */
  agencyName: string;
  homeAgencyName: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser; ctx: ExecutionContext } };

/** The home agency code (upper case). */
export const homeAgency = (env: { SUPERUSER_AGENCY?: string }): string => (String(env.SUPERUSER_AGENCY ?? '').trim().toUpperCase() || 'GEMA');

/** Is this email address listed in SUPERUSER_EMAILS? Compared trimmed and case-insensitively. This alone does NOT make someone a super user: see isSuperuserAccount. */
export function isSuperuserEmail(env: { SUPERUSER_EMAILS?: string }, email: string | null | undefined): boolean {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return false;
  return String(env.SUPERUSER_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).includes(e);
}
/**
 * Is this ACCOUNT a super user? The email must be in SUPERUSER_EMAILS and the account must belong to the home agency (SUPERUSER_AGENCY).
 * The same email in any other agency is an ordinary account. `agencyId` is the account's own agency (users.agency_id), never the agency being viewed.
 */
export function isSuperuserAccount(env: { SUPERUSER_EMAILS?: string; SUPERUSER_AGENCY?: string }, email: string | null | undefined, agencyId: string | null | undefined): boolean {
  return isSuperuserEmail(env, email) && String(agencyId ?? '').toUpperCase() === homeAgency(env);
}
