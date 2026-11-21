import pool, { query } from './db.js';

export async function runMigration() {
  const sql = `
  -- 1. Agents table
  CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- 2. Holidays table (Rule T2)
  CREATE TABLE IF NOT EXISTS holidays (
      id SERIAL PRIMARY KEY,
      holiday_date DATE UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- 3. Settings table (Rule S2)
  CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(50) PRIMARY KEY,
      value VARCHAR(255) NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- 4. Tickets table
  CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      ticket_code VARCHAR(50) UNIQUE NOT NULL,
      customer_name VARCHAR(100) NOT NULL,
      customer_email VARCHAR(255) NOT NULL,
      customer_token VARCHAR(64) UNIQUE NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      severity VARCHAR(20) NOT NULL CHECK (severity IN ('critical', 'medium', 'low')),
      status VARCHAR(30) NOT NULL CHECK (status IN ('new', 'open', 'waiting_customer', 'resolved', 'closed')),
      owner_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      linked_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
      
      first_response_deadline TIMESTAMPTZ,
      resolution_deadline TIMESTAMPTZ,
      first_response_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      
      first_response_breached BOOLEAN NOT NULL DEFAULT FALSE,
      resolution_breached BOOLEAN NOT NULL DEFAULT FALSE,
      
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_owner ON tickets(owner_agent_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_customer_token ON tickets(customer_token);

  -- 5. Messages table (Rules N1 - N3)
  CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('customer', 'agent')),
      sender_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      sender_name VARCHAR(100) NOT NULL,
      visibility VARCHAR(20) NOT NULL CHECK (visibility IN ('public', 'internal')),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_internal_note_agent_only CHECK (
          visibility = 'public' OR (visibility = 'internal' AND sender_type = 'agent')
      )
  );

  CREATE INDEX IF NOT EXISTS idx_messages_ticket_id ON messages(ticket_id);

  -- 6. Ticket events (append-only audit log, Rules A1 - A5)
  CREATE TABLE IF NOT EXISTS ticket_events (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      event_type VARCHAR(50) NOT NULL,
      actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('agent', 'customer', 'system')),
      actor_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_id ON ticket_events(ticket_id);

  -- Database Trigger preventing UPDATE and DELETE on ticket_events (Rule A3)
  CREATE OR REPLACE FUNCTION prevent_audit_tampering()
  RETURNS TRIGGER AS $$
  BEGIN
      RAISE EXCEPTION 'ticket_events table is append-only: UPDATE and DELETE are strictly prohibited.';
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_protect_ticket_events ON ticket_events;
  CREATE TRIGGER trg_protect_ticket_events
  BEFORE UPDATE OR DELETE ON ticket_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
  `;

  await query(sql);

  // Seed default agents if not present
  const agentCount = await query('SELECT COUNT(*) FROM agents');
  if (parseInt(agentCount.rows[0].count, 10) === 0) {
    const agents = [
      ['Meera (Lead)', 'meera@arvo.internal'],
      ['Arjun', 'arjun@arvo.internal'],
      ['Priya', 'priya@arvo.internal'],
      ['Rahul', 'rahul@arvo.internal'],
      ['Ananya', 'ananya@arvo.internal'],
      ['Vikram', 'vikram@arvo.internal'],
      ['Sneha', 'sneha@arvo.internal'],
      ['Rohan', 'rohan@arvo.internal'],
      ['Neha', 'neha@arvo.internal']
    ];
    for (const [name, email] of agents) {
      await query('INSERT INTO agents (name, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [name, email]);
    }
  }

  // Seed default settings if not present
  const defaultSettings = [
    ['work_start_time', '09:30', 'Support start time (Mon-Fri)'],
    ['work_end_time', '18:30', 'Support end time (Mon-Fri)'],
    ['critical_response_hours', '2', 'Critical first response hours'],
    ['medium_response_hours', '4.5', 'Medium first response hours'],
    ['low_response_hours', '9', 'Low first response hours'],
    ['medium_resolve_days', '3', 'Medium resolution working days'],
    ['low_resolve_days', '5', 'Low resolution working days'],
    ['silence_close_days', '5', 'Working days of silence before auto-close'],
    ['reopen_window_days', '5', 'Working days allowed to reopen resolved ticket']
  ];

  for (const [key, value, description] of defaultSettings) {
    await query(
      'INSERT INTO settings (key, value, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
      [key, value, description]
    );
  }
}

// Run if called directly
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  runMigration()
    .then(() => {
      console.log('Database migration completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
