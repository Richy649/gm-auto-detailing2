import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { router as api } from './src/routes.js';

const app = express();

// Allow your Vercel domain (and local dev) to call the API
const origins = (process.env.FRONTEND_ORIGIN || '*').split(',');
app.use(cors({ origin: origins, credentials: true }));
app.use(express.json());

// Friendly root so you don't see "Cannot GET /"
app.get('/', (req, res) => {
  res.type('text').send(
    [
      'GM Booking API is running.',
      '',
      'Try:',
      '  • /health',
      '  • /api/config',
      '  • POST /api/availability',
      '  • POST /api/book',
    ].join('\n')
  );
});

// Quick health
app.get('/health', (req, res) => res.json({ ok: true }));

// API
app.use('/api', api);

// Helpful /api root
app.get('/api', (req, res) => {
  res.json({
    ok: true,
    endpoints: ['/api/config', 'POST /api/availability', 'POST /api/book'],
  });
});

const PORT = process.env.PORT || 8787; // Render provides PORT
app.listen(PORT, () => console.log(`API running on :${PORT}`));
