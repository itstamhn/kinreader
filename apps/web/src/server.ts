import { Spiceflow } from 'spiceflow';
import { z } from 'zod';
import { sendMagicLinkEmail } from './lib/autosend';

interface MagicLinkBody { email?: string; autosendApiKey?: string }
interface VerifyBody { email?: string; code?: string; token?: string }
type AuthRecord = { code: string; token: string; expires: number; attempts: number; name?: string; avatar?: string };

// Same error body for "unknown email", "wrong code", "expired record" and
// "attempts exhausted" -- distinguishing them would give an attacker an
// enumeration oracle.
function invalidCodeResponse(): Response {
  return new Response(JSON.stringify({ error: 'Invalid or expired verification code' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Uniform random 6-digit code via crypto.getRandomValues with rejection
// sampling, so no value is more likely than another (a plain `% 900000` on a
// raw uint32 would bias toward low codes).
export function secureSixDigitCode(): string {
  const max = 900000;
  // Largest multiple of `max` that fits in a uint32, so rejection is unbiased.
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0]!;
  } while (n >= limit);
  return (100000 + (n % max)).toString();
}

// The origin Google redirects back to. It has to be byte-identical between the
// auth request and the token exchange, and registered in the Google Cloud
// console -- so it cannot be derived from the incoming request. Deriving it is
// what broke sign-in away from the canonical domain: every other hostname
// (`www.`, `*.workers.dev`, a preview URL) produces a redirect_uri Google has
// never seen, and Google rejects it with a 400 `redirect_uri_mismatch` on its
// own error page, before the browser is ever sent back to us.
//
// Plan 014 moved the reader to its own subdomain: the apex serves the Astro
// marketing site now, so a fallback pointing there would send OAuth to a page
// that cannot complete it.
const DEFAULT_APP_ORIGIN = 'https://app.kinreader.com';

export function canonicalOrigin(env: any, request: Request): string {
  const configured = typeof env?.APP_ORIGIN === 'string' ? env.APP_ORIGIN.trim() : '';
  if (configured) return configured.replace(/\/+$/, '');

  const { hostname, origin } = new URL(request.url);
  // Local dev (`bun src/server.ts`, the Vite proxy, `wrangler dev`) and tests
  // keep their own origin -- they have their own OAuth client registration.
  if (hostname === 'localhost' || hostname === '127.0.0.1') return origin;

  return DEFAULT_APP_ORIGIN;
}

// Every Google failure path ends here. The client reads `auth_error` on mount
// and reopens the sign-in modal with the message (src/App.tsx). Before that
// existed, a failed sign-in dropped the user on a normal-looking home screen
// with the reason buried in a query string -- and on mobile, where the address
// bar is collapsed, that is indistinguishable from the button doing nothing.
function redirectWithAuthError(
  origin: string,
  message: string,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}/?auth_error=${encodeURIComponent(message)}`,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function googleErrorMessage(error: string): string {
  switch (error) {
    case 'access_denied':
      return 'Google sign-in was cancelled';
    case 'admin_policy_enforced':
      return 'Your Google administrator has blocked sign-in for this app';
    default:
      return 'Google sign-in failed. Please try again, or use email below.';
  }
}

export const OAUTH_STATE_COOKIE = 'kr_oauth_state';
const OAUTH_STATE_TTL_SECONDS = 600;

// SameSite=Lax, not Strict: the cookie has to ride along on Google's top-level
// GET redirect back to us, and Strict withholds it on cross-site navigation --
// which would fail every single sign-in.
function stateCookie(state: string, origin: string): string {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_SECONDS}${secure}`;
}

function clearedStateCookie(origin: string): string {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export const app = new Spiceflow()
  // Health Check
  .get('/api/health', () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))

  // 0. AutoSend Magic Sign-In Email Endpoint
  .post('/api/auth/magic-link', async ({ request }) => {
    try {
      const body = (await request.json()) as MagicLinkBody;
      const email = body.email?.trim().toLowerCase();

      if (!email || !email.includes('@')) {
        return new Response(JSON.stringify({ error: 'Valid email address is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
      const autosendKey = env.AUTOSEND_API_KEY || body.autosendApiKey;

      if (!autosendKey) {
        return new Response(JSON.stringify({ error: 'AutoSend API key is not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Generate 6-digit code + secure token
      const code = secureSixDigitCode();
      const token = crypto.randomUUID();
      const expires = Date.now() + 15 * 60 * 1000; // 15 minutes

      await putAuthRecord(env, email, { code, token, expires, attempts: 0 });

      const urlObj = new URL(request.url);
      const magicUrl = `${urlObj.origin}/?auth_token=${token}&email=${encodeURIComponent(email)}`;

      await sendMagicLinkEmail({
        to: email,
        magicUrl,
        code,
        apiKey: autosendKey,
        fromEmail: 'login@mail.kinreader.com',
        fromName: 'KinReader',
      });

      return {
        success: true,
        message: `Magic link sent to ${email}`,
      };
    } catch (err: any) {
      console.error('Magic link error:', err);
      return new Response(JSON.stringify({ error: err.message || 'Failed to send magic link' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  })

  // 0.1 Verify Magic Link or Code
  .post('/api/auth/verify', async ({ request }) => {
    try {
      const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};

      // Use cf-connecting-ip, never a client-settable forwarded-for style
      // header -- that would let an attacker reset their own limiter key.
      const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
      const allowed = await checkRateLimit(env, `auth:${clientIp}`);
      if (!allowed) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again in a minute.' }),
          { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } }
        );
      }

      const body = (await request.json()) as VerifyBody;
      const email = body.email?.trim().toLowerCase();
      const code = body.code?.trim();
      const token = body.token?.trim();

      if (!email) {
        return new Response(JSON.stringify({ error: 'Email is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const record = await getAuthRecord(env, email);
      if (!record || Date.now() > record.expires) {
        return invalidCodeResponse();
      }

      const isValid = (code && record.code === code) || (token && record.token === token);
      if (!isValid) {
        const attempts = (record.attempts || 0) + 1;
        if (attempts >= 5) {
          // Burn the code: brute-forcing costs the attacker the code rather
          // than letting them keep guessing indefinitely.
          await deleteAuthRecord(env, email);
        } else {
          // Preserve the remaining TTL rather than resetting the 15-minute
          // window on every wrong guess.
          const remainingTtlSeconds = Math.max(
            60,
            Math.ceil((record.expires - Date.now()) / 1000)
          );
          await putAuthRecord(env, email, { ...record, attempts }, remainingTtlSeconds);
        }
        return invalidCodeResponse();
      }

      // Clear used code
      await deleteAuthRecord(env, email);

      const username = email.split('@')[0] ?? email;
      return {
        success: true,
        user: {
          email,
          name: record.name || username.charAt(0).toUpperCase() + username.slice(1),
          avatar: record.avatar || `https://unavatar.io/${encodeURIComponent(email)}`,
          tier: 'pro',
        },
      };
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message || 'Verification failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  })

  // 0.2 Google OAuth Initiation Endpoint
  .get('/api/auth/google', ({ request }) => {
    const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
    const origin = canonicalOrigin(env, request);
    const urlObj = new URL(request.url);

    // Bounce the user onto the canonical origin before anything else, so the
    // state cookie is set on the same host that will receive the callback and
    // the redirect_uri below always matches what Google has registered.
    // `canonical=1` caps that at one hop: a dev proxy that rewrites `Host`
    // (Vite's `changeOrigin`) makes the bounce look permanently necessary, and
    // an unguarded check would spin.
    if (urlObj.origin !== origin && urlObj.searchParams.get('canonical') !== '1') {
      return new Response(null, {
        status: 302,
        headers: { Location: `${origin}/api/auth/google?canonical=1`, 'Cache-Control': 'no-store' },
      });
    }

    const clientId = env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return redirectWithAuthError(origin, 'Google sign-in is not configured yet — use email sign-in below.');
    }

    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${origin}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        'Set-Cookie': stateCookie(state, origin),
        'Cache-Control': 'no-store',
      },
    });
  })

  // 0.3 Google OAuth Callback Endpoint
  .get('/api/auth/google/callback', async ({ request }) => {
    const urlObj = new URL(request.url);
    const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
    const origin = canonicalOrigin(env, request);
    // The state cookie has done its job by the time we get here, whichever way
    // this request ends -- clear it on every path so a stale value can never
    // authorise a later callback.
    const clearCookie = { 'Set-Cookie': clearedStateCookie(origin) };

    // Google reports user-visible failures (a cancelled consent screen, an
    // admin policy block) as ?error=, not as an exception on our side.
    const googleError = urlObj.searchParams.get('error');
    if (googleError) {
      return redirectWithAuthError(origin, googleErrorMessage(googleError), clearCookie);
    }

    const code = urlObj.searchParams.get('code');
    const state = urlObj.searchParams.get('state');
    const expectedState = readCookie(request.headers.get('Cookie'), OAUTH_STATE_COOKIE);

    // Login CSRF: without a state check, anyone can hand a victim a callback
    // URL carrying their own authorization code and silently sign the victim
    // into the attacker's account.
    if (!state || !expectedState || state !== expectedState) {
      return redirectWithAuthError(origin, 'Sign-in session expired. Please try again.', clearCookie);
    }

    if (!code) {
      return redirectWithAuthError(origin, 'Google did not return an authorization code', clearCookie);
    }

    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return redirectWithAuthError(origin, 'Google sign-in is not configured yet — use email sign-in below.', clearCookie);
    }

    try {
      // Exchange authorization code for tokens. `redirect_uri` has to be
      // byte-identical to the one sent on the auth request above.
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: `${origin}/api/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });

      const tokenData = (await tokenRes.json()) as any;
      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData?.error_description || 'Could not complete the Google sign-in');
      }

      // Fetch Google User Profile
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userRes.ok) {
        throw new Error('Could not read your Google profile');
      }
      const googleUser = (await userRes.json()) as any;

      // A profile with no usable email used to sail straight through: the
      // record was written under the key `auth:undefined` and the browser was
      // sent to `/?auth_token=...&email=undefined`, which then failed
      // verification with nothing at all shown to the user.
      const email = typeof googleUser?.email === 'string' ? googleUser.email.trim().toLowerCase() : '';
      if (!email.includes('@')) {
        throw new Error('Your Google account did not return an email address');
      }
      if (googleUser.email_verified === false) {
        throw new Error('Your Google email address is not verified');
      }

      const token = crypto.randomUUID();
      const expires = Date.now() + AUTH_TTL_SECONDS * 1000;

      // Register session
      await putAuthRecord(env, email, {
        code: 'GOOGLE_OAUTH',
        token,
        expires,
        attempts: 0,
        name: googleUser.name || undefined,
        avatar: googleUser.picture || undefined,
      });

      return new Response(null, {
        status: 302,
        headers: {
          Location: `${origin}/?auth_token=${token}&email=${encodeURIComponent(email)}`,
          'Cache-Control': 'no-store',
          ...clearCookie,
        },
      });
    } catch (err: any) {
      console.error('Google OAuth error:', err);
      return redirectWithAuthError(origin, err?.message || 'Google sign-in failed', clearCookie);
    }
  });

const AUTH_TTL_SECONDS = 15 * 60;

async function checkRateLimit(env: any, key: string): Promise<boolean> {
  // No binding (local `bun src/server.ts`, or tests) -- allow.
  if (!env?.AUTH_RATE_LIMITER) return true;
  try {
    const { success } = await env.AUTH_RATE_LIMITER.limit({ key });
    return success;
  } catch {
    // Limiter unavailable -- allow rather than break login. The attempt
    // counter in KV enforces the real defence independently of this limiter.
    return true;
  }
}

async function putAuthRecord(
  env: any,
  email: string,
  record: AuthRecord,
  ttlSeconds: number = AUTH_TTL_SECONDS
): Promise<void> {
  if (!env.AUTH_CODES) throw new Error('AUTH_CODES KV namespace is not bound');
  await env.AUTH_CODES.put(`auth:${email}`, JSON.stringify(record), {
    expirationTtl: ttlSeconds,
  });
}

async function getAuthRecord(env: any, email: string): Promise<AuthRecord | null> {
  if (!env.AUTH_CODES) return null;
  const raw = await env.AUTH_CODES.get(`auth:${email}`);
  return raw ? (JSON.parse(raw) as AuthRecord) : null;
}

async function deleteAuthRecord(env: any, email: string): Promise<void> {
  if (!env.AUTH_CODES) return;
  await env.AUTH_CODES.delete(`auth:${email}`);
}

// Start Spiceflow standalone if executed directly
if (import.meta.main) {
  const PORT = Number(process.env.API_PORT) || 3008;
  Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    fetch(req) {
      return app.handle(req);
    },
  });
  console.log(`✨ Spiceflow backend running on http://127.0.0.1:${PORT}`);
}
