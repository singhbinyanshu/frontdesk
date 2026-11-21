/**
 * jobs.js
 * 
 * Scheduled background automation jobs:
 * - W4: Auto-closes tickets in waiting_customer status after 5 working days of silence.
 * - A5: Detects SLA breaches and logs audit events with reason codes (unassigned vs no_action).
 */

import pool, { query } from './db/db.js';
import { calculateWorkingMinutes, isLate } from './workingTime.js';

// Helper to fetch holidays
async function getHolidays() {
  const result = await query('SELECT holiday_date FROM holidays');
  return result.rows.map(r => {
    const d = new Date(r.holiday_date);
    return d.toISOString().split('T')[0];
  });
}

// Helper to fetch a numeric setting
async function getSettingNumber(key, defaultValue) {
  const result = await query('SELECT value FROM settings WHERE key = $1', [key]);
  if (result.rowCount === 0) return defaultValue;
  const val = parseFloat(result.rows[0].value);
  return isNaN(val) ? defaultValue : val;
}

/**
 * Rule W4: Auto-closes tickets waiting on customer for 5 working days (configurable).
 */
export async function runAutoCloseJob(referenceTime = new Date()) {
  const holidays = await getHolidays();
  const silenceDays = await getSettingNumber('silence_close_days', 5);
  const maxSilenceWorkingMins = silenceDays * 540; // 5 days * 540 mins/day = 2700 mins

  // Find all tickets currently waiting on customer
  const result = await query("SELECT * FROM tickets WHERE status = 'waiting_customer'");
  const closedTickets = [];

  for (const ticket of result.rows) {
    // If paused_at is missing, fallback to updated_at
    const pauseStart = ticket.updated_at ? new Date(ticket.updated_at) : new Date(ticket.created_at);
    const elapsedWorkingMins = calculateWorkingMinutes(pauseStart, referenceTime, holidays);

    if (elapsedWorkingMins >= maxSilenceWorkingMins) {
      // Auto-close ticket
      await query(
        `UPDATE tickets 
         SET status = 'closed', closed_at = NOW(), updated_at = NOW() 
         WHERE id = $1`,
        [ticket.id]
      );

      // Audit event with actor "system" (Rule W4)
      await query(
        `INSERT INTO ticket_events (ticket_id, event_type, actor_type, payload, created_at)
         VALUES ($1, 'closed_by_silence', 'system', $2, NOW())`,
        [ticket.id, JSON.stringify({ silence_days: silenceDays, elapsed_working_minutes: elapsedWorkingMins })]
      );

      closedTickets.push(ticket.id);
    }
  }

  return { closedCount: closedTickets.length, ticketIds: closedTickets };
}

/**
 * Rule A5: Detects missed deadlines and logs breach rows with reason codes:
 * - 'unassigned': nobody owned the ticket
 * - 'no_action': owned, but no response/resolution in time
 */
export async function runBreachDetectionJob(referenceTime = new Date()) {
  const breachedEvents = [];

  // 1. First Response Breaches
  // Tickets that are still waiting for first response and deadline has passed
  const responseOverdueResult = await query(`
    SELECT id, owner_agent_id, first_response_deadline 
    FROM tickets 
    WHERE first_response_at IS NULL 
      AND first_response_breached = FALSE 
      AND first_response_deadline < $1
  `, [referenceTime]);

  for (const ticket of responseOverdueResult.rows) {
    const reasonCode = ticket.owner_agent_id ? 'no_action' : 'unassigned';

    await query(
      `UPDATE tickets 
       SET first_response_breached = TRUE, updated_at = NOW() 
       WHERE id = $1`,
      [ticket.id]
    );

    await query(
      `INSERT INTO ticket_events (ticket_id, event_type, actor_type, payload, created_at)
       VALUES ($1, 'breach', 'system', $2, NOW())`,
      [
        ticket.id,
        JSON.stringify({
          breach_type: 'first_response',
          reason: reasonCode,
          owner_agent_id: ticket.owner_agent_id,
          deadline: ticket.first_response_deadline
        })
      ]
    );

    breachedEvents.push({ ticket_id: ticket.id, type: 'first_response', reason: reasonCode });
  }

  // 2. Resolution Breaches
  // Tickets that are not yet resolved/closed and resolution deadline has passed
  const resolutionOverdueResult = await query(`
    SELECT id, owner_agent_id, resolution_deadline 
    FROM tickets 
    WHERE resolved_at IS NULL 
      AND resolution_breached = FALSE 
      AND status NOT IN ('resolved', 'closed')
      AND resolution_deadline < $1
  `, [referenceTime]);

  for (const ticket of resolutionOverdueResult.rows) {
    const reasonCode = ticket.owner_agent_id ? 'no_action' : 'unassigned';

    await query(
      `UPDATE tickets 
       SET resolution_breached = TRUE, updated_at = NOW() 
       WHERE id = $1`,
      [ticket.id]
    );

    await query(
      `INSERT INTO ticket_events (ticket_id, event_type, actor_type, payload, created_at)
       VALUES ($1, 'breach', 'system', $2, NOW())`,
      [
        ticket.id,
        JSON.stringify({
          breach_type: 'resolution',
          reason: reasonCode,
          owner_agent_id: ticket.owner_agent_id,
          deadline: ticket.resolution_deadline
        })
      ]
    );

    breachedEvents.push({ ticket_id: ticket.id, type: 'resolution', reason: reasonCode });
  }

  return { detectedCount: breachedEvents.length, breaches: breachedEvents };
}
