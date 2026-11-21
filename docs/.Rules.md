# Frontdesk: Business Rules (Source of Truth)

I read the meeting notes with Meera and the three incident reports from Arvo Systems. I pulled out all the business rules and wrote them here in my own words.

Rule Status:
- **Stated:** Explicitly mentioned in Meera's meeting notes or the incident reports.
- **Decided:** The notes were silent or ambiguous, so I made an engineering decision (explained in `decisions.md`).

---

## 1. Working Time (Prefix T)

- **T1 (Stated):** Arvo's support team works Monday through Friday, from 09:30 to 18:30. That is 9 working hours (540 working minutes) each day.
- **T2 (Stated):** No work happens on festival holidays. Holidays cannot be hard-coded in the source code; they must live in an editable database table (`holidays`) with sample dates seeded.
- **T3 (Stated):** All deadlines and elapsed times are measured strictly in **working minutes**. Nights, weekends, and holidays add zero elapsed time.
- **T4 (Decided):** If a customer submits a ticket outside working hours (like Saturday morning or late at night), the clock starts ticking at the next working moment (e.g., Saturday 11:00 starts Monday at 09:30).
- **T5 (Stated):** A ticket is late only when its working-time deadline expires. A ticket arriving Friday at 18:00 has only used 30 minutes by Friday 18:30, so it must not be marked late on Sunday.

---

## 2. Severity and Deadlines (Prefix S)

- **S1 (Stated):** There are three severities:
  - **Critical:** The customer cannot work at all.
  - **Medium:** Standard operational issues.
  - **Low:** Inquiries, small questions, and minor requests.
- **S2 (Stated / Decided):** Every ticket has two separate timers: First Response and Resolution. The numbers below are configurable defaults:
  - **Critical:** First public response within 2 working hours. Resolved by end of the same working day (18:30).
  - **Medium:** First public response within half a working day (4.5 hours / 270 mins). Resolved within 3 working days (27 working hours).
  - **Low:** First public response within 1 working day (9 hours / 540 mins). Resolved within 5 working days (45 working hours).
- **S3 (Decided):** "Same working day" for Critical tickets means 18:30 on the day the clock started. A ticket arriving at 18:00 has 30 minutes remaining.
- **S4 (Decided):** The first response timer only stops when an agent posts a **public** reply. Internal notes do not count because the customer cannot see them.
- **S5 (Stated):** The resolution timer permanently stops the moment the ticket is marked Resolved.

---

## 3. Changing Severity Mid-Way (Prefix V)

- **V1 (Decided):** When an agent changes ticket severity, the ticket keeps the working time already spent. The new severity target applies to the whole ticket from its original start time.
- **V2 (Decided):** If the ticket is escalated to a stricter severity whose deadline has already elapsed, the ticket breaches immediately.
- **V3 (Decided):** Downgrading a ticket to a lower severity never erases or forgives a breach that was already recorded.
- **V4 (Stated by INC-0318):** Every severity change is recorded in the immutable audit log with who changed it, the old severity, the new severity, and the server timestamp.

---

## 4. Waiting on Customer (Prefix W)

- **W1 (Stated):** When an agent moves a ticket to "Waiting on customer", **both clocks pause**. As Meera said, waiting time is the customer's delay, not the agent's fault.
- **W2 (Stated):** When the customer replies, the clocks unpause and the ticket status automatically returns to Open.
- **W3 (Decided):** While waiting, the ticket displays a "Waiting" badge instead of a "Late" badge. Any breach that was already recorded before the pause stays recorded.
- **W4 (Stated):** If the customer remains silent for 5 working days (~one week), a background system job automatically closes the ticket and logs the actor as "system".

---

## 5. Lifecycle and Reopening (Prefix L)

- **L1 (Decided):** Allowed statuses are `new`, `open`, `waiting_customer`, `resolved`, and `closed`. Disallowed transitions are blocked by a strict state table.
- **L2 (Stated):** A customer can reopen a Resolved ticket within a 5 working days window (~one week) after resolution.
- **L3 (Stated):** After the 5-day window expires, a customer reply does not touch the old ticket. Instead, it creates a **new ticket linked to the old one**.
- **L4 (Decided):** A reopened ticket gets a fresh resolution clock. The first-response clock is not restarted. All previous history stays intact.
- **L5 (Decided):** Tickets closed by silence cannot be reopened. Any future message from that customer creates a new linked ticket.

---

## 6. Ownership and Claiming (Prefix C - INC-0291)

- **C1 (Stated):** A ticket can only have one owner at a time.
- **C2 (Stated):** Claiming a ticket ("Take this ticket") is an **atomic database statement** (`UPDATE tickets SET owner_agent_id = ... WHERE owner_agent_id IS NULL`). If two agents click at the same time, exactly one succeeds and the other gets an HTTP 409 Conflict error.
- **C3 (Decided):** Only the assigned owner can send a public reply. This prevents two agents giving conflicting answers to the same customer.
- **C4 (Decided):** An agent can release a ticket back to the unassigned queue. Claims and releases are audited.

---

## 7. Private Notes Must Never Leak (Prefix N - INC-0304)

- **N1 (Stated):** Every message is either `public` (customer visible) or `internal` (team only).
- **N2 (Stated):** Internal notes must never appear anywhere a customer can reach: not in UI, API responses, lists, search, exports, or errors.
- **N3 (Decided):** Enforced by architectural design: customer endpoints run separate queries strictly filtering `WHERE visibility = 'public'` and return a customer DTO shape that physically cannot contain internal notes.
- **N4 (Decided):** Customers access their ticket using a unique secret token URL (`/customer/tickets/:token`) showing the public thread and a reply box.

---

## 8. Append-Only Audit Log (Prefix A - INC-0318)

- **A1 (Stated):** Every event is stored as an immutable audit row: ticket ID, event type, who did it (agent, customer, or system), payload details, and timestamp.
- **A2 (Stated):** All timestamps come from the server clock (`NOW()`), never the client browser.
- **A3 (Stated):** The audit log is **append-only**. A PostgreSQL database trigger blocks any `UPDATE` or `DELETE` statements on `ticket_events`.
- **A4 (Stated):** Response times and SLA compliance can be mathematically proven from the audit log alone.
- **A5 (Decided):** When a deadline is missed, the system records a `breach` event with a reason code: `unassigned` (nobody owned it) or `no_action` (owned, but agent was inactive).
- **A6 (Decided):** A manager report endpoint (`/api/reports/breaches`) lists late tickets and explains why they were late.

---

## 9. Agent Screen (Prefix U)

- **U1 (Stated):** A single unified screen showing the agent's assigned tickets with clear **Late** and **Waiting** badges.
- **U2 (Decided):** Sorted by closest deadline first, displaying working time remaining.
- **U3 (Stated):** Opening a ticket shows the thread, a public reply box, and a visually distinct yellow "Team only" private note box.
- **U4 (Decided):** A shared Unassigned Queue allows agents to view incoming tickets and atomically claim them.

---

## 10. Deliberately Out of Scope

- Real email and WhatsApp delivery (simulated via customer portal).
- Complex auth and password reset (simple agent switcher among the 9 seeded agents).
- File attachments and external push notifications.
