import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { router as api } from './src/routes.js';

const app = express();
app.use(cors({ origin: (process.env.FRONTEND_ORIGIN || '*').split(','), credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', api);

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`API running on :${PORT}`));
