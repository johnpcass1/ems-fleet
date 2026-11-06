import type { Actor } from '../shared/perm';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  /** Public address of the app, e.g. https://fleet.example.gy. Used for the same-origin check. */
  APP_URL: string;
  /** PBKDF2 iterations for new password hashes. Calibrated for the Workers Free 10 ms CPU limit. See docs/SECURITY.md. */
  PBKDF2_ITERATIONS?: string;
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
