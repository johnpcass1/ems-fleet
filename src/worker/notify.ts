import type { Env } from './env';

/**
 * Hook called (through ctx.waitUntil) every time a problem is reported.
 * Email alerts are a planned later addition (see docs/HANDOVER.md, "Possible later additions").
 * Today this does nothing on purpose.
 */
export async function notifyIssueReported(_env: Env, _issue: unknown, _vehicle: unknown): Promise<void> {
  /* no-op */
}
