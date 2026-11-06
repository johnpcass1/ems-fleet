import type { Actor } from '../shared/perm';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  /** Public address of the app, e.g. https://fleet.example.gy. Used for the same-origin check. */
  APP_URL: string;
  /** PBKDF2 iterations for new password hashes. Calibrated for the Workers Free 10 ms CPU limit. See docs/SECURITY.md. */
  PBKDF2_ITERATIONS?: string;
}

export interface AuthUser extends Actor {
  mustChangePassword: boolean;
  sessionId: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser; ctx: ExecutionContext } };
