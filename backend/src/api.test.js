import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from './app.js';
import pool, { query } from './db/db.js';
import { runMigration } from './db/migrate.js';

describe('Backend API: Rules C1-C4, A1-A6, S4, N1-N4, L1-L5, W4', () => {
  let server;
  let baseUrl;
  let testAgentId1;
  let testAgentId2;

  beforeAll(async () => {
    // Ensure database migration and trigger are set up
    await runMigration();

    // Fetch existing seeded agents
    const agentsRes = await query('SELECT id FROM agents ORDER BY id ASC LIMIT 2');
    testAgentId1 = agentsRes.rows[0].id;
    testAgentId2 = agentsRes.rows[1].id;

    // Start ephemeral server for testing with built-in fetch
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('Creates a new ticket and writes an audit event', async () => {
    const res = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'ERP connection failing',
        description: 'Users cannot log into SAP module',
        customer_name: 'Acme Corp',
        customer_email: 'support@acme.com',
        severity: 'critical'
      })
    });

    expect(res.status).toBe(201);
    const ticket = await res.json();
    expect(ticket.id).toBeDefined();
    expect(ticket.status).toBe('new');
    expect(ticket.severity).toBe('critical');
    expect(ticket.customer_token).toBeDefined();

    const eventsRes = await query('SELECT * FROM ticket_events WHERE ticket_id = $1', [ticket.id]);
    expect(eventsRes.rows.length).toBeGreaterThanOrEqual(1);
    expect(eventsRes.rows[0].event_type).toBe('created');
    expect(eventsRes.rows[0].actor_type).toBe('customer');
  });

  it('C2: Claiming is atomic; 10 simultaneous claims yields exactly 1 success and 9 conflicts (409)', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Concurrent claim test ticket',
        customer_name: 'Beta LLC',
        customer_email: 'beta@example.com',
        severity: 'medium'
      })
    });
    const ticket = await createRes.json();
    const ticketId = ticket.id;

    const claimPromises = Array.from({ length: 10 }).map(() => {
      return fetch(`${baseUrl}/api/tickets/${ticketId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: testAgentId1 })
      });
    });

    const responses = await Promise.all(claimPromises);
    const statuses = responses.map(r => r.status);

    const successCount = statuses.filter(s => s === 200).length;
    const conflictCount = statuses.filter(s => s === 409).length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(9);

    const dbTicket = await query('SELECT owner_agent_id, status FROM tickets WHERE id = $1', [ticketId]);
    expect(dbTicket.rows[0].owner_agent_id).toBe(testAgentId1);
    expect(dbTicket.rows[0].status).toBe('open');

    const eventsRes = await query(
      "SELECT * FROM ticket_events WHERE ticket_id = $1 AND event_type = 'claimed'",
      [ticketId]
    );
    expect(eventsRes.rows.length).toBe(1);
  });

  it('C4: Owner can release a ticket back to the queue, and another agent can claim it', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Release queue test ticket',
        customer_name: 'Gamma Corp',
        customer_email: 'gamma@example.com',
        severity: 'low'
      })
    });
    const ticket = await createRes.json();

    await fetch(`${baseUrl}/api/tickets/${ticket.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: testAgentId1 })
    });

    const invalidRelease = await fetch(`${baseUrl}/api/tickets/${ticket.id}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: testAgentId2 })
    });
    expect(invalidRelease.status).toBe(403);

    const validRelease = await fetch(`${baseUrl}/api/tickets/${ticket.id}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: testAgentId1 })
    });
    expect(validRelease.status).toBe(200);
    const releasedData = await validRelease.json();
    expect(releasedData.owner_agent_id).toBeNull();

    const secondClaim = await fetch(`${baseUrl}/api/tickets/${ticket.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: testAgentId2 })
    });
    expect(secondClaim.status).toBe(200);
    const claimedData = await secondClaim.json();
    expect(claimedData.owner_agent_id).toBe(testAgentId2);
  });

  it('A3: ticket_events is append-only; database trigger blocks UPDATE and DELETE', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Trigger immutability test',
        customer_name: 'Security Test',
        customer_email: 'security@example.com',
        severity: 'low'
      })
    });
    const ticket = await createRes.json();

    const eventResult = await query(
      'SELECT id FROM ticket_events WHERE ticket_id = $1 LIMIT 1',
      [ticket.id]
    );
    const eventId = eventResult.rows[0].id;

    await expect(
      query("UPDATE ticket_events SET event_type = 'tampered' WHERE id = $1", [eventId])
    ).rejects.toThrow(/append-only/i);

    await expect(
      query('DELETE FROM ticket_events WHERE id = $1', [eventId])
    ).rejects.toThrow(/append-only/i);
  });

  it('C3: Only the ticket owner can send a public reply; non-owners get 403 Forbidden', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Reply authorization test',
        customer_name: 'Delta Inc',
        customer_email: 'delta@example.com',
        severity: 'medium'
      })
    });
    const ticket = await createRes.json();

    await fetch(`${baseUrl}/api/tickets/${ticket.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: testAgentId1 })
    });

    const nonOwnerReply = await fetch(`${baseUrl}/api/tickets/${ticket.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: testAgentId2,
        visibility: 'public',
        body: 'Unauthorized reply from another agent'
      })
    });
    expect(nonOwnerReply.status).toBe(403);
    const nonOwnerData = await nonOwnerReply.json();
    expect(nonOwnerData.error).toMatch(/only the current ticket owner/i);

    const ownerReply = await fetch(`${baseUrl}/api/tickets/${ticket.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: testAgentId1,
        visibility: 'public',
        body: 'Official public reply from the ticket owner'
      })
    });
    expect(ownerReply.status).toBe(201);

    const updatedTicket = await query('SELECT first_response_at FROM tickets WHERE id = $1', [ticket.id]);
    expect(updatedTicket.rows[0].first_response_at).not.toBeNull();
  });

  it('S4 & N1: Internal note does not stop first response clock', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Internal note clock test',
        customer_name: 'Epsilon Org',
        customer_email: 'epsilon@example.com',
        severity: 'critical'
      })
    });
    const ticket = await createRes.json();

    const noteRes = await fetch(`${baseUrl}/api/tickets/${ticket.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: testAgentId1,
        visibility: 'internal',
        body: 'Internal triage note: check server logs'
      })
    });
    expect(noteRes.status).toBe(201);

    const checkTicket = await query('SELECT first_response_at FROM tickets WHERE id = $1', [ticket.id]);
    expect(checkTicket.rows[0].first_response_at).toBeNull();
  });

  it('N2 & N3: Internal notes NEVER leak to customer portal view or export', async () => {
    const SECRET_STRING = 'CONFIDENTIAL_CUSTOMER_IS_FRUSTRATED_HANDLE_WITH_CARE_777';
    const PUBLIC_STRING = 'Hello, our team is actively addressing your request.';

    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Leak prevention test',
        customer_name: 'Strict Privacy Client',
        customer_email: 'privacy@client.com',
        severity: 'medium'
      })
    });
    const ticket = await createRes.json();
    const token = ticket.customer_token;

    await fetch(`${baseUrl}/api/tickets/${ticket.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: testAgentId1 })
    });

    await fetch(`${baseUrl}/api/tickets/${ticket.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: testAgentId1,
        visibility: 'internal',
        body: SECRET_STRING
      })
    });

    await fetch(`${baseUrl}/api/tickets/${ticket.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: testAgentId1,
        visibility: 'public',
        body: PUBLIC_STRING
      })
    });

    const agentViewRes = await fetch(`${baseUrl}/api/tickets/${ticket.id}`);
    const agentViewData = await agentViewRes.json();
    const agentViewText = JSON.stringify(agentViewData);
    expect(agentViewText).toContain(SECRET_STRING);
    expect(agentViewText).toContain(PUBLIC_STRING);

    const customerViewRes = await fetch(`${baseUrl}/api/customer/tickets/${token}`);
    expect(customerViewRes.status).toBe(200);
    const customerViewData = await customerViewRes.json();
    const customerViewText = JSON.stringify(customerViewData);
    expect(customerViewText).not.toContain(SECRET_STRING);
    expect(customerViewText).toContain(PUBLIC_STRING);

    const customerExportRes = await fetch(`${baseUrl}/api/customer/tickets/${token}/export`);
    expect(customerExportRes.status).toBe(200);
    const customerExportData = await customerExportRes.json();
    const customerExportText = JSON.stringify(customerExportData);
    expect(customerExportText).not.toContain(SECRET_STRING);
    expect(customerExportText).toContain(PUBLIC_STRING);
  });

  it('W2 & N4: Customer reply transitions waiting_customer ticket back to open', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Customer resume test',
        customer_name: 'Resume Corp',
        customer_email: 'resume@corp.com',
        severity: 'low'
      })
    });
    const ticket = await createRes.json();

    await query("UPDATE tickets SET status = 'waiting_customer' WHERE id = $1", [ticket.id]);

    const replyRes = await fetch(`${baseUrl}/api/customer/tickets/${ticket.customer_token}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Here is the screenshot you requested.'
      })
    });
    expect(replyRes.status).toBe(201);

    const checkRes = await query('SELECT status FROM tickets WHERE id = $1', [ticket.id]);
    expect(checkRes.rows[0].status).toBe('open');

    const eventRes = await query(
      "SELECT * FROM ticket_events WHERE ticket_id = $1 AND event_type = 'customer_reply'",
      [ticket.id]
    );
    expect(eventRes.rows.length).toBe(1);
  });

  // ==========================================
  // Rules L1, L2, L3, L5: Lifecycle & Reopening
  // ==========================================
  it('L1: State transition table rejects disallowed moves', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Lifecycle validation ticket',
        customer_name: 'Workflow Tester',
        customer_email: 'workflow@example.com',
        severity: 'medium'
      })
    });
    const ticket = await createRes.json();

    // 1. Valid move: new -> open
    const openRes = await fetch(`${baseUrl}/api/tickets/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open', agent_id: testAgentId1 })
    });
    expect(openRes.status).toBe(200);

    // 2. Valid move: open -> closed
    const closeRes = await fetch(`${baseUrl}/api/tickets/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed', agent_id: testAgentId1 })
    });
    expect(closeRes.status).toBe(200);

    // 3. Disallowed move: closed -> open (Closed is terminal per Rule L1, L5)
    const invalidRes = await fetch(`${baseUrl}/api/tickets/${ticket.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open', agent_id: testAgentId1 })
    });
    expect(invalidRes.status).toBe(400);
    const errData = await invalidRes.json();
    expect(errData.error).toMatch(/disallowed status transition/i);
  });

  it('L2: Customer reply within 5 working days reopens a resolved ticket with a fresh resolution clock', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Reopen within window test',
        customer_name: 'Happy Customer',
        customer_email: 'happy@example.com',
        severity: 'medium'
      })
    });
    const ticket = await createRes.json();

    // Mark as resolved just 1 hour ago
    await query("UPDATE tickets SET status = 'resolved', resolved_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [ticket.id]);

    // Customer sends message within reopen window (day 0)
    const replyRes = await fetch(`${baseUrl}/api/customer/tickets/${ticket.customer_token}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Actually, the problem happened again just now!'
      })
    });

    expect(replyRes.status).toBe(201);
    const data = await replyRes.json();
    expect(data.reopened).toBe(true);

    // Assert ticket status is now open, and resolved_at is cleared
    const reopenedTicket = await query('SELECT status, resolved_at, resolution_deadline FROM tickets WHERE id = $1', [ticket.id]);
    expect(reopenedTicket.rows[0].status).toBe('open');
    expect(reopenedTicket.rows[0].resolved_at).toBeNull();
    // Fresh resolution deadline assigned
    expect(reopenedTicket.rows[0].resolution_deadline).not.toBeNull();

    // Audit log has "reopened" event
    const eventRes = await query("SELECT * FROM ticket_events WHERE ticket_id = $1 AND event_type = 'reopened'", [ticket.id]);
    expect(eventRes.rows.length).toBe(1);
    expect(eventRes.rows[0].actor_type).toBe('customer');
  });

  it('L3: Customer reply after 5 working days creates a new linked ticket without modifying old ticket', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Old printer issue',
        customer_name: 'Late Customer',
        customer_email: 'late@example.com',
        severity: 'medium'
      })
    });
    const oldTicket = await createRes.json();

    // Mark as resolved 10 working days ago (well outside the 5-day window)
    await query("UPDATE tickets SET status = 'resolved', resolved_at = NOW() - INTERVAL '14 days' WHERE id = $1", [oldTicket.id]);

    // Customer sends message after window expired
    const replyRes = await fetch(`${baseUrl}/api/customer/tickets/${oldTicket.customer_token}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Printer is jammed again after 2 weeks.'
      })
    });

    expect(replyRes.status).toBe(201);
    const data = await replyRes.json();
    expect(data.reopened).toBe(false);
    expect(data.created_new_ticket).toBe(true);
    expect(data.new_ticket).toBeDefined();
    expect(data.new_ticket.linked_ticket_id).toBe(oldTicket.id);

    // Verify old ticket was NOT changed
    const checkOld = await query('SELECT status FROM tickets WHERE id = $1', [oldTicket.id]);
    expect(checkOld.rows[0].status).toBe('resolved');
  });

  // ==========================================
  // Rule W4: Auto-close job for silent tickets
  // ==========================================
  it('W4: Scheduled auto-close job closes tickets waiting for 5 working days with actor system', async () => {
    const createRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Silence timeout test ticket',
        customer_name: 'Silent Client',
        customer_email: 'silent@client.com',
        severity: 'low'
      })
    });
    const ticket = await createRes.json();

    // Put ticket into waiting_customer 10 days ago (more than 5 working days)
    await query(
      "UPDATE tickets SET status = 'waiting_customer', updated_at = NOW() - INTERVAL '12 days' WHERE id = $1",
      [ticket.id]
    );

    // Trigger auto-close job
    const jobRes = await fetch(`${baseUrl}/api/jobs/auto-close`, { method: 'POST' });
    expect(jobRes.status).toBe(200);

    // Ticket must now be 'closed'
    const checkTicket = await query('SELECT status, closed_at FROM tickets WHERE id = $1', [ticket.id]);
    expect(checkTicket.rows[0].status).toBe('closed');
    expect(checkTicket.rows[0].closed_at).not.toBeNull();

    // Audit event must be logged with actor 'system'
    const eventRes = await query(
      "SELECT * FROM ticket_events WHERE ticket_id = $1 AND event_type = 'closed_by_silence'",
      [ticket.id]
    );
    expect(eventRes.rows.length).toBe(1);
    expect(eventRes.rows[0].actor_type).toBe('system');
  });

  // ==========================================
  // Rules A5 & A6: Breach detection & Manager report
  // ==========================================
  it('A5 & A6: Breach detection logs reason codes (unassigned vs no_action) and manager report lists them', async () => {
    // 1. Create unassigned ticket that is overdue for first response
    const unassignedRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Unassigned overdue ticket',
        customer_name: 'Orphan Corp',
        customer_email: 'orphan@corp.com',
        severity: 'critical'
      })
    });
    const unassignedTicket = await unassignedRes.json();
    await query(
      "UPDATE tickets SET first_response_deadline = NOW() - INTERVAL '2 hours' WHERE id = $1",
      [unassignedTicket.id]
    );

    // 2. Create assigned ticket that is overdue for first response
    const assignedRes = await fetch(`${baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Assigned inactive ticket',
        customer_name: 'Idle Corp',
        customer_email: 'idle@corp.com',
        severity: 'critical'
      })
    });
    const assignedTicket = await assignedRes.json();
    await fetch(`${baseUrl}/api/tickets/${assignedTicket.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: testAgentId1 })
    });
    await query(
      "UPDATE tickets SET first_response_deadline = NOW() - INTERVAL '2 hours' WHERE id = $1",
      [assignedTicket.id]
    );

    // 3. Run breach detection job (Rule A5)
    const breachJobRes = await fetch(`${baseUrl}/api/jobs/breach-detection`, { method: 'POST' });
    expect(breachJobRes.status).toBe(200);

    // Verify unassigned breach event reason code is 'unassigned'
    const unassignedEvent = await query(
      "SELECT * FROM ticket_events WHERE ticket_id = $1 AND event_type = 'breach'",
      [unassignedTicket.id]
    );
    expect(unassignedEvent.rows.length).toBe(1);
    expect(unassignedEvent.rows[0].actor_type).toBe('system');
    expect(unassignedEvent.rows[0].payload.reason).toBe('unassigned');

    // Verify assigned breach event reason code is 'no_action'
    const assignedEvent = await query(
      "SELECT * FROM ticket_events WHERE ticket_id = $1 AND event_type = 'breach'",
      [assignedTicket.id]
    );
    expect(assignedEvent.rows.length).toBe(1);
    expect(assignedEvent.rows[0].actor_type).toBe('system');
    expect(assignedEvent.rows[0].payload.reason).toBe('no_action');

    // 4. Test Manager Report (Rule A6)
    const reportRes = await fetch(`${baseUrl}/api/reports/breaches`);
    expect(reportRes.status).toBe(200);
    const reportData = await reportRes.json();

    const reportUnassigned = reportData.find(t => t.id === unassignedTicket.id);
    const reportAssigned = reportData.find(t => t.id === assignedTicket.id);

    expect(reportUnassigned).toBeDefined();
    expect(reportUnassigned.breach_events[0].payload.reason).toBe('unassigned');

    expect(reportAssigned).toBeDefined();
    expect(reportAssigned.breach_events[0].payload.reason).toBe('no_action');
    expect(reportAssigned.owner_name).toBeDefined();
  });
});
