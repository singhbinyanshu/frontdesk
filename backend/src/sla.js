/**
 * sla.js
 * 
 * SLA calculation, lifecycle tracking, customer pause/resume, and severity management.
 * Enforces rules S1-S5, W1-W3, and V1-V3.
 * 
 * Rules supported:
 * - S1: Three severities: Critical, Medium, Low.
 * - S2: Two separate clocks (first response and resolution) with configurable defaults.
 * - S3: Critical resolution is end of the same working day (18:30).
 * - S4: First response must be a public reply by an agent; internal notes do not count.
 * - S5: Resolution clock stops when ticket is marked Resolved.
 * - W1: "Waiting on customer" pauses both response and resolution clocks.
 * - W2: Customer reply resumes clocks and returns status to Open.
 * - W3: Waiting tickets show "Waiting" (not "Late"); prior breaches stay recorded.
 * - V1: Changing severity preserves elapsed working time; new targets apply from ticket start.
 * - V2: If stricter target has already elapsed, ticket breaches immediately.
 * - V3: Downgrading severity never erases a recorded breach.
 */

import {
  nextWorkingMoment,
  addWorkingMinutes,
  calculateWorkingMinutes,
  getDateParts,
  createDateInTimezone,
  isLate
} from './workingTime.js';

// Rule S1 & S2: Default configurable SLA targets
export const DEFAULT_SLA_CONFIG = {
  critical: {
    responseMinutes: 2 * 60,   // 2 working hours = 120 minutes
    resolveSameDay: true       // End of same working day (18:30) (Rule S3)
  },
  medium: {
    responseMinutes: 4.5 * 60, // Half a working day = 270 minutes
    resolveMinutes: 3 * 9 * 60 // 3 working days = 27 working hours = 1620 minutes
  },
  low: {
    responseMinutes: 9 * 60,   // 1 working day = 540 minutes
    resolveMinutes: 5 * 9 * 60 // 5 working days = 45 working hours = 2700 minutes
  }
};

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * Calculates deadlines from clock start for a given severity.
 */
export function calculateDeadlines(clockStart, severity, holidays = [], slaConfig = DEFAULT_SLA_CONFIG, options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIMEZONE;
  const config = slaConfig[severity];
  if (!config) {
    throw new Error(`Unknown severity: ${severity}`);
  }

  // First response deadline
  const firstResponseDeadline = addWorkingMinutes(clockStart, config.responseMinutes, holidays, options);

  // Resolution deadline
  let resolutionDeadline;
  if (severity === 'critical' && config.resolveSameDay) {
    // Rule S3: By 18:30 on the working day the clock started
    const parts = getDateParts(clockStart, timeZone);
    const endHour = options.endHour ?? 18;
    const endMinute = options.endMinute ?? 30;
    resolutionDeadline = createDateInTimezone(parts.year, parts.month, parts.day, endHour, endMinute, 0, timeZone);
  } else {
    resolutionDeadline = addWorkingMinutes(clockStart, config.resolveMinutes, holidays, options);
  }

  return { firstResponseDeadline, resolutionDeadline };
}

/**
 * Creates a new ticket state object with computed SLA deadlines (Rules S1, S2, S3, T4).
 */
export function createTicket({
  id = 1,
  createdAt,
  severity = 'medium',
  holidays = [],
  slaConfig = DEFAULT_SLA_CONFIG,
  options = {}
}) {
  const timeZone = options.timeZone || DEFAULT_TIMEZONE;
  const createdDate = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const clockStart = nextWorkingMoment(createdDate, holidays, options);

  const { firstResponseDeadline, resolutionDeadline } = calculateDeadlines(
    clockStart,
    severity,
    holidays,
    slaConfig,
    options
  );

  return {
    id,
    severity,
    status: 'new',
    createdAt: createdDate,
    clockStart,
    firstResponseDeadline,
    resolutionDeadline,
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    firstResponseBreached: false,
    resolutionBreached: false,
    pausedAt: null,
    totalPausedWorkingMinutes: 0
  };
}

/**
 * Records a message on a ticket (Rule S4, W2).
 * - Agent internal note: Never stops first response clock.
 * - Agent public reply: Stops first response clock; marks breach if late.
 * - Customer reply while in waiting_customer: Resumes clocks, returns to open.
 */
export function handleMessage(ticket, message, holidays = [], options = {}) {
  const messageTime = message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt);

  // Rule W2: Customer reply resumes clocks if waiting on customer
  if (message.senderType === 'customer' && ticket.status === 'waiting_customer') {
    resumeTicket(ticket, messageTime, holidays, options);
  }

  // Rule S4: First response must be an AGENT PUBLIC reply
  if (message.senderType === 'agent' && message.visibility === 'public') {
    if (!ticket.firstResponseAt) {
      ticket.firstResponseAt = messageTime;
      if (isLate(ticket.firstResponseDeadline, messageTime)) {
        ticket.firstResponseBreached = true;
      }
    }
  }

  return ticket;
}

/**
 * Pauses a ticket when waiting on the customer (Rule W1).
 */
export function pauseTicket(ticket, pausedAt) {
  const pauseTime = pausedAt instanceof Date ? pausedAt : new Date(pausedAt);
  if (ticket.status === 'waiting_customer') return ticket;

  ticket.status = 'waiting_customer';
  ticket.pausedAt = pauseTime;
  return ticket;
}

/**
 * Resumes a paused ticket upon customer reply (Rule W2).
 * Extends active deadlines by the paused working minutes.
 */
export function resumeTicket(ticket, resumedAt, holidays = [], options = {}) {
  const resumeTime = resumedAt instanceof Date ? resumedAt : new Date(resumedAt);
  if (ticket.status !== 'waiting_customer' || !ticket.pausedAt) return ticket;

  const pausedWorkingMinutes = calculateWorkingMinutes(ticket.pausedAt, resumeTime, holidays, options);
  ticket.totalPausedWorkingMinutes += pausedWorkingMinutes;

  // Extend deadlines by the paused working minutes if not yet satisfied
  if (!ticket.firstResponseAt && pausedWorkingMinutes > 0) {
    ticket.firstResponseDeadline = addWorkingMinutes(
      ticket.firstResponseDeadline,
      pausedWorkingMinutes,
      holidays,
      options
    );
  }

  if (!ticket.resolvedAt && pausedWorkingMinutes > 0) {
    ticket.resolutionDeadline = addWorkingMinutes(
      ticket.resolutionDeadline,
      pausedWorkingMinutes,
      holidays,
      options
    );
  }

  ticket.status = 'open';
  ticket.pausedAt = null;
  return ticket;
}

/**
 * Marks a ticket as Resolved (Rule S5).
 * Stops the resolution clock and evaluates resolution lateness.
 */
export function resolveTicket(ticket, resolvedAt) {
  const resolveTime = resolvedAt instanceof Date ? resolvedAt : new Date(resolvedAt);
  ticket.status = 'resolved';
  ticket.resolvedAt = resolveTime;

  if (isLate(ticket.resolutionDeadline, resolveTime)) {
    ticket.resolutionBreached = true;
  }
  return ticket;
}

/**
 * Changes ticket severity mid-way (Rules V1, V2, V3).
 * - Elapsed working time is preserved.
 * - New targets apply relative to ticket start (plus accumulated paused minutes).
 * - If new target has already passed, ticket breaches immediately (V2).
 * - Prior breaches survive downgrades (V3).
 */
export function changeSeverity(ticket, newSeverity, changeTime, holidays = [], slaConfig = DEFAULT_SLA_CONFIG, options = {}) {
  const atTime = changeTime instanceof Date ? changeTime : new Date(changeTime);
  const oldSeverity = ticket.severity;
  ticket.severity = newSeverity;

  const config = slaConfig[newSeverity];
  if (!config) throw new Error(`Unknown severity: ${newSeverity}`);

  // Recalculate response deadline if first response hasn't happened yet
  if (!ticket.firstResponseAt) {
    const totalAllowedWorkingMins = config.responseMinutes + ticket.totalPausedWorkingMinutes;
    ticket.firstResponseDeadline = addWorkingMinutes(ticket.clockStart, totalAllowedWorkingMins, holidays, options);

    // Rule V2: If new target has already elapsed, breaches immediately
    if (isLate(ticket.firstResponseDeadline, atTime)) {
      ticket.firstResponseBreached = true;
    }
  }

  // Recalculate resolution deadline if not yet resolved
  if (!ticket.resolvedAt) {
    if (newSeverity === 'critical' && config.resolveSameDay) {
      const parts = getDateParts(ticket.clockStart, options.timeZone || DEFAULT_TIMEZONE);
      const endHour = options.endHour ?? 18;
      const endMinute = options.endMinute ?? 30;
      let deadline = createDateInTimezone(parts.year, parts.month, parts.day, endHour, endMinute, 0, options.timeZone || DEFAULT_TIMEZONE);
      
      // If there were paused minutes, extend deadline
      if (ticket.totalPausedWorkingMinutes > 0) {
        deadline = addWorkingMinutes(deadline, ticket.totalPausedWorkingMinutes, holidays, options);
      }
      ticket.resolutionDeadline = deadline;
    } else {
      const totalAllowedWorkingMins = config.resolveMinutes + ticket.totalPausedWorkingMinutes;
      ticket.resolutionDeadline = addWorkingMinutes(ticket.clockStart, totalAllowedWorkingMins, holidays, options);
    }

    // Rule V2: If new target has already elapsed, breaches immediately
    if (isLate(ticket.resolutionDeadline, atTime)) {
      ticket.resolutionBreached = true;
    }
  }

  // Rule V3: A recorded breach survives a downgrade (preserved unconditionally)
  // ticket.firstResponseBreached and ticket.resolutionBreached remain true if previously true

  return ticket;
}

/**
 * Returns the active status badge for the UI (Rule W3, U1).
 * - Waiting tickets display "Waiting", not "Late".
 * - Late tickets display "Late".
 */
export function getTicketBadge(ticket, currentMoment = new Date()) {
  // Rule W3: A waiting ticket is shown as "Waiting", not "Late"
  if (ticket.status === 'waiting_customer') {
    return 'Waiting';
  }

  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    return ticket.status;
  }

  // Check if response or resolution is currently late
  const responseLate = !ticket.firstResponseAt && isLate(ticket.firstResponseDeadline, currentMoment);
  const resolutionLate = !ticket.resolvedAt && isLate(ticket.resolutionDeadline, currentMoment);

  if (ticket.firstResponseBreached || ticket.resolutionBreached || responseLate || resolutionLate) {
    return 'Late';
  }

  return ticket.status;
}
