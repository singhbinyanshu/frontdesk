# Frontdesk: Business Rules (Source of Truth)

> DRAFT. Rewrite every rule in your own words before you submit.
> Status key: **Stated** = the story says it. **Decided** = the story is silent or vague, so I chose it (the reason is in DECISIONS.md).
> If the code disagrees with this file, the code is wrong.

---

## 1. Working time (prefix T)

- **T1 (Stated):** The support team works Monday to Friday, 09:30 to 18:30. That is 9 working hours per day.
- **T2 (Stated):** No work on festival holidays. Holidays are stored as editable data (a `holidays` table), never hard-coded. Seed a few sample dates.
- **T3 (Stated):** Every deadline and every "how long has this taken" number is measured in **working minutes only**. Nights, weekends, and holidays count as zero.
- **T4 (Decided):** If a ticket arrives outside working time, its clocks start at the next working moment (for example, Saturday 11:00 becomes Monday 09:30).
- **T5 (Stated):** A ticket is **late** only when its deadline has passed in working time. A ticket that arrives Friday 18:00 must not be late on Sunday.

**Tests:** Friday 18:00 ticket is not late on Sunday. Saturday arrival starts Monday 09:30. A holiday is skipped. A ticket spanning a weekend counts only working minutes.

---

## 2. Severity and deadlines (prefix S)

- **S1 (Stated):** Three severities: **Critical** (customer cannot work at all), **Medium**, **Low** (questions and small requests).
- **S2 (Stated values, Decided numbers):** Each ticket has two separate clocks: first response and resolution. The numbers below are defaults and must be configurable, because the story says "about".

| Severity | First response within | Resolved within |
|---|---|---|
| Critical | 2 working hours | end of the same working day (18:30) |
| Medium | half a working day (4.5 h) | 3 working days |
| Low | 1 working day (9 h) | 5 working days |

- **S3 (Decided):** "Same working day" for Critical means by 18:30 on the working day the clock started. A ticket arriving at 18:00 has 30 minutes left. This is strict but matches the wording.
- **S4 (Decided):** **First response** means the first *public* reply by an agent. Internal notes never count as a response, because the customer never sees them.
- **S5 (Stated):** The resolution clock stops when the ticket is marked Resolved.

**Tests:** A Critical ticket created 10:00 has a response deadline of 12:00. A Medium ticket created Friday 16:00 gets its response deadline on Monday. An internal note does not stop the response clock.

---

## 3. Changing severity mid-way (prefix V). The unanswered question.

- **V1 (Decided):** When severity changes, the ticket keeps the working time it has already used. The new severity's targets apply to the whole ticket, measured from the original start.
- **V2 (Decided):** If the new (stricter) target has already passed, the ticket becomes late immediately.
- **V3 (Decided):** A downgrade never erases a breach that was already recorded.
- **V4 (Stated by INC-0318):** Every severity change is written to the audit log with who changed it, the old value, and the new value.

**Tests:** Medium ticket, 6 working hours old, changed to Critical becomes late immediately. A recorded breach survives a downgrade.

---

## 4. Waiting on the customer (prefix W)

- **W1 (Stated):** When an agent sets the ticket to "Waiting on customer", **both clocks pause**. Waiting time is not the agent's fault.
- **W2 (Stated, implied):** When the customer replies, the clocks resume and the status returns to Open.
- **W3 (Decided):** A waiting ticket is shown as "Waiting", not "Late". A breach that was already recorded before the pause stays recorded.
- **W4 (Stated):** If the customer is silent for 5 working days (configurable) while waiting, the system closes the ticket. The actor in the audit log is "system".

**Tests:** A 3-day wait adds nothing to elapsed working time. A reply resumes the clock. A ticket waiting 5 working days is closed automatically.

---

## 5. Lifecycle and reopening (prefix L)

- **L1 (Decided):** Statuses: `new`, `open`, `waiting_customer`, `resolved`, `closed`. Allowed moves are listed in code as one table, and any other move is rejected.
- **L2 (Stated):** A customer can reopen a **Resolved** ticket for a limited window, default 5 working days after it was resolved (configurable).
- **L3 (Stated):** After the window, a customer message creates a **new ticket linked to the old one**. The old ticket is not changed.
- **L4 (Decided):** A reopened ticket gets a fresh resolution clock. The first-response clock is not restarted. The earlier history stays.
- **L5 (Decided):** A ticket closed by silence cannot be reopened. A later customer message creates a new linked ticket ("they can contact us again").

**Tests:** Reopen on day 4 works. Reopen on day 6 creates a new linked ticket. Closed ticket stays closed.

---

## 6. Ownership and claiming (prefix C). From INC-0291.

- **C1 (Stated):** A ticket has at most one owner at a time.
- **C2 (Stated):** "Take this ticket" is **atomic**: it is one database statement (`UPDATE ... WHERE owner IS NULL`). If two agents click together, exactly one wins. The other gets a clear 409 "already taken" message.
- **C3 (Decided):** Only the current owner can send a public reply. This prevents two agents answering the same customer.
- **C4 (Decided):** An owner can release a ticket back to the queue. Every claim and release is audited.

**Tests:** Fire 10 simultaneous claims. Exactly 1 succeeds. A non-owner reply is rejected.

---

## 7. Private notes must never leak (prefix N). From INC-0304.

- **N1 (Stated):** Every message is either `public` or `internal`.
- **N2 (Stated):** Internal notes never appear in anything a customer can reach: not on a screen, not in an API response, not in a list, not in a search, not in a count, not in an export, not in an error message.
- **N3 (Decided):** This is enforced by design, not by remembering to filter. Customer-facing code uses a separate query and a separate response shape that **cannot** return internal notes.
- **N4 (Decided):** The customer gets a simple read-only view through a secret link (token) that shows the public thread and status, plus a reply box. This is how the customer side is demonstrated.

**Tests:** Create an internal note, then call every customer-facing endpoint and export. Assert the note text appears nowhere in any response.

---

## 8. Audit log (prefix A). From INC-0318.

- **A1 (Stated):** Every important event is recorded as a row: what happened, when, who did it (agent, customer, or system), and the details.
- **A2 (Stated):** Timestamps come from the server clock, never from the browser.
- **A3 (Stated):** The audit log is **append-only**. The database blocks UPDATE and DELETE on it (trigger or permissions). Corrections are new rows.
- **A4 (Stated):** The first-response time of any ticket can be proven from the log alone.
- **A5 (Decided):** When a deadline is missed, a `breach` event is written with a reason code: `unassigned` (nobody owned the ticket), or `no_action` (owned, but no reply in time).
- **A6 (Decided):** A manager report lists late tickets with their breach reasons, which answers "which were late, and why".

**Tests:** Trying to UPDATE or DELETE an audit row fails. A breach row exists with a reason code.

---

## 9. Agent screen (prefix U)

- **U1 (Stated):** One screen shows the agent's own tickets, with a clear **Late** badge and a **Waiting** badge.
- **U2 (Decided):** Sort by closest deadline first. Show working time remaining.
- **U3 (Stated):** Opening a ticket shows the thread, a public reply box, and an internal note box that looks clearly different (for example, a yellow background labelled "Team only").
- **U4 (Decided):** A shared "unassigned" queue lets agents claim tickets.

---

## 10. Deliberately out of scope (write these in the final note)

- Real email or WhatsApp delivery
- Full user management and password reset (seeded agents with a simple login)
- Notifications and attachments
- Anything not listed above