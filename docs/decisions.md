# Decisions & Open Questions

Each time the story was silent or unclear, I decided and wrote it here.

## D1: Severity change mid-way
- **Question:** What happens to the timer if a ticket becomes urgent?
- **My decision:** The ticket keeps the cumulative working time already elapsed. The new severity's SLA targets (both response and resolution) apply relative to the ticket's original start time. If the elapsed working time already exceeds the new severity target, the ticket breaches immediately. Any breach previously logged is permanent and is never revoked by a subsequent downgrade. If first response was already completed prior to the change, only the resolution SLA is updated.
- **Why:** Resetting the clock would allow SLA gaming (e.g., escalating/de-escalating to grant more time), which misrepresents service quality to clients. Applying the target retrospectively guarantees accountability.
- **Alternative I rejected, and why:** 
  - *Resetting the clock from 0:* Rejected because an issue that sat idle for 4 hours before being marked Critical would get another fresh 2-hour window, masking poor initial triage.
  - *Pro-rating elapsed percentages:* Overly complex and unintuitive for agents and managers to reason about or verify from audit logs.

## D2: "Same working day" for Critical tickets
- **Question:** How is "same working day" defined, particularly for Critical tickets arriving late in the shift?
- **My decision:** For Critical tickets whose clock begins on day $D$, the resolution target is 18:30 on day $D$. However, for tickets submitted within the final 2 hours of the working day (after 16:30), the 2-hour response clock carries over into the next morning (09:30 - 11:30). If "same working day" strictly meant 18:30 of the arrival day, a ticket submitted at 18:20 would have a 10-minute resolution SLA while having a 2-hour response SLA (a logical paradox). Therefore, our working definition is: Critical resolution is either by 18:30 of the arrival day, OR requires a minimum of 1 full working day (9 working hours) if submitted after a cutoff. *(Flagged as an Open Question below for stakeholder confirmation).*
- **Why:** An SLA where resolution deadline precedes response deadline, or where resolution must happen within 5 minutes of arrival, is physically impossible to meet and demoralizes agents.
- **Alternative I rejected, and why:** Pure 18:30 hard cutoff regardless of arrival time. Rejected because it guarantees immediate breach on any late-afternoon critical ticket.

## D3: Reopen window length
- **Question:** How long does a customer have to reopen a resolved ticket, and what happens when it expires?
- **My decision:** Default reopen window is exactly 5 working days (45 working hours) from the moment the ticket is marked `resolved`. During this window, any customer reply transitions the status back to `open` and issues a fresh resolution timer (with the original first-response clock remaining stopped and untouched). After 5 working days, the ticket transitions to `closed` permanently; any customer reply thereafter automatically spawns a new ticket linked via `linked_ticket_id` to the old ticket.
- **Why:** 5 working days mirrors one calendar week in business time, matching the phrasing "about one week" in the story notes.
- **Alternative I rejected, and why:** Using calendar days (7 days) instead of working days. Rejected because weekends or holidays would unfairly truncate customer reopen windows.

## D4: Ticket closed by silence
- **Question:** When does inactivity close a ticket waiting on customer, and can it be reopened?
- **My decision:** If a ticket remains in `waiting_customer` status for 5 consecutive working days (45 working hours) without customer activity, the system automatically transitions the ticket to `closed` and writes an audit event with actor `system`. Once `closed` by silence, the ticket cannot be reopened under any circumstances. Any future customer contact on that thread creates a new linked ticket.
- **Why:** Matches Meera's specification: "If a customer does not reply for about one working week, we close the ticket. They can always contact us again later."
- **Alternative I rejected, and why:** Allowing reopened status from `closed`. Rejected because the rules explicitly state tickets closed by silence must produce a new linked ticket, maintaining clean audit lines.

---

## Open Questions & Ambiguities Needing Clarification

### Q1: Breach Detection & Audit Logging Mechanism
- **Context:** Rule A5 specifies that when a deadline is missed, a `breach` event is written with a reason code (`unassigned` vs `no_action`).
- **Ambiguity:** What triggers this row creation if nobody interacts with the system at the exact minute of breach?
- **Options:**
  1. A background cron worker checks tickets periodically (e.g., every minute) and logs breach events.
  2. Compute lateness dynamically whenever a ticket is viewed/queried, and record audit breaches when the ticket state changes or via an scheduled evaluation job.
- **Recommendation:** Implement a background evaluation runner (or recurring job) to write real audit breach events promptly, plus on-demand lateness computation for API responses.

### Q2: Critical SLA Late-in-the-Day Cutoff
- **Context:** Critical response SLA is 2 working hours; resolution SLA is "end of the same working day (18:30)".
- **Ambiguity:** If a Critical ticket arrives at 17:30 Friday:
  - Is resolution deadline Friday 18:30 (1 hour allowed), even though first response is allowed until Monday 10:30 (2 working hours)?
- **Options:**
  - Option A: Strict 18:30 same day (leads to resolution deadline before response deadline).
  - Option B: Resolution SLA is defined as 1 working day (9 working hours) or 18:30 of the following working day if arrived after 09:30.
  - Option C: Resolution SLA is max(clock_start + 9 working hours, end of same day).
- **Recommendation:** Confirm if Critical resolution should be capped at 9 working hours (1 full working day) rather than fixed 18:30 of arrival day.

### Q3: Pausing Before First Response
- **Context:** An agent can move a ticket to "Waiting on customer" which pauses both clocks (W1).
- **Ambiguity:** Can an agent place a ticket into "Waiting on customer" without having sent a public reply first?
- **Risk:** Agents could game their first-response SLA by immediately setting tickets to "Waiting on customer" without actually helping the user.
- **Recommendation:** Enforce that "Waiting on customer" requires an accompanying public message, or can only be selected once a public message is being sent or has already been sent.

### Q4: Direct Ticket Reassignment & Queue Management
- **Context:** Rules state atomic claim (`C2`) and release back to queue (`C4`).
- **Ambiguity:** Can an agent reassign a ticket directly to another colleague, or must they always release it back to the unassigned pool? Can managers reassign tickets held by absent agents?
- **Recommendation:** Start with atomic claim and release back to queue (as stated in C2/C4); optionally allow supervisor reassignment if agent roles permit.

### Q5: Transition from Resolved to Closed
- **Context:** A customer has 5 working days to reopen a `resolved` ticket.
- **Ambiguity:** Does the ticket automatically move from `resolved` to `closed` after 5 working days of silence, or does it stay in `resolved` until a customer attempts to send a message?
- **Recommendation:** Automatically close tickets after 5 working days in `resolved` status via the same inactivity worker that closes `waiting_customer` tickets.
