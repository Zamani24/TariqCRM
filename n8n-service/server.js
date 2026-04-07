'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://localhost:5678';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-secret';

// ─── Middleware ────────────────────────────────────────────────────────────────

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:8080').split(',');

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Webhook signature validation middleware
function validateWebhook(req, res, next) {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  next();
}

// ─── AI Helper ────────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage, maxTokens = 800) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    },
    {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  );
  return response.data.content[0].text;
}

// ─── Automation Engines ────────────────────────────────────────────────────────

/**
 * Lead Enrichment: Given a new contact, use AI to research and enrich their profile
 */
async function runLeadEnrichment(contact, logId) {
  const systemPrompt = `You are a B2B sales intelligence expert. Given a contact's basic information,
produce a concise JSON enrichment object with insights that help a sales rep prioritize and personalize their outreach.

Return ONLY valid JSON with these fields:
{
  "talkingPoints": ["string", ...],
  "potentialPainPoints": ["string", ...],
  "suggestedApproach": "string",
  "estimatedBuyerRole": "Champion|Decision Maker|Influencer|Gatekeeper",
  "urgencySignals": ["string", ...],
  "recommendedFirstMessage": "string"
}`;

  const userMessage = `Contact to enrich:
Name: ${contact.name}
Title: ${contact.title || 'Unknown'}
Company: ${contact.company || 'Unknown'}
Industry: ${contact.industry || 'Unknown'}
Deal Value: $${contact.dealValue || 0}
Source: ${contact.source || 'Unknown'}
Notes: ${contact.notes || 'None'}`;

  const raw = await callClaude(systemPrompt, userMessage, 600);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned non-JSON response for enrichment');
  return JSON.parse(jsonMatch[0]);
}

/**
 * Email Sequence Step: Generate a personalized email for a specific sequence step
 */
async function generateSequenceEmail(contact, step, sequenceName) {
  const stepDescriptions = {
    1: 'first touch - introduce yourself and reference a specific insight about their company',
    2: 'follow-up - add value with a relevant resource or case study, keep it short',
    3: 'bump - light and friendly, ask if they saw your last email',
    4: 'break-up - gracefully close the loop, leave door open for future'
  };

  const systemPrompt = `You are an expert B2B SDR writing highly personalized, concise sales emails.
Write a ${stepDescriptions[step] || 'follow-up'} email.
Keep it under 120 words. No fluff. No generic intros like "Hope this finds you well."
Return ONLY valid JSON: { "subject": "...", "body": "..." }`;

  const userMessage = `Sequence: ${sequenceName}
Contact: ${contact.name}, ${contact.title} at ${contact.company}
Industry: ${contact.industry || 'Unknown'}
Deal Stage: ${contact.stage}
Deal Value: $${contact.dealValue || 0}
Recent Activity: ${JSON.stringify((contact.emails || []).slice(-2))}`;

  const raw = await callClaude(systemPrompt, userMessage, 400);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned non-JSON for email generation');
  return JSON.parse(jsonMatch[0]);
}

/**
 * Deal Health Monitor: Analyze all active deals and flag at-risk ones
 */
async function analyzeDealHealth(contacts) {
  const activeDeals = contacts.filter(c =>
    !['Closed Won', 'Closed Lost'].includes(c.data.stage)
  );

  if (activeDeals.length === 0) return [];

  const dealSummaries = activeDeals.map(c => ({
    id: c.id,
    name: c.data.name,
    company: c.data.company,
    stage: c.data.stage,
    dealValue: c.data.dealValue,
    daysInStage: c.data.daysInStage || 0,
    lastContact: c.data.lastContact,
    score: c.data.score,
    tasks: (c.data.tasks || []).filter(t => !t.done).length,
    bantScore: c.data.bantScore || 0
  }));

  const systemPrompt = `You are a sales operations expert analyzing a B2B pipeline.
Review these deals and identify risks and recommended actions.
Return ONLY a valid JSON array of at-risk deals:
[{
  "contactId": "string",
  "riskLevel": "high|medium|low",
  "riskReasons": ["string", ...],
  "recommendedActions": ["string", ...],
  "urgency": "string"
}]
Only include deals that need attention. Omit healthy deals.`;

  const raw = await callClaude(systemPrompt, JSON.stringify(dealSummaries), 900);
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  return JSON.parse(jsonMatch[0]);
}

/**
 * Post-Activity Follow-up: Generate next best action after a call or meeting
 */
async function generateFollowUp(contact, activity) {
  const systemPrompt = `You are an expert sales coach. After reviewing a sales activity,
suggest the optimal follow-up actions.
Return ONLY valid JSON:
{
  "followUpEmail": { "subject": "...", "keyPoints": ["..."] },
  "nextTask": { "title": "...", "priority": "high|medium", "daysFromNow": 1-7 },
  "coachingNote": "string (1 sentence observation for the rep)"
}`;

  const userMessage = `Contact: ${contact.name} (${contact.title} at ${contact.company})
Stage: ${contact.stage}
Activity Type: ${activity.type}
Activity Details: ${JSON.stringify(activity)}
Recent Activities: ${JSON.stringify([
  ...(contact.calls || []).slice(-1),
  ...(contact.meetings || []).slice(-1),
  ...(contact.emails || []).slice(-1)
])}`;

  const raw = await callClaude(systemPrompt, userMessage, 500);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned non-JSON for follow-up generation');
  return JSON.parse(jsonMatch[0]);
}

// ─── Routes: CRM → Service (inbound webhooks from the CRM) ────────────────────

// Sync contact data from CRM localStorage → service DB
app.post('/api/sync/contacts', validateWebhook, (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) {
    return res.status(400).json({ error: 'contacts must be an array' });
  }

  for (const contact of contacts) {
    db.contacts.upsert(contact.id, contact);
  }

  res.json({ synced: contacts.length });
});

// Single contact upsert (e.g. when a contact is updated in the CRM)
app.post('/api/contacts', validateWebhook, (req, res) => {
  const contact = req.body;
  if (!contact || !contact.id) {
    return res.status(400).json({ error: 'Missing contact id' });
  }

  db.contacts.upsert(contact.id, contact);
  res.json({ ok: true, id: contact.id });
});

// Get all contacts stored in the service
app.get('/api/contacts', (req, res) => {
  const contacts = db.contacts.getAll();
  res.json(contacts);
});

// Get a specific contact
app.get('/api/contacts/:id', (req, res) => {
  const contact = db.contacts.get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(contact);
});

// ─── Routes: Automation Triggers ──────────────────────────────────────────────

/**
 * POST /api/automation/new-contact
 * Triggered when a new contact is created in the CRM.
 * Fires lead enrichment workflow.
 */
app.post('/api/automation/new-contact', validateWebhook, async (req, res) => {
  const contact = req.body;
  if (!contact || !contact.id) {
    return res.status(400).json({ error: 'Missing contact data' });
  }

  const logId = uuidv4();
  db.automationLogs.create({
    id: logId,
    contactId: contact.id,
    workflow: 'lead-enrichment',
    triggerEvent: 'new-contact',
    input: contact
  });

  // Sync contact to DB
  db.contacts.upsert(contact.id, contact);

  // Run enrichment async and update DB when done
  setImmediate(async () => {
    try {
      const enrichment = await runLeadEnrichment(contact, logId);
      db.aiEnrichments.save(uuidv4(), contact.id, 'lead-enrichment', enrichment);
      db.automationLogs.complete(logId, enrichment);

      // Forward enrichment to N8N for any downstream workflows
      try {
        await axios.post(`${N8N_BASE_URL}/webhook/crm-enrichment-complete`, {
          contactId: contact.id,
          enrichment
        }, { timeout: 5000 });
      } catch (_) { /* N8N may not be running in all environments */ }

      console.log(`[Lead Enrichment] Completed for contact ${contact.id}`);
    } catch (err) {
      db.automationLogs.fail(logId, err.message);
      console.error(`[Lead Enrichment] Failed for ${contact.id}:`, err.message);
    }
  });

  res.json({ ok: true, logId, message: 'Lead enrichment queued' });
});

/**
 * POST /api/automation/stage-change
 * Triggered when a contact's deal stage changes.
 * Starts/cancels email sequences based on the new stage.
 */
app.post('/api/automation/stage-change', validateWebhook, async (req, res) => {
  const { contact, previousStage, newStage } = req.body;
  if (!contact || !newStage) {
    return res.status(400).json({ error: 'Missing contact or newStage' });
  }

  db.contacts.upsert(contact.id, contact);

  const logId = uuidv4();
  db.automationLogs.create({
    id: logId,
    contactId: contact.id,
    workflow: 'email-sequence',
    triggerEvent: `stage-change:${previousStage}->${newStage}`,
    input: { contact, previousStage, newStage }
  });

  // Cancel any active sequences when deal is closed
  if (['Closed Won', 'Closed Lost'].includes(newStage)) {
    db.scheduledEmails.cancel(contact.id, 'nurture-sequence');
    db.scheduledEmails.cancel(contact.id, 'follow-up-sequence');
    db.automationLogs.complete(logId, { action: 'sequences-cancelled', reason: newStage });
    return res.json({ ok: true, action: 'sequences-cancelled' });
  }

  // Start a nurture email sequence for contacts in nurture stage
  if (newStage === 'Nurture') {
    setImmediate(async () => {
      try {
        const steps = [
          { step: 1, delayDays: 0 },
          { step: 2, delayDays: 3 },
          { step: 3, delayDays: 7 },
          { step: 4, delayDays: 14 }
        ];

        for (const { step, delayDays } of steps) {
          const email = await generateSequenceEmail(contact, step, 'nurture-sequence');
          const scheduledAt = new Date();
          scheduledAt.setDate(scheduledAt.getDate() + delayDays);

          db.scheduledEmails.schedule({
            id: uuidv4(),
            contactId: contact.id,
            sequenceName: 'nurture-sequence',
            step,
            scheduledAt: scheduledAt.toISOString(),
            subject: email.subject,
            body: email.body
          });
        }

        db.automationLogs.complete(logId, { action: 'nurture-sequence-scheduled', steps: 4 });
        console.log(`[Email Sequence] Nurture sequence scheduled for ${contact.id}`);
      } catch (err) {
        db.automationLogs.fail(logId, err.message);
        console.error(`[Email Sequence] Failed:`, err.message);
      }
    });

    return res.json({ ok: true, action: 'nurture-sequence-queued' });
  }

  db.automationLogs.complete(logId, { action: 'no-sequence-triggered', stage: newStage });
  res.json({ ok: true, action: 'no-sequence-triggered' });
});

/**
 * POST /api/automation/activity-logged
 * Triggered when a call or meeting is logged in the CRM.
 * Generates AI-powered follow-up recommendation.
 */
app.post('/api/automation/activity-logged', validateWebhook, async (req, res) => {
  const { contact, activity } = req.body;
  if (!contact || !activity) {
    return res.status(400).json({ error: 'Missing contact or activity' });
  }

  db.contacts.upsert(contact.id, contact);

  const logId = uuidv4();
  db.automationLogs.create({
    id: logId,
    contactId: contact.id,
    workflow: 'followup-generator',
    triggerEvent: `activity-logged:${activity.type}`,
    input: { contact: contact.name, activity }
  });

  setImmediate(async () => {
    try {
      const followUp = await generateFollowUp(contact, activity);
      db.automationLogs.complete(logId, followUp);

      // Notify N8N to deliver follow-up suggestion back to the CRM
      try {
        await axios.post(`${N8N_BASE_URL}/webhook/crm-followup-ready`, {
          contactId: contact.id,
          followUp
        }, { timeout: 5000 });
      } catch (_) { }

      console.log(`[Follow-up Generator] Completed for ${contact.id}`);
    } catch (err) {
      db.automationLogs.fail(logId, err.message);
      console.error(`[Follow-up Generator] Failed:`, err.message);
    }
  });

  res.json({ ok: true, logId, message: 'Follow-up generation queued' });
});

// ─── Routes: N8N → Service (callbacks from N8N workflows) ─────────────────────

/**
 * POST /api/n8n/enrichment-result
 * N8N sends enrichment results back here after any downstream processing.
 */
app.post('/api/n8n/enrichment-result', validateWebhook, (req, res) => {
  const { contactId, enrichment } = req.body;
  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  db.aiEnrichments.save(uuidv4(), contactId, 'n8n-enriched', enrichment);
  db.contacts.update(contactId, { n8nEnrichment: enrichment, n8nEnrichedAt: new Date().toISOString() });

  res.json({ ok: true });
});

/**
 * POST /api/n8n/task-created
 * N8N notifies service that it created a task for a contact.
 */
app.post('/api/n8n/task-created', validateWebhook, (req, res) => {
  const { contactId, task } = req.body;
  if (!contactId || !task) return res.status(400).json({ error: 'Missing contactId or task' });

  const contact = db.contacts.get(contactId);
  if (contact) {
    const tasks = contact.data.tasks || [];
    tasks.push({ ...task, id: uuidv4(), createdByN8N: true });
    db.contacts.update(contactId, { tasks });
  }

  res.json({ ok: true });
});

// ─── Routes: Data Retrieval (CRM polls these) ─────────────────────────────────

/**
 * GET /api/enrichments/:contactId
 * CRM fetches enrichment data to display in the UI.
 */
app.get('/api/enrichments/:contactId', (req, res) => {
  const enrichment = db.aiEnrichments.get(req.params.contactId, 'lead-enrichment');
  if (!enrichment) return res.status(404).json({ error: 'No enrichment found' });
  res.json(enrichment);
});

/**
 * GET /api/scheduled-emails/:contactId
 * CRM fetches scheduled emails for a contact.
 */
app.get('/api/scheduled-emails/:contactId', (req, res) => {
  const emails = db.scheduledEmails.getByContact(req.params.contactId);
  res.json(emails);
});

/**
 * GET /api/automation-logs
 * Dashboard: get recent automation activity.
 */
app.get('/api/automation-logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = db.automationLogs.getRecent(limit);
  res.json(logs);
});

/**
 * GET /api/automation-logs/:contactId
 * Get automation logs for a specific contact.
 */
app.get('/api/automation-logs/:contactId', (req, res) => {
  const logs = db.automationLogs.getByContact(req.params.contactId);
  res.json(logs);
});

/**
 * GET /api/health
 * Health check endpoint for N8N and monitoring.
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'tariqcrm-n8n-bridge',
    timestamp: new Date().toISOString(),
    n8nUrl: N8N_BASE_URL
  });
});

// ─── Cron Jobs ─────────────────────────────────────────────────────────────────

// Every day at 8 AM: Run deal health monitor, notify N8N
cron.schedule('0 8 * * 1-5', async () => {
  console.log('[Cron] Running daily deal health monitor...');
  try {
    const contacts = db.contacts.getAll();
    const risks = await analyzeDealHealth(contacts);

    if (risks.length > 0) {
      const logId = uuidv4();
      db.automationLogs.create({
        id: logId,
        workflow: 'deal-health-monitor',
        triggerEvent: 'daily-cron',
        input: { totalContacts: contacts.length }
      });

      db.automationLogs.complete(logId, { risks, count: risks.length });

      // Send to N8N for notifications/Slack alerts
      try {
        await axios.post(`${N8N_BASE_URL}/webhook/crm-health-alert`, {
          risks,
          runAt: new Date().toISOString()
        }, { timeout: 5000 });
      } catch (_) { }

      console.log(`[Deal Health] Found ${risks.length} at-risk deals`);
    }
  } catch (err) {
    console.error('[Deal Health] Cron failed:', err.message);
  }
});

// Every 15 minutes: Process due scheduled emails
cron.schedule('*/15 * * * *', async () => {
  const dueEmails = db.scheduledEmails.getDue();
  if (dueEmails.length === 0) return;

  console.log(`[Scheduler] Processing ${dueEmails.length} due emails...`);

  for (const email of dueEmails) {
    try {
      // Notify N8N to send the email
      await axios.post(`${N8N_BASE_URL}/webhook/crm-send-email`, {
        emailId: email.id,
        contactId: email.contact_id,
        subject: email.subject,
        body: email.body,
        sequenceName: email.sequence_name,
        step: email.step
      }, { timeout: 5000 });

      db.scheduledEmails.markSent(email.id);
      console.log(`[Scheduler] Email sent: ${email.id}`);
    } catch (err) {
      console.error(`[Scheduler] Failed to send email ${email.id}:`, err.message);
    }
  }
});

// ─── Error Handler ─────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: err.message });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║     TariqCRM N8N Bridge Service              ║
║     Running on http://localhost:${PORT}         ║
╠══════════════════════════════════════════════╣
║  Endpoints:                                  ║
║  POST /api/sync/contacts    (CRM → Service)  ║
║  POST /api/automation/*     (Trigger flows)  ║
║  GET  /api/enrichments/:id  (Fetch results)  ║
║  GET  /api/health           (Health check)   ║
╚══════════════════════════════════════════════╝
  `);
});

module.exports = app;
