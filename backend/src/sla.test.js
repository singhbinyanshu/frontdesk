import { describe, it, expect } from 'vitest';
import {
  createTicket,
  handleMessage,
  pauseTicket,
  resumeTicket,
  resolveTicket,
  changeSeverity,
  getTicketBadge,
  DEFAULT_SLA_CONFIG
} from './sla.js';
import { getDateParts } from './workingTime.js';

describe('SLA Deadline & Lifecycle Engine', () => {
  const TZ = 'Asia/Kolkata';
  const options = { timeZone: TZ };

  // ==========================================
  // Section 2: Severity and deadlines (Rules S1 - S5)
  // ==========================================
  describe('Rules S1 - S5: Severity & Deadlines', () => {
    it('S1: Supports Critical, Medium, and Low severities', () => {
      const crit = createTicket({ createdAt: '2026-11-23T10:00:00+05:30', severity: 'critical', options });
      const med = createTicket({ createdAt: '2026-11-23T10:00:00+05:30', severity: 'medium', options });
      const low = createTicket({ createdAt: '2026-11-23T10:00:00+05:30', severity: 'low', options });

      expect(crit.severity).toBe('critical');
      expect(med.severity).toBe('medium');
      expect(low.severity).toBe('low');
    });

    it('S2: A Critical ticket created 10:00 has a response deadline of 12:00', () => {
      // Monday 10:00
      const ticket = createTicket({
        createdAt: '2026-11-23T10:00:00+05:30',
        severity: 'critical',
        options
      });

      const responseParts = getDateParts(ticket.firstResponseDeadline, TZ);
      expect(responseParts.dateStr).toBe('2026-11-23');
      expect(responseParts.hour).toBe(12);
      expect(responseParts.minute).toBe(0);
    });

    it('S2: A Medium ticket created Friday 16:00 gets its response deadline on Monday', () => {
      // Friday 16:00. Medium response target = 4.5 working hours (270 minutes)
      // Friday 16:00 to 18:30 = 2.5 hours (150 minutes). Remaining = 2 hours (120 minutes).
      // Monday 09:30 + 120 minutes = Monday 11:30
      const ticket = createTicket({
        createdAt: '2026-11-20T16:00:00+05:30',
        severity: 'medium',
        options
      });

      const responseParts = getDateParts(ticket.firstResponseDeadline, TZ);
      expect(responseParts.dateStr).toBe('2026-11-23'); // Monday
      expect(responseParts.hour).toBe(11);
      expect(responseParts.minute).toBe(30);
    });

    it('S3: Same working day for Critical tickets (arriving at 18:00 has 30 minutes left)', () => {
      // Friday 18:00
      const ticket = createTicket({
        createdAt: '2026-11-20T18:00:00+05:30',
        severity: 'critical',
        options
      });

      const resParts = getDateParts(ticket.resolutionDeadline, TZ);
      expect(resParts.dateStr).toBe('2026-11-20');
      expect(resParts.hour).toBe(18);
      expect(resParts.minute).toBe(30);
    });

    it('S4: An internal note does not stop the response clock', () => {
      const ticket = createTicket({
        createdAt: '2026-11-23T10:00:00+05:30',
        severity: 'critical',
        options
      });

      // Internal agent note posted at 10:30
      handleMessage(
        ticket,
        {
          senderType: 'agent',
          visibility: 'internal',
          body: 'Private triage discussion',
          createdAt: '2026-11-23T10:30:00+05:30'
        },
        [],
        options
      );

      // Response clock must NOT be stopped
      expect(ticket.firstResponseAt).toBeNull();
      expect(ticket.firstResponseBreached).toBe(false);

      // Public reply posted at 11:00
      handleMessage(
        ticket,
        {
          senderType: 'agent',
          visibility: 'public',
          body: 'Hello, we are investigating your issue.',
          createdAt: '2026-11-23T11:00:00+05:30'
        },
        [],
        options
      );

      // Public reply stops the clock
      expect(ticket.firstResponseAt).not.toBeNull();
      expect(ticket.firstResponseBreached).toBe(false);
    });

    it('S5: The resolution clock stops when the ticket is marked Resolved', () => {
      const ticket = createTicket({
        createdAt: '2026-11-23T10:00:00+05:30',
        severity: 'medium',
        options
      });

      expect(ticket.resolvedAt).toBeNull();

      // Resolved on Tuesday at 14:00 (within 3 days)
      resolveTicket(ticket, '2026-11-24T14:00:00+05:30');

      expect(ticket.status).toBe('resolved');
      expect(ticket.resolvedAt).toEqual(new Date('2026-11-24T14:00:00+05:30'));
      expect(ticket.resolutionBreached).toBe(false);
    });
  });

  // ==========================================
  // Section 4: Waiting on the customer (Rules W1 - W3)
  // ==========================================
  describe('Rules W1 - W3: Waiting on Customer Pause/Resume', () => {
    it('W1: A 3-day wait adds nothing to elapsed working time', () => {
      // Ticket created Monday 10:00, Medium severity (response deadline Monday 14:30)
      const ticket = createTicket({
        createdAt: '2026-11-23T10:00:00+05:30',
        severity: 'medium',
        options
      });

      // Agent sets ticket to Waiting on customer on Monday at 11:00
      pauseTicket(ticket, '2026-11-23T11:00:00+05:30');
      expect(ticket.status).toBe('waiting_customer');

      // Customer waits 3 full working days and replies Thursday at 11:00
      resumeTicket(ticket, '2026-11-26T11:00:00+05:30', [], options);

      expect(ticket.status).toBe('open');
      // Paused working minutes = 3 days * 540 = 1620 minutes
      expect(ticket.totalPausedWorkingMinutes).toBe(1620);

      // Deadlines must have extended forward by 3 full working days:
      // Original response deadline was Mon 14:30 -> New deadline is Thu 14:30
      const responseParts = getDateParts(ticket.firstResponseDeadline, TZ);
      expect(responseParts.dateStr).toBe('2026-11-26'); // Thursday
      expect(responseParts.hour).toBe(14);
      expect(responseParts.minute).toBe(30);
    });

    it('W2: A reply resumes the clock', () => {
      const ticket = createTicket({
        createdAt: '2026-11-23T10:00:00+05:30',
        severity: 'medium',
        options
      });

      pauseTicket(ticket, '2026-11-23T11:00:00+05:30');
      expect(ticket.status).toBe('waiting_customer');

      // Customer message sent through handleMessage
      handleMessage(
        ticket,
        {
          senderType: 'customer',
          visibility: 'public',
          body: 'Here is the requested log file.',
          createdAt: '2026-11-23T12:00:00+05:30' // 1 hour pause
        },
        [],
        options
      );

      expect(ticket.status).toBe('open');
      expect(ticket.pausedAt).toBeNull();
      expect(ticket.totalPausedWorkingMinutes).toBe(60);

      // Deadline extended by 1 hour: 14:30 -> 15:30
      const parts = getDateParts(ticket.firstResponseDeadline, TZ);
      expect(parts.hour).toBe(15);
      expect(parts.minute).toBe(30);
    });

    it('W3: A waiting ticket is shown as Waiting, not Late; recorded breach stays recorded', () => {
      const ticket = createTicket({
        createdAt: '2026-11-23T10:00:00+05:30',
        severity: 'critical', // response deadline 12:00
        options
      });

      // Ticket is overdue at 13:00 without reply
      expect(getTicketBadge(ticket, '2026-11-23T13:00:00+05:30')).toBe('Late');

      // Now set to waiting at 13:00
      pauseTicket(ticket, '2026-11-23T13:00:00+05:30');
      ticket.firstResponseBreached = true; // recorded breach

      // While in waiting_customer, badge must be "Waiting", NOT "Late" (Rule W3)
      expect(getTicketBadge(ticket, '2026-11-23T13:30:00+05:30')).toBe('Waiting');

      // Recorded breach must stay recorded
      expect(ticket.firstResponseBreached).toBe(true);
    });
  });

  // ==========================================
  // Section 3: Changing severity mid-way (Rules V1 - V3)
  // ==========================================
  describe('Rules V1 - V3: Severity Changes Mid-Way', () => {
    it('V1: Keeps working time already used; new targets apply from original start', () => {
      // Low ticket created Monday 09:30 (Low response deadline: 9 working hours = Monday 18:30)
      const ticket = createTicket({
        createdAt: '2026-11-23T09:30:00+05:30',
        severity: 'low',
        options
      });

      // At Monday 11:30 (2 working hours elapsed), changed to Medium (target: 4.5 hours from start = 14:00)
      changeSeverity(ticket, 'medium', '2026-11-23T11:30:00+05:30', [], DEFAULT_SLA_CONFIG, options);

      const parts = getDateParts(ticket.firstResponseDeadline, TZ);
      expect(parts.dateStr).toBe('2026-11-23');
      expect(parts.hour).toBe(14); // 09:30 + 4.5h = 14:00
      expect(parts.minute).toBe(0);
      expect(ticket.firstResponseBreached).toBe(false);
    });

    it('V2: Medium ticket, 6 working hours old, changed to Critical becomes late immediately', () => {
      // Monday 09:30 start
      const ticket = createTicket({
        createdAt: '2026-11-23T09:30:00+05:30',
        severity: 'medium',
        options
      });

      // At Monday 15:30 (6 working hours elapsed since 09:30)
      // Changed to Critical (Critical response SLA is 2 working hours, so deadline was 11:30)
      changeSeverity(ticket, 'critical', '2026-11-23T15:30:00+05:30', [], DEFAULT_SLA_CONFIG, options);

      // Becomes late immediately!
      expect(ticket.firstResponseBreached).toBe(true);
      expect(getTicketBadge(ticket, '2026-11-23T15:30:00+05:30')).toBe('Late');
    });

    it('V3: A recorded breach survives a downgrade', () => {
      // Critical ticket created Monday 10:00, deadline 12:00
      const ticket = createTicket({
        createdAt: '2026-11-23T10:00:00+05:30',
        severity: 'critical',
        options
      });

      // At 13:00, ticket has breached (3 hours elapsed without public reply)
      ticket.firstResponseBreached = true;

      // Downgrade to Low at 13:00 (Low allows 9 hours, deadline 18:30)
      changeSeverity(ticket, 'low', '2026-11-23T13:00:00+05:30', [], DEFAULT_SLA_CONFIG, options);

      // The recorded breach MUST survive the downgrade!
      expect(ticket.firstResponseBreached).toBe(true);
    });
  });
});
