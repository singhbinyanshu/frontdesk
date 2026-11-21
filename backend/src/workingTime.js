/**
 * workingTime.js
 * 
 * Standalone calculation module for business working minutes, working moments,
 * and working-time-based deadlines (Rules T1 - T5).
 * 
 * Rules supported:
 * - T1: Support hours are Mon-Fri 09:30 to 18:30 (9 working hours = 540 working mins/day).
 * - T2: Festival holidays count as zero working time.
 * - T3: Deadlines & elapsed times measure working minutes only. Nights/weekends/holidays count as zero.
 * - T4: Off-hours arrivals advance to the next working moment (e.g. Saturday 11:00 -> Monday 09:30).
 * - T5: A ticket is late only when its deadline has passed in working time.
 */

// Default configuration constants
const DEFAULT_WORK_START_HOUR = 9;
const DEFAULT_WORK_START_MINUTE = 30; // 09:30 = 570 minutes from midnight
const DEFAULT_WORK_END_HOUR = 18;
const DEFAULT_WORK_END_MINUTE = 30;   // 18:30 = 1110 minutes from midnight
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * Normalizes a list of holidays into a Set of 'YYYY-MM-DD' strings.
 */
function normalizeHolidays(holidays, timeZone = DEFAULT_TIMEZONE) {
  if (!holidays) return new Set();
  if (holidays instanceof Set) return holidays;
  
  const set = new Set();
  for (const h of holidays) {
    if (typeof h === 'string') {
      // If it's already 'YYYY-MM-DD'
      if (/^\d{4}-\d{2}-\d{2}$/.test(h)) {
        set.add(h);
      } else {
        const parts = getDateParts(new Date(h), timeZone);
        set.add(parts.dateStr);
      }
    } else if (h instanceof Date) {
      const parts = getDateParts(h, timeZone);
      set.add(parts.dateStr);
    }
  }
  return set;
}

/**
 * Extracts calendar date and time parts for an instant in a specific timezone.
 */
export function getDateParts(dateInput, timeZone = DEFAULT_TIMEZONE) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date input: ${dateInput}`);
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = {};
  for (const { type, value } of formatter.formatToParts(d)) {
    if (type !== 'literal') parts[type] = value;
  }

  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const second = parseInt(parts.second, 10);
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  
  // Calculate day of the week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const minuteOfDay = hour * 60 + minute;

  return { year, month, day, hour, minute, second, dateStr, dayOfWeek, minuteOfDay, originalDate: d };
}

/**
 * Creates a JavaScript Date object corresponding to the given local wall-clock
 * year, month, day, hour, minute, second in the specified timezone.
 */
export function createDateInTimezone(year, month, day, hour, minute, second = 0, timeZone = DEFAULT_TIMEZONE) {
  const pad = (n) => String(n).padStart(2, '0');
  const isoApprox = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}Z`;
  let result = new Date(isoApprox);

  // Iteratively converge to the exact instant matching desired wall-clock time in timeZone
  for (let i = 0; i < 3; i++) {
    const p = getDateParts(result, timeZone);
    const targetAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = desiredAsUtc - targetAsUtc;
    if (diff === 0) break;
    result = new Date(result.getTime() + diff);
  }
  return result;
}

/**
 * Checks whether the given date is a working day (Mon-Fri and not a holiday).
 */
export function isWorkingDay(dateInput, holidays = [], options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIMEZONE;
  const parts = getDateParts(dateInput, timeZone);
  const holidaysSet = normalizeHolidays(holidays, timeZone);

  // Monday = 1, Friday = 5
  if (parts.dayOfWeek < 1 || parts.dayOfWeek > 5) return false;
  if (holidaysSet.has(parts.dateStr)) return false;
  return true;
}

/**
 * Checks whether the given instant is currently within business working hours.
 */
export function isWorkingMoment(dateInput, holidays = [], options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIMEZONE;
  const parts = getDateParts(dateInput, timeZone);
  if (!isWorkingDay(dateInput, holidays, options)) return false;

  const startMin = (options.startHour ?? DEFAULT_WORK_START_HOUR) * 60 + (options.startMinute ?? DEFAULT_WORK_START_MINUTE);
  const endMin = (options.endHour ?? DEFAULT_WORK_END_HOUR) * 60 + (options.endMinute ?? DEFAULT_WORK_END_MINUTE);

  return parts.minuteOfDay >= startMin && parts.minuteOfDay < endMin;
}

/**
 * Returns the next working moment (Rule T4).
 * If the input instant is already within working hours on a working day, returns the instant itself.
 * If outside working hours, returns 09:30 on the next valid working day.
 */
export function nextWorkingMoment(dateInput, holidays = [], options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIMEZONE;
  const startHour = options.startHour ?? DEFAULT_WORK_START_HOUR;
  const startMinute = options.startMinute ?? DEFAULT_WORK_START_MINUTE;
  const endHour = options.endHour ?? DEFAULT_WORK_END_HOUR;
  const endMinute = options.endMinute ?? DEFAULT_WORK_END_MINUTE;
  const startMinOfDay = startHour * 60 + startMinute;
  const endMinOfDay = endHour * 60 + endMinute;

  const parts = getDateParts(dateInput, timeZone);
  const holidaysSet = normalizeHolidays(holidays, timeZone);
  const isWorking = parts.dayOfWeek >= 1 && parts.dayOfWeek <= 5 && !holidaysSet.has(parts.dateStr);

  // If today is a working day:
  if (isWorking) {
    // Case A: Before morning opening (e.g. 08:00) -> jumps to 09:30 today
    if (parts.minuteOfDay < startMinOfDay) {
      return createDateInTimezone(parts.year, parts.month, parts.day, startHour, startMinute, 0, timeZone);
    }
    // Case B: During working hours (09:30 - 18:30) -> return current moment
    if (parts.minuteOfDay < endMinOfDay) {
      return new Date(parts.originalDate);
    }
    // Case C: At or after 18:30 -> rolls over to next working day
  }

  // Find the next working day starting from tomorrow
  let curr = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  while (true) {
    curr.setUTCDate(curr.getUTCDate() + 1);
    const dayOfWeek = curr.getUTCDay();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${curr.getUTCFullYear()}-${pad(curr.getUTCMonth() + 1)}-${pad(curr.getUTCDate())}`;
    
    // Check if Mon-Fri and not holiday
    if (dayOfWeek >= 1 && dayOfWeek <= 5 && !holidaysSet.has(dateStr)) {
      return createDateInTimezone(
        curr.getUTCFullYear(),
        curr.getUTCMonth() + 1,
        curr.getUTCDate(),
        startHour,
        startMinute,
        0,
        timeZone
      );
    }
  }
}

/**
 * Calculates working minutes elapsed between two timestamps (Rule T1, T3).
 * Non-working hours, weekends, and holidays contribute 0 minutes.
 */
export function calculateWorkingMinutes(startDateInput, endDateInput, holidays = [], options = {}) {
  const start = startDateInput instanceof Date ? startDateInput : new Date(startDateInput);
  const end = endDateInput instanceof Date ? endDateInput : new Date(endDateInput);

  if (end <= start) return 0;

  const timeZone = options.timeZone || DEFAULT_TIMEZONE;
  const startHour = options.startHour ?? DEFAULT_WORK_START_HOUR;
  const startMinute = options.startMinute ?? DEFAULT_WORK_START_MINUTE;
  const endHour = options.endHour ?? DEFAULT_WORK_END_HOUR;
  const endMinute = options.endMinute ?? DEFAULT_WORK_END_MINUTE;
  const workStartMin = startHour * 60 + startMinute; // 570
  const workEndMin = endHour * 60 + endMinute;       // 1110
  const dailyWorkMins = workEndMin - workStartMin;    // 540

  const holidaysSet = normalizeHolidays(holidays, timeZone);
  const startParts = getDateParts(start, timeZone);
  const endParts = getDateParts(end, timeZone);

  // Case 1: Start and end occur on the exact same calendar date
  if (startParts.dateStr === endParts.dateStr) {
    if (!isWorkingDay(start, holidaysSet, options)) return 0;
    const windowStart = Math.max(startParts.minuteOfDay, workStartMin);
    const windowEnd = Math.min(endParts.minuteOfDay, workEndMin);
    return Math.max(0, windowEnd - windowStart);
  }

  // Case 2: Multi-day span
  let totalMinutes = 0;

  // Day 1 contribution
  if (isWorkingDay(start, holidaysSet, options)) {
    const windowStart = Math.max(startParts.minuteOfDay, workStartMin);
    if (windowStart < workEndMin) {
      totalMinutes += (workEndMin - windowStart);
    }
  }

  // Intermediate full days
  let curr = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day));
  const endUtc = new Date(Date.UTC(endParts.year, endParts.month - 1, endParts.day));

  while (true) {
    curr.setUTCDate(curr.getUTCDate() + 1);
    if (curr.getTime() >= endUtc.getTime()) break;

    const dayOfWeek = curr.getUTCDay();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${curr.getUTCFullYear()}-${pad(curr.getUTCMonth() + 1)}-${pad(curr.getUTCDate())}`;

    if (dayOfWeek >= 1 && dayOfWeek <= 5 && !holidaysSet.has(dateStr)) {
      totalMinutes += dailyWorkMins;
    }
  }

  // Final day contribution
  if (isWorkingDay(end, holidaysSet, options)) {
    const windowEnd = Math.min(endParts.minuteOfDay, workEndMin);
    if (windowEnd > workStartMin) {
      totalMinutes += (windowEnd - workStartMin);
    }
  }

  return totalMinutes;
}

/**
 * Adds a given number of working minutes to a starting timestamp (Rule T1, T3, T4).
 * If the start time is outside working hours, it first snaps to nextWorkingMoment.
 */
export function addWorkingMinutes(startDateInput, minutesToAdd, holidays = [], options = {}) {
  if (minutesToAdd < 0) {
    throw new Error('minutesToAdd cannot be negative');
  }
  if (minutesToAdd === 0) {
    return new Date(startDateInput);
  }

  const timeZone = options.timeZone || DEFAULT_TIMEZONE;
  const startHour = options.startHour ?? DEFAULT_WORK_START_HOUR;
  const startMinute = options.startMinute ?? DEFAULT_WORK_START_MINUTE;
  const endHour = options.endHour ?? DEFAULT_WORK_END_HOUR;
  const endMinute = options.endMinute ?? DEFAULT_WORK_END_MINUTE;
  const workStartMin = startHour * 60 + startMinute; // 570
  const workEndMin = endHour * 60 + endMinute;       // 1110
  const dailyWorkMins = workEndMin - workStartMin;    // 540

  const holidaysSet = normalizeHolidays(holidays, timeZone);

  // Advance starting point to next working moment if outside working hours
  let current = nextWorkingMoment(startDateInput, holidaysSet, options);
  let remainingMinutes = minutesToAdd;

  while (remainingMinutes > 0) {
    const parts = getDateParts(current, timeZone);
    const minutesLeftToday = workEndMin - parts.minuteOfDay;

    if (remainingMinutes <= minutesLeftToday) {
      // Finished on this working day
      return new Date(current.getTime() + remainingMinutes * 60 * 1000);
    }

    // Exhaust remaining minutes today, then jump to start of next working day
    remainingMinutes -= minutesLeftToday;

    // Advance to next calendar day
    let nextDayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    while (true) {
      nextDayUtc.setUTCDate(nextDayUtc.getUTCDate() + 1);
      const dayOfWeek = nextDayUtc.getUTCDay();
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${nextDayUtc.getUTCFullYear()}-${pad(nextDayUtc.getUTCMonth() + 1)}-${pad(nextDayUtc.getUTCDate())}`;
      if (dayOfWeek >= 1 && dayOfWeek <= 5 && !holidaysSet.has(dateStr)) {
        current = createDateInTimezone(
          nextDayUtc.getUTCFullYear(),
          nextDayUtc.getUTCMonth() + 1,
          nextDayUtc.getUTCDate(),
          startHour,
          startMinute,
          0,
          timeZone
        );
        break;
      }
    }
  }

  return current;
}

/**
 * Checks whether a ticket deadline has breached relative to a reference moment (Rule T5).
 */
export function isLate(deadlineInput, currentMomentInput = new Date()) {
  const deadline = deadlineInput instanceof Date ? deadlineInput : new Date(deadlineInput);
  const current = currentMomentInput instanceof Date ? currentMomentInput : new Date(currentMomentInput);
  return current.getTime() > deadline.getTime();
}
