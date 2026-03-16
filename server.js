const express = require('express');
const Database = require('better-sqlite3');
const https = require('https');
const path = require('path');
require('dotenv').config();

const app = express();
const db = new Database(path.join(__dirname, 'crm.db'));

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Contacts ─────────────────────────────────────────────────────────────────

app.get('/api/sync', (req, res) => {
  const contacts = db.prepare('SELECT data FROM contacts ORDER BY rowid').all()
    .map(r => JSON.parse(r.data));
  const quotaRow = db.prepare("SELECT value FROM settings WHERE key = 'quota'").get();
  const icpRow = db.prepare("SELECT value FROM settings WHERE key = 'icpConfig'").get();
  res.json({
    contacts,
    quota: quotaRow ? JSON.parse(quotaRow.value) : null,
    icpConfig: icpRow ? JSON.parse(icpRow.value) : null
  });
});

app.post('/api/sync', (req, res) => {
  const { contacts, quota, icpConfig } = req.body;
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts must be array' });

  const upsert = db.prepare('INSERT OR REPLACE INTO contacts (id, data) VALUES (?, ?)');
  const syncAll = db.transaction((contacts, quota, icpConfig) => {
    db.prepare('DELETE FROM contacts').run();
    for (const c of contacts) upsert.run(c.id, JSON.stringify(c));
    if (quota)
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('quota', ?)").run(JSON.stringify(quota));
    if (icpConfig)
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('icpConfig', ?)").run(JSON.stringify(icpConfig));
  });

  syncAll(contacts, quota, icpConfig);
  res.json({ ok: true });
});

// ─── Templates ────────────────────────────────────────────────────────────────

app.get('/api/templates', (req, res) => {
  const rows = db.prepare('SELECT data FROM templates ORDER BY rowid').all();
  res.json(rows.map(r => JSON.parse(r.data)));
});

app.post('/api/templates/sync', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'body must be array' });
  const upsert = db.prepare('INSERT OR REPLACE INTO templates (id, data) VALUES (?, ?)');
  const syncTemplates = db.transaction((templates) => {
    db.prepare('DELETE FROM templates').run();
    for (const t of templates) upsert.run(t.id, JSON.stringify(t));
  });
  syncTemplates(req.body);
  res.json({ ok: true });
});

// ─── AI Proxy (keeps API key server-side) ─────────────────────────────────────

app.post('/api/ai', (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  const body = JSON.stringify(req.body);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      try {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
      } catch (e) {
        res.status(502).json({ error: 'Invalid response from AI service' });
      }
    });
  });

  proxyReq.on('error', (e) => {
    console.error('AI proxy error:', e.message);
    res.status(502).json({ error: 'Failed to reach AI service' });
  });

  proxyReq.write(body);
  proxyReq.end();
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nTariq CRM running at http://localhost:${PORT}`);
  console.log(`AI features: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled (set ANTHROPIC_API_KEY in .env)'}\n`);
});
