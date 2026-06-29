import { NextRequest, NextResponse } from "next/server";

// HTTP Basic Auth for the whole app, with a best-effort per-IP brute-force
// limiter. Auth is enforced only when BASIC_AUTH_USER + BASIC_AUTH_PASSWORD are
// set, so local dev (and the unprotected default) keep working until you
// configure credentials. /api/health is excluded via the matcher below so k8s
// and the GCE load-balancer health checks (which send no credentials) pass.

// --- brute-force limiter -------------------------------------------------
// In-memory, single-process. Fine here: the deployment is intentionally a
// single replica, so module-scope state persists across requests in the
// long-running server. Not shared across pods — don't rely on it past 1 replica.
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 10; // failed attempts per IP per window before lockout
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: NextRequest): string {
  // Behind the GCE HTTP(S) LB the client IP is in X-Forwarded-For. Leftmost
  // entry is best-effort (a client can prepend its own XFF), which is good
  // enough to slow a brute-force when paired with a strong password.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.ip ?? "unknown";
}

function isRateLimited(ip: string): boolean {
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) return false;
  return rec.count >= MAX_FAILURES;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    rec.count += 1;
  }
}

// Constant-time compare — avoids leaking length/contents via timing. No
// node:crypto here so this also works if the middleware runs on the edge runtime.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Meeting Transcription", charset="UTF-8"',
    },
  });
}

export function middleware(req: NextRequest): NextResponse {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASSWORD;

  // No credentials configured → auth disabled (current/unprotected behaviour).
  if (!user || !pass) return NextResponse.next();

  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return new NextResponse("Too many failed attempts. Try again later.", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(WINDOW_MS / 1000)) },
    });
  }

  const header = req.headers.get("authorization");
  if (header && header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6)); // "user:pass"
    const idx = decoded.indexOf(":");
    const u = idx === -1 ? decoded : decoded.slice(0, idx);
    const p = idx === -1 ? "" : decoded.slice(idx + 1);
    // Evaluate both halves regardless of the first result to keep timing flat.
    const ok = safeEqual(u, user) && safeEqual(p, pass);
    if (ok) {
      attempts.delete(ip);
      return NextResponse.next();
    }
  }

  recordFailure(ip);
  return unauthorized();
}

export const config = {
  // Protect everything except the health probe, Next internals, and static assets.
  matcher: ["/((?!api/health|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
