import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { router as api } from './src/routes.js';

const app = express();

/** CORS setup
 *  - If CORS_ALLOW_ALL=1 → allow all origins (quick unblocking)
 *  - Else use FRONTEND_ORIGIN (comma-separated) for exact matches
 *  - You can also add CORS_SUFFIX (comma-separated) for suffix matches, e.g. ".vercel.app"
 */
const allowAll = process.env.CORS_ALLOW_ALL === '1';
const exactList = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const suffixList = (process.env.CORS_SUFFIX || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsDelegate = (req, cb) => {
  const origin = req.header('Origin');
  if (allowAll || !origin) return cb(null, { origin: true, credentials: true });

  const exactOK = exactList.includes(origin);
  const suffixOK = suffixList.some(sfx => origin.endsWith(sfx));
  const ok = exactOK || suffixOK;

  cb(null, { origin: ok, credentials: true });
};

app.use(cors(corsDelegate));
app.options('*', cors(corsDelegate)); // handle preflight
app.use(express.json());

// Friendly root (so "/" doesn’t 502)
app.get('/', (req, res) => {
  res.type('text').send([
    'GM Booking API is running.',
    'Try:',
    '  • /health',
    '  • /api',
    '  • /api/config',
    '  • POST /api/availability',
    '  • POST /api/book',
  ].join('\n'));
});

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// API
app.use('/api', api);

// Helpful /api root
app.get('/api', (req, res) => {
  res.json({
    ok: true,
    endpoints: ['/api/config', 'POST /api/availability', 'POST /api/book'],
    cors_allow_all: allowAll,
    allow_exact: exactList,
    allow_suffix: suffixList
  });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`API running on :${PORT}`));
