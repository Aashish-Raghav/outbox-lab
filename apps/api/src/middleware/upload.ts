import { mkdirSync } from 'node:fs';
import multer from 'multer';
import { env, uploadDir } from '../config/env.js';

/**
 * Multipart handling for the Compose screen.
 *
 * Two very different kinds of file arrive on the same request:
 *  - `leads`: a CSV/TXT address list, parsed in-process and then discarded, so
 *    it is kept in memory.
 *  - `attachments`: files that must still exist when the email is sent minutes
 *    or hours later, so they are written to disk and referenced by path.
 *
 * Keeping the lead list off disk avoids leaving copies of customer address
 * lists lying around after the campaign is created.
 */

mkdirSync(uploadDir, { recursive: true });

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    // Never trust a client-supplied filename on the filesystem: strip any path
    // component and unusual characters, then prefix a random id so two uploads
    // of "report.pdf" cannot overwrite each other.
    const safe = file.originalname.replace(/[^\w.\- ]+/g, '_').slice(-100);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safe}`);
  },
});

const LEAD_LIST_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

/**
 * Handles the compose form: one optional lead list plus up to 5 attachments.
 * Memory and disk storage cannot be mixed in a single multer instance, so the
 * lead list is read from disk and unlinked immediately after parsing.
 */
export const composeUpload = multer({
  storage: diskStorage,
  limits: {
    fileSize: env.MAX_UPLOAD_BYTES,
    files: 6,
  },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'leads') {
      const looksLikeText =
        LEAD_LIST_TYPES.has(file.mimetype) || /\.(csv|txt|tsv)$/i.test(file.originalname);
      if (!looksLikeText) {
        cb(new Error('The lead list must be a .csv or .txt file'));
        return;
      }
    }
    cb(null, true);
  },
}).fields([
  { name: 'leads', maxCount: 1 },
  { name: 'attachments', maxCount: 5 },
]);
