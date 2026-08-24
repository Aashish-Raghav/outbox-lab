import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import type { User } from '@prisma/client';
import { env, isGoogleAuthConfigured } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { AppError, UnauthorizedError } from '../../lib/errors.js';
import { scopedLogger } from '../../lib/logger.js';

const log = scopedLogger('auth');

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

export interface SessionClaims {
  sub: string;
  email: string;
}

/**
 * Verifies a Google Identity Services ID token.
 *
 * This is the real OAuth check, not a decode: `verifyIdToken` validates the
 * signature against Google's published keys, the issuer, the expiry, and — the
 * part that actually matters for security — that the `aud` claim is *our*
 * client id. Skipping the audience check would let a token minted for any other
 * Google app be replayed against this API.
 */
export async function verifyGoogleCredential(credential: string): Promise<{
  googleSub: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}> {
  if (!isGoogleAuthConfigured) {
    throw new AppError('Google sign-in is not configured on this server', {
      statusCode: 503,
      code: 'GOOGLE_AUTH_UNCONFIGURED',
    });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (error) {
    log.warn({ err: (error as Error).message }, 'google id token rejected');
    throw new UnauthorizedError('Google sign-in failed. Please try again.');
  }

  if (!payload?.sub || !payload.email) {
    throw new UnauthorizedError('Google did not return a usable profile');
  }

  if (payload.email_verified === false) {
    throw new UnauthorizedError('That Google account has an unverified email address');
  }

  return {
    googleSub: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email.split('@')[0]!,
    avatarUrl: payload.picture ?? null,
  };
}

/**
 * Finds or creates the local user for a Google identity.
 *
 * Matching is on `googleSub` first, because Google's subject claim is stable
 * while an email address can be changed or reassigned. The email lookup is the
 * fallback that links an existing demo account to a Google identity on first
 * sign-in.
 */
export async function upsertGoogleUser(profile: {
  googleSub: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}): Promise<User> {
  const existing =
    (await prisma.user.findUnique({ where: { googleSub: profile.googleSub } })) ??
    (await prisma.user.findUnique({ where: { email: profile.email } }));

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        googleSub: profile.googleSub,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
      },
    });
  }

  return prisma.user.create({ data: profile });
}

/**
 * Demo email/password login.
 *
 * The Figma's login screen has an email + password form alongside the Google
 * button. Implementing a full local credential store was out of scope, so this
 * is a single configured account that exists to let the dashboard be opened
 * without Google credentials. `env.ts` refuses to boot if it is left enabled in
 * production.
 */
export async function loginWithPassword(email: string, password: string): Promise<User> {
  if (!env.ALLOW_PASSWORD_LOGIN) {
    throw new AppError('Password sign-in is disabled. Use “Login with Google”.', {
      statusCode: 403,
      code: 'PASSWORD_LOGIN_DISABLED',
    });
  }

  const emailMatches = email.toLowerCase() === env.DEMO_USER_EMAIL.toLowerCase();
  const passwordMatches = password === env.DEMO_USER_PASSWORD;

  if (!emailMatches || !passwordMatches) {
    throw new UnauthorizedError('Incorrect email or password');
  }

  const normalised = env.DEMO_USER_EMAIL.toLowerCase();

  return prisma.user.upsert({
    where: { email: normalised },
    update: {},
    create: { email: normalised, name: 'Demo User', avatarUrl: null },
  });
}

export function issueSessionToken(user: User): string {
  const claims: SessionClaims = { sub: user.id, email: user.email };
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    issuer: 'reachinbox-scheduler',
  });
}

export function verifySessionToken(token: string): SessionClaims {
  try {
    return jwt.verify(token, env.JWT_SECRET, { issuer: 'reachinbox-scheduler' }) as SessionClaims;
  } catch {
    throw new UnauthorizedError('Your session has expired. Please sign in again.');
  }
}

export function toPublicUser(user: User) {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl };
}
