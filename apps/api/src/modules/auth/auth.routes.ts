import { Router } from 'express';
import { googleLoginSchema, passwordLoginSchema } from '@reachinbox/shared';
import { env, isGoogleAuthConfigured } from '../../config/env.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { authLimiter } from '../../middleware/apiRateLimit.js';
import { requireAuth, SESSION_COOKIE, sessionCookieOptions } from '../../middleware/auth.js';
import {
  issueSessionToken,
  loginWithPassword,
  toPublicUser,
  upsertGoogleUser,
  verifyGoogleCredential,
} from './auth.service.js';

export const authRouter: Router = Router();

/**
 * Lets the login screen render honestly: it shows the Google button only when
 * the server can actually verify a Google token, and the demo form only when
 * that path is enabled.
 */
authRouter.get('/config', (_req, res) => {
  res.json({
    data: {
      googleEnabled: isGoogleAuthConfigured,
      googleClientId: env.GOOGLE_CLIENT_ID || null,
      passwordLoginEnabled: env.ALLOW_PASSWORD_LOGIN,
      demoEmail: env.ALLOW_PASSWORD_LOGIN ? env.DEMO_USER_EMAIL : null,
    },
  });
});

authRouter.post(
  '/google',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { credential } = googleLoginSchema.parse(req.body);

    const profile = await verifyGoogleCredential(credential);
    const user = await upsertGoogleUser(profile);

    res.cookie(SESSION_COOKIE, issueSessionToken(user), sessionCookieOptions());
    res.json({ data: { user: toPublicUser(user) } });
  }),
);

authRouter.post(
  '/password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = passwordLoginSchema.parse(req.body);

    const user = await loginWithPassword(email, password);

    res.cookie(SESSION_COOKIE, issueSessionToken(user), sessionCookieOptions());
    res.json({ data: { user: toPublicUser(user) } });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ data: { user: toPublicUser(req.user!) } });
  }),
);

authRouter.post('/logout', (_req, res) => {
  // Same attributes as when it was set, otherwise the browser keeps the cookie.
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
  res.json({ data: { ok: true } });
});
