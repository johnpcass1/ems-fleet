/** Logged-out screens for email links: "Forgot password?" and the set-password page. Also the password-field helpers the Users screen shares. */
import { S } from './state';
import { $, esc } from './util';
import { brandHtml } from './bits';

export const MIN_PW = 10;

/** A readable random password (no 0/O/1/l/I), like 4 groups of 4. Typed in by an administrator for someone else. */
export function generatePassword(): string {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map((x) => A[x % A.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
/** Same checks as the server (which has the final say). Returns a message, or '' when fine. */
export function passwordProblem(p1: string, p2: string, email = ''): string {
  if (p1.length < MIN_PW) return `Use at least ${MIN_PW} characters.`;
  if (p1.length > 200) return 'That password is too long.';
  if (email && p1.toLowerCase() === email.toLowerCase()) return 'The password cannot be the email address.';
  if (/^(.)\1+$/.test(p1)) return 'Choose a password that is not one repeated character.';
  if (p1 !== p2) return 'The two passwords do not match.';
  return '';
}

/** Two password fields with Generate and Show. `p` is an id prefix. */
export function pwFieldsHtml(p: string) {
  return `<label class="f"><span class="l">Password</span><input id="${p}-pw" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" maxlength="200"><span class="hint">At least ${MIN_PW} characters. You can hand it over in person or by phone.</span></label>
    <label class="f"><span class="l">Password again</span><input id="${p}-pw2" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" maxlength="200"></label>
    <div class="row" style="margin:-2px 0 12px"><button class="btn sm" type="button" data-act="gen-pw" data-p="${p}" id="${p}-gen">Generate</button><button class="btn sm" type="button" data-act="toggle-pw" data-p="${p}" id="${p}-show" aria-pressed="false">Show</button></div>`;
}

/* ---------- forgot password ---------- */
export function showForgot() {
  document.body.classList.add('loggedout');
  $('#view').innerHTML = `<div class="loginwrap">${brandHtml()}<div class="panel"><div class="pb"><h1>Reset your password</h1><p class="muted small">Enter your email address and we will send you a link to choose a new password.</p>
    <form id="forgotForm" novalidate>
      <label class="f"><span class="l">Email</span><input id="fg-email" type="email" autocomplete="username" required autocapitalize="off" spellcheck="false"></label>
      <div id="fg-err" class="warnbox bad" role="alert" hidden></div>
      <button class="btn primary block" type="submit" id="fg-submit">Send reset link</button>
    </form><p class="small" style="margin:14px 0 0"><a href="/" data-act="to-login" id="fg-back">Back to log in</a></p></div></div></div>`;
  $('#fg-email').focus();
}
export function showForgotDone(message: string) {
  $('#view').innerHTML = `<div class="loginwrap">${brandHtml()}<div class="panel"><div class="pb"><h1>Check your email</h1><div class="warnbox" role="status" id="fg-done">${esc(message)}</div>
    <p class="small muted">The link works for one hour. If nothing arrives in a few minutes, look in your spam folder, or ask your fleet manager.</p>
    <p class="small" style="margin:14px 0 0"><a href="/" data-act="to-login" id="fg-back">Back to log in</a></p></div></div></div>`;
}

/* ---------- the page behind the emailed link ---------- */
export interface LinkInfo { valid: boolean; reason?: 'expired' | 'used' | 'invalid'; purpose?: 'invite' | 'reset' | null; email?: string; name?: string }

const frame = (inner: string) => { document.body.classList.add('loggedout'); $('#view').innerHTML = `<div class="loginwrap">${brandHtml()}<div class="panel"><div class="pb">${inner}</div></div></div>`; };

export function showLinkProblem(info: LinkInfo | null) {
  const reset = info?.purpose === 'reset';
  const forgot = S.emailEnabled && (reset || !info?.purpose) ? '<p class="small" style="margin:10px 0 0"><a href="/" data-act="forgot" id="sp-forgot">Send me a new reset link</a></p>' : '';
  let msg: string, h = 'This link cannot be used';
  if (!info) { msg = 'This page needs the link from your email. Open the link in the email again.'; }
  else if (info.reason === 'expired') { h = 'This link has expired'; msg = reset ? 'Reset links only work for one hour.' : 'This link has expired. Ask your fleet manager to send a new one.'; }
  else if (info.reason === 'used') { h = 'This link was already used'; msg = 'If you have chosen your password, you can log in now.'; }
  else msg = 'This link is not valid. Check that you opened the whole link from the email.';
  frame(`<h1>${esc(h)}</h1><div class="warnbox" role="alert" id="sp-problem">${esc(msg)}</div>${forgot}<p class="small" style="margin:10px 0 0"><a href="/" id="sp-login">Go to log in</a></p>`);
}
export function showSetPassword(info: LinkInfo) {
  const reset = info.purpose === 'reset';
  frame(`<h1>${reset ? 'Reset your password' : 'Welcome to GEMA Fleet'}</h1>
    <p class="muted small" id="sp-hello">${reset ? `Hi ${esc(info.name)}, choose a new password.` : `Hi ${esc(info.name)}, choose a password for GEMA Fleet.`}</p>
    <form id="spForm" novalidate>
      <input type="email" value="${esc(info.email)}" autocomplete="username" hidden readonly tabindex="-1" aria-hidden="true">
      <label class="f"><span class="l">New password</span><input id="sp-new" type="password" autocomplete="new-password" required minlength="${MIN_PW}"><span class="hint">At least ${MIN_PW} characters. A few random words is a good choice.</span></label>
      <label class="f"><span class="l">New password again</span><input id="sp-new2" type="password" autocomplete="new-password" required></label>
      <div id="sp-err" class="warnbox bad" role="alert" hidden></div>
      <button class="btn primary block" type="submit" id="sp-submit">Save password and log in</button>
    </form>`);
  $('#sp-new').focus();
}
