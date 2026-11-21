import { describe, it, expect } from 'vitest';
import {
  calculateWorkingMinutes,
  nextWorkingMoment,
  addWorkingMinutes,
  isWorkingDay,
  isWorkingMoment,
  isLate,
  getDateParts
} from './workingTime.js';

describe('Working Time Module (Rules T1 - T5)', () => {
  // Test timezone: Asia/Kolkata (UTC+05:30)
  const TZ = 'Asia/Kolkata';

  describe('T1: Support hours are Mon-Fri 09:30 to 18:30 (9 working hours per day)', () => {
    it('T1: calculates exactly 540 working minutes (9 hours) for a full workday', () => {
      // Monday 09:30 to Monday 18:30
      const start = '2026-11-23T09:30:00+05:30';
      const end = '2026-11-23T18:30:00+05:30';
      const minutes = calculateWorkingMinutes(start, end, [], { timeZone: TZ });
      expect(minutes).toBe(540); // 9 hours * 60 = 540
    });

    it('T1: recognizes working days vs weekends', () => {
      // 2026-11-20 is Friday (working), 2026-11-21 is Saturday (non-working), 2026-11-22 is Sunday (non-working)
      expect(isWorkingDay('2026-11-20T12:00:00+05:30', [], { timeZone: TZ })).toBe(true);
      expect(isWorkingDay('2026-11-21T12:00:00+05:30', [], { timeZone: TZ })).toBe(false);
      expect(isWorkingDay('2026-11-22T12:00:00+05:30', [], { timeZone: TZ })).toBe(false);
      expect(isWorkingDay('2026-11-23T12:00:00+05:30', [], { timeZone: TZ })).toBe(true);
    });
  });

  describe('T2: Festival holidays are skipped', () => {
    it('T2: A holiday is skipped', () => {
      // Monday 2026-11-23 to Wednesday 2026-11-25
      // Tuesday 2026-11-24 is marked as a festival holiday
      const holidays = ['2026-11-24'];
      const start = '2026-11-23T09:30:00+05:30';
      const end = '2026-11-25T18:30:00+05:30';

      const minutes = calculateWorkingMinutes(start, end, holidays, { timeZone: TZ });
      // Monday = 540, Tuesday = 0 (holiday), Wednesday = 540. Total = 1080.
      expect(minutes).toBe(1080);

      // Adding 10 hours (600 minutes) from Monday 09:30 with Tuesday holiday
      // Mon 09:30 -> Mon 18:30 (540 mins consumed, 60 mins remaining)
      // Tuesday is skipped -> Wed 09:30 + 60 mins = Wed 10:30
      const deadline = addWorkingMinutes(start, 600, holidays, { timeZone: TZ });
      const deadlineParts = getDateParts(deadline, TZ);
      expect(deadlineParts.dateStr).toBe('2026-11-25');
      expect(deadlineParts.hour).toBe(10);
      expect(deadlineParts.minute).toBe(30);
    });
  });

  describe('T3: Clocks count working minutes only (nights and weekends count as zero)', () => {
    it('T3: A ticket spanning a weekend counts only working minutes', () => {
      // Friday 16:00 to Monday 11:30
      const start = '2026-11-20T16:00:00+05:30'; // Friday 16:00
      const end = '2026-11-23T11:30:00+05:30';   // Monday 11:30
      
      // Friday: 16:00 to 18:30 = 2.5 hours = 150 minutes
      // Saturday: 0
      // Sunday: 0
      // Monday: 09:30 to 11:30 = 2 hours = 120 minutes
      // Total = 150 + 120 = 270 minutes (4.5 hours)
      const minutes = calculateWorkingMinutes(start, end, [], { timeZone: TZ });
      expect(minutes).toBe(270);
    });

    it('T3: Overnight outside working hours accumulates 0 minutes', () => {
      // Monday 18:30 to Tuesday 09:30
      const start = '2026-11-23T18:30:00+05:30';
      const end = '2026-11-24T09:30:00+05:30';
      const minutes = calculateWorkingMinutes(start, end, [], { timeZone: TZ });
      expect(minutes).toBe(0);
    });
  });

  describe('T4: Next working moment for off-hours arrivals', () => {
    it('T4: Saturday arrival starts Monday 09:30', () => {
      // Saturday 11:00
      const satArrival = '2026-11-21T11:00:00+05:30';
      const nextMoment = nextWorkingMoment(satArrival, [], { timeZone: TZ });
      const parts = getDateParts(nextMoment, TZ);
      
      expect(parts.dateStr).toBe('2026-11-23'); // Monday
      expect(parts.hour).toBe(9);
      expect(parts.minute).toBe(30);
      expect(parts.second).toBe(0);
    });

    it('T4: weekday evening (after 18:30) starts next morning at 09:30', () => {
      // Tuesday 20:00 -> Wednesday 09:30
      const eveningArrival = '2026-11-24T20:00:00+05:30';
      const nextMoment = nextWorkingMoment(eveningArrival, [], { timeZone: TZ });
      const parts = getDateParts(nextMoment, TZ);

      expect(parts.dateStr).toBe('2026-11-25');
      expect(parts.hour).toBe(9);
      expect(parts.minute).toBe(30);
    });

    it('T4: arrival during working hours returns the exact same moment', () => {
      // Wednesday 14:15:30
      const midDay = '2026-11-25T14:15:30+05:30';
      const moment = nextWorkingMoment(midDay, [], { timeZone: TZ });
      expect(new Date(moment).getTime()).toBe(new Date(midDay).getTime());
    });
  });

  describe('T5: Lateness is evaluated strictly against working time', () => {
    it('T5: Friday 18:00 ticket is not late on Sunday', () => {
      // Ticket arrives Friday at 18:00
      const arrival = '2026-11-20T18:00:00+05:30';
      
      // Critical SLA: First response within 2 working hours (120 working minutes)
      // Friday 18:00 to 18:30 uses 30 working minutes (90 working minutes remaining)
      // Clocks pause at 18:30 Friday and resume Monday 09:30
      // Deadline is Monday 09:30 + 90 mins = Monday 11:00
      const responseDeadline = addWorkingMinutes(arrival, 120, [], { timeZone: TZ });
      const deadlineParts = getDateParts(responseDeadline, TZ);

      expect(deadlineParts.dateStr).toBe('2026-11-23'); // Monday
      expect(deadlineParts.hour).toBe(11);
      expect(deadlineParts.minute).toBe(0);

      // Check on Sunday morning at 10:00
      const sundayMorning = '2026-11-22T10:00:00+05:30';
      
      // 1. Working minutes elapsed between Friday 18:00 and Sunday 10:00 is only 30 mins
      const elapsedWorkingMinutes = calculateWorkingMinutes(arrival, sundayMorning, [], { timeZone: TZ });
      expect(elapsedWorkingMinutes).toBe(30);

      // 2. The ticket is NOT late on Sunday
      expect(isLate(responseDeadline, sundayMorning)).toBe(false);

      // 3. The ticket only becomes late after Monday 11:00
      const mondayBeforeDeadline = '2026-11-23T10:59:00+05:30';
      const mondayAfterDeadline = '2026-11-23T11:01:00+05:30';

      expect(isLate(responseDeadline, mondayBeforeDeadline)).toBe(false);
      expect(isLate(responseDeadline, mondayAfterDeadline)).toBe(true);
    });
  });
});
