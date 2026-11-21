import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import pool, { query } from './db/db.js';
import { calculateDeadlines, getTicketBadge, DEFAULT_SLA_CONFIG } from './sla.js';
import { calculateWorkingMinutes, addWorkingMinutes, isLate, nextWorkingMoment, getDateParts, createDateInTimezone } from './workingTime.js';
import { runAutoCloseJob, runBreachDetectionJob } from './jobs.js';

export const app = express();

app.use(cors());
app.use(express.json());

// Request logger: logs live API traffic to terminal
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      const color = res.statusCode >= 400 ? '❌' : '✓';
      console.log(`${color} [${new Date().toLocaleTimeString()}] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  next();
});

// Rule L1: State transition table (single source of truth for allowed moves)
export const ALLOWED_STATUS_TRANSITIONS = {
  new: ['open', 'waiting_customer', 'resolved', 'closed'],
  open: ['waiting_customer', 'resolved', 'closed'],
  waiting_customer: ['open', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: [] // Terminal state: tickets closed by silence or closure cannot be transitioned
};

// Helper to fetch holidays list from database
async function getHolidays() {
  const result = await query('SELECT holiday_date FROM holidays');
  return result.rows.map(r => {
    const d = new Date(r.holiday_date);
    return d.toISOString().split('T')[0];
  });
}

// Helper to fetch setting number
async function getSettingNumber(key, defaultValue) {
  const result = await query('SELECT value FROM settings WHERE key = $1', [key]);
  if (result.rowCount === 0) return defaultValue;
  const val = parseFloat(result.rows[0].value);
  return isNaN(val) ? defaultValue : val;
}

// ==========================================
// 0. List Agents (Rule 10 simple login/selector)
// ==========================================
app.get('/api/agents', async (req, res) => {
  try {
    const result = await query('SELECT id, name, email FROM agents ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching agents:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 1. Create Ticket (Rules S1 - S3, A1 - A2)
// ==========================================
app.post('/api/tickets', async (req, res) => {
  try {
    const { title, description = '', customer_name, customer_email, severity = 'medium', linked_ticket_id = null } = req.body;

    if (!title || !customer_name || !customer_email) {
      return res.status(400).json({ error: 'title, customer_name, and customer_email are required' });
    }

    if (!['critical', 'medium', 'low'].includes(severity.toLowerCase())) {
      return res.status(400).json({ error: 'severity must be critical, medium, or low' });
    }

    const holidays = await getHolidays();
    const now = new Date();
    const token = crypto.randomUUID();

    // Calculate initial SLA deadlines using server clock
    const { firstResponseDeadline, resolutionDeadline } = calculateDeadlines(
      now,
      severity.toLowerCase(),
      holidays
    );

    const ticketCode = `TCK-${Date.now().toString().slice(-6)}`;

    const insertTicketSql = `
      INSERT INTO tickets (
        ticket_code, customer_name, customer_email, customer_token,
        title, description, severity, status, linked_ticket_id,
        first_response_deadline, resolution_deadline,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8, $9, $10, NOW(), NOW())
      RETURNING *;
    `;

    const ticketResult = await query(insertTicketSql, [
      ticketCode,
      customer_name,
      customer_email,
      token,
      title,
      description,
      severity.toLowerCase(),
      linked_ticket_id,
      firstResponseDeadline,
      resolutionDeadline
    ]);

    const newTicket = ticketResult.rows[0];

    // Append-only audit log: ticket created (Rule A1, A2)
    const eventSql = `
      INSERT INTO ticket_events (ticket_id, event_type, actor_type, payload, created_at)
      VALUES ($1, 'created', 'customer', $2, NOW());
    `;

    await query(eventSql, [
      newTicket.id,
      JSON.stringify({
        severity: newTicket.severity,
        first_response_deadline: newTicket.first_response_deadline,
        resolution_deadline: newTicket.resolution_deadline,
        linked_ticket_id
      })
    ]);

    newTicket.badge = getTicketBadge(newTicket);
    res.status(201).json(newTicket);
  } catch (err) {
    console.error('Error creating ticket:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 2. List Tickets (Rules U1, U2, U4)
// ==========================================
app.get('/api/tickets', async (req, res) => {
  try {
    const { owner_agent_id, unassigned, status } = req.query;
    const conditions = [];
    const params = [];

    if (unassigned === 'true') {
      conditions.push('owner_agent_id IS NULL');
    } else if (owner_agent_id && owner_agent_id !== 'null' && owner_agent_id !== 'undefined') {
      const parsedAgentId = parseInt(owner_agent_id, 10);
      if (!isNaN(parsedAgentId)) {
        params.push(parsedAgentId);
        conditions.push(`owner_agent_id = $${params.length}`);
      }
    }

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Rule U2: Sort by closest deadline first
    const sql = `
      SELECT t.*, a.name as owner_name
      FROM tickets t
      LEFT JOIN agents a ON t.owner_agent_id = a.id
      ${whereClause}
      ORDER BY 
        CASE 
          WHEN t.first_response_at IS NULL THEN t.first_response_deadline
          ELSE t.resolution_deadline
        END ASC;
    `;

    const result = await query(sql, params);
    const tickets = result.rows.map(ticket => ({
      ...ticket,
      badge: getTicketBadge(ticket)
    }));

    res.json(tickets);
  } catch (err) {
    console.error('Error listing tickets:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 3. Get Single Ticket Details (Agent View)
// ==========================================
app.get('/api/tickets/:id', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    const ticketResult = await query(
      `SELECT t.*, a.name as owner_name 
       FROM tickets t 
       LEFT JOIN agents a ON t.owner_agent_id = a.id 
       WHERE t.id = $1`,
      [ticketId]
    );

    if (ticketResult.rowCount === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const ticket = ticketResult.rows[0];
    ticket.badge = getTicketBadge(ticket);

    const messagesResult = await query(
      `SELECT m.*, a.name as agent_name 
       FROM messages m 
       LEFT JOIN agents a ON m.sender_agent_id = a.id 
       WHERE m.ticket_id = $1 
       ORDER BY m.created_at ASC`,
      [ticketId]
    );

    res.json({
      ticket,
      messages: messagesResult.rows
    });
  } catch (err) {
    console.error('Error fetching ticket details:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 4. Update Ticket Status (Rule L1 State Machine)
// ==========================================
app.patch('/api/tickets/:id/status', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    const { status: newStatus, agent_id } = req.body;

    if (!newStatus) {
      return res.status(400).json({ error: 'status is required' });
    }

    const ticketResult = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
    if (ticketResult.rowCount === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketResult.rows[0];
    const currentStatus = ticket.status;

    // Rule L1: Reject disallowed moves via state transition table
    const allowedNext = ALLOWED_STATUS_TRANSITIONS[currentStatus] || [];
    if (!allowedNext.includes(newStatus)) {
      return res.status(400).json({
        error: `Disallowed status transition: cannot move from '${currentStatus}' to '${newStatus}'`
      });
    }

    let extraUpdates = '';
    const updateParams = [newStatus, ticketId];

    if (newStatus === 'resolved') {
      const now = new Date();
      const breached = isLate(ticket.resolution_deadline, now);
      extraUpdates = ', resolved_at = NOW(), resolution_breached = $3';
      updateParams.push(breached);
    } else if (newStatus === 'closed') {
      extraUpdates = ', closed_at = NOW()';
    }

    const updateSql = `
      UPDATE tickets 
      SET status = $1, updated_at = NOW() ${extraUpdates}
      WHERE id = $2
      RETURNING *;
    `;
    const updatedResult = await query(updateSql, updateParams);
    const updatedTicket = updatedResult.rows[0];

    // Append-only audit log: status change
    await query(
      `INSERT INTO ticket_events (ticket_id, event_type, actor_type, actor_agent_id, payload, created_at)
       VALUES ($1, 'status_changed', 'agent', $2, $3, NOW())`,
      [ticketId, agent_id || null, JSON.stringify({ old_status: currentStatus, new_status: newStatus })]
    );

    updatedTicket.badge = getTicketBadge(updatedTicket);
    res.json(updatedTicket);
  } catch (err) {
    console.error('Error updating status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 5. Claim Ticket (Rule C1, C2, A1, A2)
// ==========================================
app.post('/api/tickets/:id/claim', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    const { agent_id } = req.body;

    if (!agent_id) {
      return res.status(400).json({ error: 'agent_id is required' });
    }

    const claimSql = `
      UPDATE tickets
      SET owner_agent_id = $1,
          status = CASE WHEN status = 'new' THEN 'open' ELSE status END,
          updated_at = NOW()
      WHERE id = $2 AND owner_agent_id IS NULL
      RETURNING *;
    `;

    const result = await query(claimSql, [agent_id, ticketId]);

    if (result.rowCount === 0) {
      const checkResult = await query('SELECT id, owner_agent_id FROM tickets WHERE id = $1', [ticketId]);
      if (checkResult.rowCount === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      return res.status(409).json({ error: 'Ticket is already taken by another agent' });
    }

    const claimedTicket = result.rows[0];

    await query(
      `INSERT INTO ticket_events (ticket_id, event_type, actor_type, actor_agent_id, payload, created_at)
       VALUES ($1, 'claimed', 'agent', $2, $3, NOW())`,
      [ticketId, agent_id, JSON.stringify({ previous_owner: null, new_owner: agent_id })]
    );

    claimedTicket.badge = getTicketBadge(claimedTicket);
    res.json(claimedTicket);
  } catch (err) {
    console.error('Error claiming ticket:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 6. Release Ticket (Rule C4, A1, A2)
// ==========================================
app.post('/api/tickets/:id/release', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    const { agent_id } = req.body;

    if (!agent_id) {
      return res.status(400).json({ error: 'agent_id is required' });
    }

    const releaseSql = `
      UPDATE tickets
      SET owner_agent_id = NULL,
          updated_at = NOW()
      WHERE id = $1 AND owner_agent_id = $2
      RETURNING *;
    `;

    const result = await query(releaseSql, [ticketId, agent_id]);

    if (result.rowCount === 0) {
      const checkResult = await query('SELECT id, owner_agent_id FROM tickets WHERE id = $1', [ticketId]);
      if (checkResult.rowCount === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      return res.status(403).json({ error: 'Only the current owner can release this ticket' });
    }

    const releasedTicket = result.rows[0];

    await query(
      `INSERT INTO ticket_events (ticket_id, event_type, actor_type, actor_agent_id, payload, created_at)
       VALUES ($1, 'released', 'agent', $2, $3, NOW())`,
      [ticketId, agent_id, JSON.stringify({ previous_owner: agent_id, new_owner: null })]
    );

    releasedTicket.badge = getTicketBadge(releasedTicket);
    res.json(releasedTicket);
  } catch (err) {
    console.error('Error releasing ticket:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 7. Agent Add Message (Rules C3, S4, N1)
// ==========================================
app.post('/api/tickets/:id/messages', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    const { agent_id, visibility, body } = req.body;

    if (!agent_id || !body || !visibility) {
      return res.status(400).json({ error: 'agent_id, visibility, and body are required' });
    }

    if (!['public', 'internal'].includes(visibility)) {
      return res.status(400).json({ error: "visibility must be 'public' or 'internal'" });
    }

    const agentResult = await query('SELECT id, name FROM agents WHERE id = $1', [agent_id]);
    if (agentResult.rowCount === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const agent = agentResult.rows[0];

    const ticketResult = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
    if (ticketResult.rowCount === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketResult.rows[0];

    // Rule C3: Only current owner can send public replies
    if (visibility === 'public') {
      if (ticket.owner_agent_id !== agent.id) {
        return res.status(403).json({ error: 'Only the current ticket owner can send a public reply' });
      }
    }

    const insertMsgSql = `
      INSERT INTO messages (ticket_id, sender_type, sender_agent_id, sender_name, visibility, body, created_at)
      VALUES ($1, 'agent', $2, $3, $4, $5, NOW())
      RETURNING *;
    `;
    const msgResult = await query(insertMsgSql, [ticketId, agent.id, agent.name, visibility, body]);
    const message = msgResult.rows[0];

    // Rule S4: First public reply stops response clock
    if (visibility === 'public' && !ticket.first_response_at) {
      const now = new Date();
      const breached = isLate(ticket.first_response_deadline, now);
      await query(
        `UPDATE tickets 
         SET first_response_at = NOW(), 
             first_response_breached = $1, 
             updated_at = NOW() 
         WHERE id = $2`,
        [breached, ticketId]
      );
    }

    const eventType = visibility === 'public' ? 'public_reply_sent' : 'internal_note_added';
    await query(
      `INSERT INTO ticket_events (ticket_id, event_type, actor_type, actor_agent_id, payload, created_at)
       VALUES ($1, $2, 'agent', $3, $4, NOW())`,
      [ticketId, eventType, agent.id, JSON.stringify({ message_id: message.id, visibility })]
    );

    res.status(201).json(message);
  } catch (err) {
    console.error('Error posting message:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 8. Customer Portal: View Ticket (Rules N2, N3, N4)
// ==========================================
app.get('/api/customer/tickets/:token', async (req, res) => {
  try {
    const token = req.params.token;

    const ticketResult = await query(
      `SELECT ticket_code, title, description, status, created_at, updated_at
       FROM tickets 
       WHERE customer_token = $1`,
      [token]
    );

    if (ticketResult.rowCount === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketResult.rows[0];

    // Strictly public messages (Rule N3)
    const messagesResult = await query(
      `SELECT id, sender_type, sender_name, body, created_at 
       FROM messages 
       WHERE ticket_id = (SELECT id FROM tickets WHERE customer_token = $1)
         AND visibility = 'public'
       ORDER BY created_at ASC`,
      [token]
    );

    res.json({
      ticket,
      messages: messagesResult.rows
    });
  } catch (err) {
    console.error('Error in customer portal view:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 9. Customer Portal: Send Message / Reopen / Link (Rules L2, L3, L4, L5, W2)
// ==========================================
app.post('/api/customer/tickets/:token/messages', async (req, res) => {
  try {
    const token = req.params.token;
    const { body, sender_name } = req.body;

    if (!body) {
      return res.status(400).json({ error: 'body is required' });
    }

    const ticketResult = await query('SELECT * FROM tickets WHERE customer_token = $1', [token]);
    if (ticketResult.rowCount === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketResult.rows[0];
    const holidays = await getHolidays();
    const customerName = sender_name || ticket.customer_name;
    const now = new Date();

    // -------------------------------------------------------------
    // Case A: Ticket is RESOLVED (Rule L2 vs L3)
    // -------------------------------------------------------------
    if (ticket.status === 'resolved') {
      const reopenDays = await getSettingNumber('reopen_window_days', 5);
      const maxReopenWorkingMins = reopenDays * 540;
      const elapsedWorkingMins = calculateWorkingMinutes(new Date(ticket.resolved_at), now, holidays);

      if (elapsedWorkingMins <= maxReopenWorkingMins) {
        // Rule L2: Customer can reopen a Resolved ticket within reopen window
        // Rule L4: Reopened ticket gets a fresh resolution clock; first response clock not restarted
        const sla = DEFAULT_SLA_CONFIG[ticket.severity];
        let freshResolutionDeadline;
        if (ticket.severity === 'critical' && sla.resolveSameDay) {
          const clockStart = nextWorkingMoment(now, holidays);
          const parts = getDateParts(clockStart);
          freshResolutionDeadline = createDateInTimezone(parts.year, parts.month, parts.day, 18, 30, 0);
        } else {
          freshResolutionDeadline = addWorkingMinutes(now, sla.resolveMinutes, holidays);
        }

        // Reopen ticket
        await query(
          `UPDATE tickets 
           SET status = 'open', 
               resolved_at = NULL, 
               resolution_breached = FALSE,
               resolution_deadline = $1,
               updated_at = NOW() 
           WHERE id = $2`,
          [freshResolutionDeadline, ticket.id]
        );

        // Record customer message
        const insertMsgSql = `
          INSERT INTO messages (ticket_id, sender_type, sender_name, visibility, body, created_at)
          VALUES ($1, 'customer', $2, 'public', $3, NOW())
          RETURNING id, sender_type, sender_name, body, created_at;
        `;
        const msgResult = await query(insertMsgSql, [ticket.id, customerName, body]);

        // Audit event: reopened
        await query(
          `INSERT INTO ticket_events (ticket_id, event_type, actor_type, payload, created_at)
           VALUES ($1, 'reopened', 'customer', $2, NOW())`,
          [ticket.id, JSON.stringify({ elapsed_working_minutes: elapsedWorkingMins, fresh_resolution_deadline: freshResolutionDeadline })]
        );

        return res.status(201).json({
          reopened: true,
          ticket_id: ticket.id,
          message: msgResult.rows[0]
        });
      } else {
        // Rule L3: Window expired! Customer message creates a NEW ticket linked to old one.
        // Old ticket remains untouched.
        const newToken = crypto.randomUUID();
        const newTicketCode = `TCK-${Date.now().toString().slice(-6)}`;
        const { firstResponseDeadline, resolutionDeadline } = calculateDeadlines(now, ticket.severity, holidays);

        const newTicketRes = await query(
          `INSERT INTO tickets (
             ticket_code, customer_name, customer_email, customer_token,
             title, description, severity, status, linked_ticket_id,
             first_response_deadline, resolution_deadline,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8, $9, $10, NOW(), NOW())
           RETURNING *`,
          [
            newTicketCode,
            ticket.customer_name,
            ticket.customer_email,
            newToken,
            `Re: ${ticket.title}`,
            body,
            ticket.severity,
            ticket.id,
            firstResponseDeadline,
            resolutionDeadline
          ]
        );
        const newTicket = newTicketRes.rows[0];

        // Add message under new ticket
        const msgRes = await query(
          `INSERT INTO messages (ticket_id, sender_type, sender_name, visibility, body, created_at)
           VALUES ($1, 'customer', $2, 'public', $3, NOW())
           RETURNING id, sender_type, sender_name, body, created_at`,
          [newTicket.id, customerName, body]
        );

        // Audit event for new linked ticket
        await query(
          `INSERT INTO ticket_events (ticket_id, event_type, actor_type, payload, created_at)
           VALUES ($1, 'created', 'customer', $2, NOW())`,
          [newTicket.id, JSON.stringify({ linked_ticket_id: ticket.id, reason: 'reopen_window_expired' })]
        );

        return res.status(201).json({
          reopened: false,
          created_new_ticket: true,
          new_ticket: newTicket,
          message: msgRes.rows[0]
        });
      }
    }

    // -------------------------------------------------------------
    // Case B: Ticket is CLOSED (Rule L5: Closed tickets cannot reopen; creates linked ticket)
    // -------------------------------------------------------------
    if (ticket.status === 'closed') {
      const newToken = crypto.randomUUID();
      const newTicketCode = `TCK-${Date.now().toString().slice(-6)}`;
      const { firstResponseDeadline, resolutionDeadline } = calculateDeadlines(now, ticket.severity, holidays);

      const newTicketRes = await query(
        `INSERT INTO tickets (
           ticket_code, customer_name, customer_email, customer_token,
           title, description, severity, status, linked_ticket_id,
           first_response_deadline, resolution_deadline,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8, $9, $10, NOW(), NOW())
         RETURNING *`,
        [
          newTicketCode,
          ticket.customer_name,
          ticket.customer_email,
          newToken,
          `Re: ${ticket.title}`,
          body,
          ticket.severity,
          ticket.id,
          firstResponseDeadline,
          resolutionDeadline
        ]
      );
      const newTicket = newTicketRes.rows[0];

      const msgRes = await query(
        `INSERT INTO messages (ticket_id, sender_type, sender_name, visibility, body, created_at)
         VALUES ($1, 'customer', $2, 'public', $3, NOW())
         RETURNING id, sender_type, sender_name, body, created_at`,
        [newTicket.id, customerName, body]
      );

      await query(
        `INSERT INTO ticket_events (ticket_id, event_type, actor_type, payload, created_at)
         VALUES ($1, 'created', 'customer', $2, NOW())`,
        [newTicket.id, JSON.stringify({ linked_ticket_id: ticket.id, reason: 'ticket_was_closed' })]
      );

      return res.status(201).json({
        reopened: false,
        created_new_ticket: true,
        new_ticket: newTicket,
        message: msgRes.rows[0]
      });
    }

    // -------------------------------------------------------------
    // Case C: Standard reply on open, new, or waiting_customer ticket
    // -------------------------------------------------------------
    const insertMsgSql = `
      INSERT INTO messages (ticket_id, sender_type, sender_name, visibility, body, created_at)
      VALUES ($1, 'customer', $2, 'public', $3, NOW())
      RETURNING id, sender_type, sender_name, body, created_at;
    `;
    const msgResult = await query(insertMsgSql, [ticket.id, customerName, body]);

    // Rule W2: Customer reply resumes waiting ticket back to open
    if (ticket.status === 'waiting_customer') {
      await query(
        `UPDATE tickets 
         SET status = 'open', updated_at = NOW() 
         WHERE id = $1`,
        [ticket.id]
      );
    }

    await query(
      `INSERT INTO ticket_events (ticket_id, event_type, actor_type, payload, created_at)
       VALUES ($1, 'customer_reply', 'customer', $2, NOW())`,
      [ticket.id, JSON.stringify({ message_id: msgResult.rows[0].id })]
    );

    res.status(201).json({
      reopened: false,
      message: msgResult.rows[0]
    });
  } catch (err) {
    console.error('Error in customer reply:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 10. Customer Portal: Export Ticket Thread (Rule N2)
// ==========================================
app.get('/api/customer/tickets/:token/export', async (req, res) => {
  try {
    const token = req.params.token;

    const ticketResult = await query(
      `SELECT ticket_code, title, description, status, created_at 
       FROM tickets 
       WHERE customer_token = $1`,
      [token]
    );

    if (ticketResult.rowCount === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketResult.rows[0];

    const messagesResult = await query(
      `SELECT sender_type, sender_name, body, created_at 
       FROM messages 
       WHERE ticket_id = (SELECT id FROM tickets WHERE customer_token = $1)
         AND visibility = 'public'
       ORDER BY created_at ASC`,
      [token]
    );

    res.json({
      export_type: 'customer_transcript',
      ticket_code: ticket.ticket_code,
      title: ticket.title,
      status: ticket.status,
      created_at: ticket.created_at,
      transcript: messagesResult.rows
    });
  } catch (err) {
    console.error('Error exporting customer transcript:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 11. Manager Report: Late Tickets & Breach Reasons (Rule A6)
// Answers "which were late, and why" (unassigned vs no_action)
// ==========================================
app.get('/api/reports/breaches', async (req, res) => {
  try {
    const sql = `
      SELECT 
        t.id, t.ticket_code, t.title, t.severity, t.status,
        t.owner_agent_id, a.name as owner_name,
        t.first_response_deadline, t.resolution_deadline,
        t.first_response_at, t.resolved_at,
        t.first_response_breached, t.resolution_breached,
        t.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'event_type', e.event_type,
              'payload', e.payload,
              'created_at', e.created_at
            )
          ) FILTER (WHERE e.event_type = 'breach'), 
          '[]'::json
        ) as breach_events
      FROM tickets t
      LEFT JOIN agents a ON t.owner_agent_id = a.id
      LEFT JOIN ticket_events e ON t.id = e.ticket_id AND e.event_type = 'breach'
      WHERE t.first_response_breached = TRUE OR t.resolution_breached = TRUE
      GROUP BY t.id, a.name
      ORDER BY t.created_at DESC;
    `;

    const result = await query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching breach report:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 12. Automation Jobs Triggers (Rules W4, A5)
// ==========================================
app.post('/api/jobs/auto-close', async (req, res) => {
  try {
    const referenceTime = req.body?.reference_time ? new Date(req.body.reference_time) : new Date();
    const result = await runAutoCloseJob(referenceTime);
    res.json({ message: 'Auto-close job completed', ...result });
  } catch (err) {
    console.error('Error running auto-close job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/jobs/breach-detection', async (req, res) => {
  try {
    const referenceTime = req.body?.reference_time ? new Date(req.body.reference_time) : new Date();
    const result = await runBreachDetectionJob(referenceTime);
    res.json({ message: 'Breach detection job completed', ...result });
  } catch (err) {
    console.error('Error running breach detection job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve frontend static build (for single-port deployment or visiting port 5000 directly)
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../../frontend/dist');

app.use(express.static(distPath));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(distPath, 'index.html'), err => {
      if (err) next();
    });
  }
  next();
});
