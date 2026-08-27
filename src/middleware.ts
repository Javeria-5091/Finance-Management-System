// ═════════════════════════════════════════════════════════════════════
// NEXT.JS MIDDLEWARE — Centralized route protection
// Gap Report 7.7: middleware.ts was MISSING. Route protection was only
// in individual layout components (inconsistent, easy to miss).
//
// This middleware handles:
// 1. Authentication check for all /dashboard routes
// 2. Redirect unauthenticated users to /login
// 3. Block direct access to API routes without session
// ═════════════════════════════════════════════════════════════════════

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

// Routes that don't require authentication
const PUBLIC_ROUTES = ['/', '/login', '/signup'];

// API routes that handle their own auth
const API_AUTH_ROUTES = ['/api/auth/'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public routes
  if (PUBLIC_ROUTES.some(route => pathname === route)) {
    return NextResponse.next();
  }

  // Allow static files and Next.js internals
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // ── Build response early so we can set cookies on it ──
  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response = NextResponse.next({
              request: { headers: request.headers },
            });
            response.cookies.set(name, value, options as CookieOptions);
          });
        },
      },
    }
  );

  const {
    data: { session },
  } = await supabase.auth.getSession();

  // ── Unauthenticated: redirect to login ──
  if (!session) {
    if (pathname.startsWith('/api/')) {
      if (API_AUTH_ROUTES.some(route => pathname.startsWith(route))) {
        return response;
      }
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};