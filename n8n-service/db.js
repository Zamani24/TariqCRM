'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/tariqcrm.db';

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS automation_logs (
    id TEXT PRIMARY KEY,
    contact_id TEXT,
    workflow TEXT NOT NULL,
    trigger_event TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    input TEXT,
    output TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS scheduled_emails (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    sequence_name TEXT NOT NULL,
    step INTEGER NOT NULL DEFAULT 1,
    scheduled_at DATETIME NOT NULL,
    sent_at DATETIME,
    status TEXT NOT NULL DEFAULT 'pending',
    subject TEXT,
    body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    processed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_enrichments (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    enrichment_type TEXT NOT NULL,
    result TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(updated_at);
  CREATE INDEX IF NOT EXISTS idx_automation_logs_contact ON automation_logs(contact_id);
  CREATE INDEX IF NOT EXISTS idx_scheduled_emails_status ON scheduled_emails(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON webhook_events(processed, created_at);
`);

module.exports = {
  // Contact operations
  contacts: {
    upsert(id, data) {
      db.prepare(`
        INSERT INTO contacts (id, data, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `).run(id, JSON.stringify(data));
    },

    get(id) {
      const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
      return row ? { ...row, data: JSON.parse(row.data) } : null;
    },

    getAll() {
      return db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC').all()
        .map(row => ({ ...row, data: JSON.parse(row.data) }));
    },

    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const merged = { ...existing.data, ...patch };
      this.upsert(id, merged);
      return merged;
    },

    delete(id) {
      db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    }
  },

  // Automation log operations
  automationLogs: {
    create(logData) {
      db.prepare(`
        INSERT INTO automation_logs (id, contact_id, workflow, trigger_event, status, input)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        logData.id,
        logData.contactId || null,
        logData.workflow,
        logData.triggerEvent,
        logData.status || 'pending',
        JSON.stringify(logData.input || {})
      );
    },

    complete(id, output) {
      db.prepare(`
        UPDATE automation_logs
        SET status = 'completed', output = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(JSON.stringify(output), id);
    },

    fail(id, error) {
      db.prepare(`
        UPDATE automation_logs
        SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(error, id);
    },

    getRecent(limit = 50) {
      return db.prepare(`
        SELECT * FROM automation_logs
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit).map(row => ({
        ...row,
        input: row.input ? JSON.parse(row.input) : null,
        output: row.output ? JSON.parse(row.output) : null
      }));
    },

    getByContact(contactId) {
      return db.prepare(`
        SELECT * FROM automation_logs
        WHERE contact_id = ?
        ORDER BY created_at DESC
      `).all(contactId).map(row => ({
        ...row,
        input: row.input ? JSON.parse(row.input) : null,
        output: row.output ? JSON.parse(row.output) : null
      }));
    }
  },

  // Scheduled email operations
  scheduledEmails: {
    schedule(emailData) {
      db.prepare(`
        INSERT INTO scheduled_emails (id, contact_id, sequence_name, step, scheduled_at, subject, body)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        emailData.id,
        emailData.contactId,
        emailData.sequenceName,
        emailData.step,
        emailData.scheduledAt,
        emailData.subject || null,
        emailData.body || null
      );
    },

    getDue() {
      return db.prepare(`
        SELECT * FROM scheduled_emails
        WHERE status = 'pending'
        AND scheduled_at <= datetime('now')
        ORDER BY scheduled_at ASC
      `).all();
    },

    markSent(id) {
      db.prepare(`
        UPDATE scheduled_emails
        SET status = 'sent', sent_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(id);
    },

    cancel(contactId, sequenceName) {
      db.prepare(`
        UPDATE scheduled_emails
        SET status = 'cancelled'
        WHERE contact_id = ? AND sequence_name = ? AND status = 'pending'
      `).run(contactId, sequenceName);
    },

    getByContact(contactId) {
      return db.prepare(`
        SELECT * FROM scheduled_emails
        WHERE contact_id = ?
        ORDER BY scheduled_at ASC
      `).all(contactId);
    }
  },

  // Webhook event queue
  webhookEvents: {
    enqueue(id, eventType, payload) {
      db.prepare(`
        INSERT INTO webhook_events (id, event_type, payload)
        VALUES (?, ?, ?)
      `).run(id, eventType, JSON.stringify(payload));
    },

    getPending() {
      return db.prepare(`
        SELECT * FROM webhook_events
        WHERE processed = 0
        ORDER BY created_at ASC
        LIMIT 50
      `).all().map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    },

    markProcessed(id) {
      db.prepare('UPDATE webhook_events SET processed = 1 WHERE id = ?').run(id);
    }
  },

  // AI enrichment cache
  aiEnrichments: {
    save(id, contactId, type, result) {
      db.prepare(`
        INSERT OR REPLACE INTO ai_enrichments (id, contact_id, enrichment_type, result)
        VALUES (?, ?, ?, ?)
      `).run(id, contactId, type, JSON.stringify(result));
    },

    get(contactId, type) {
      const row = db.prepare(`
        SELECT * FROM ai_enrichments
        WHERE contact_id = ? AND enrichment_type = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(contactId, type);
      return row ? { ...row, result: JSON.parse(row.result) } : null;
    }
  },

  // Raw db access for complex queries
  raw: db
};
