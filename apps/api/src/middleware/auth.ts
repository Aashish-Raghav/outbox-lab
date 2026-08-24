import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { env, isProduction } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { UnauthorizedError } from '../lib/errors.js';
import { verifySessionToken } from '../modules/auth/auth.service.js';

export const SESSION_COOKIE = 'reachinbox_session';

/**
 * Session cookie settings.
 *
 * `httpOnly` keeps the token out of reach of any script on the page, which is
 * the main reason the session lives in a cookie rather than localStorage.
 * `sameSite: lax` is enough here because the API is same-site with the
 * dashboard in the documented setup; a cross-site deployment needs `none` +
 * `secure`, which is what the production branch below does.
 */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function readToken(req: Request): string | null {
  const fromCookie = req.cookies?.[SESSION_COOKIE];
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;

  // Bearer tokens are accepted so the API can be exercised from Postman or curl
  // without juggling a cookie jar.
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  return null;
}

async function loadUser(req: Request): Promise<boolean> {
  const token = readToken(req);
  if (!token) return false;

  const claims = verifySessionToken(token);
  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  if (!user) return false;

  req.user = user;
  return true;
}

/** Rejects the request unless a valid session is present. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  loadUser(req)
    .then((ok) => {
      if (!ok) throw new UnauthorizedError();
      next();
    })
    .catch(next);
}

/** Attaches the user when there is one, but never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  loadUser(req)
    .then(() => next())
    .catch(() => next());
}

export { env };
