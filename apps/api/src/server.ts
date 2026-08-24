import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { createBullBoard } from '@bull-board/api';
// Subpath has no extension: it is an explicit entry in @bull-board's export map.
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { env, isProduction } from './config/env.js';
import { emailQueue } from './queue/emailQueue.js';
import { httpLogger, requestId } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { generalLimiter } from './middleware/apiRateLimit.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { campaignsRouter } from './modules/campaigns/campaigns.routes.js';
import { emailsRouter, statsRouter } from './modules/emails/emails.routes.js';
import { sendersRouter } from './modules/senders/senders.routes.js';
import { healthRouter } from './modules/health/health.routes.js';

/**
 * Builds the Express application.
 *
 * A factory rather than a module-level singleton so the integration tests can
 * spin up an isolated app per suite and hand it straight to supertest without
 * binding a port.
 */
export function createServer(): Express {
  const app = express();

  // Behind a reverse proxy the client IP arrives in X-Forwarded-For; without
  // this, express-rate-limit would bucket every request under the proxy's IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and the dashboard is a separate origin, so the
      // restrictive default CSP/CORP would only break Bull Board's assets.
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      // The session is an httpOnly cookie, so credentials must be allowed and
      // the origin must be echoed exactly — `*` is not permitted with them.
      origin: env.CORS_ORIGINS,
      credentials: true,
      exposedHeaders: ['x-request-id'],
    }),
  );

  app.use(compression());
  app.use(cookieParser());
  // Generous enough for a rich-text body with inline images, bounded to stop a
  // single request exhausting memory. File uploads bypass this via multer.
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  app.use(requestId);
  app.use(httpLogger);

  // Health is registered before the rate limiter: a probe must never be
  // throttled, or a busy instance would be declared dead.
  app.use('/api/health', healthRouter);

  app.use('/api', generalLimiter);
  app.use('/api/auth', authRouter);
  app.use('/api/senders', sendersRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/emails', emailsRouter);
  app.use('/api/stats', statsRouter);

  // Queue inspector — genuinely useful for demonstrating delayed jobs, but it
  // exposes job payloads, so it stays out of production builds.
  if (!isProduction) {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: [new BullMQAdapter(emailQueue)],
      serverAdapter,
    });
    app.use('/admin/queues', serverAdapter.getRouter());
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
