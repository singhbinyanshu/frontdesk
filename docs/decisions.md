# Decisions

Each time the story was silent or unclear, I decided and wrote it here.

## D1: Severity change mid-way
- **Question:** What happens to the timer if a ticket becomes urgent in the middle?
- **My decision:** I decided that the ticket keeps the working time it has already used. The new severity's target applies from the original ticket creation time. If the elapsed working time has already passed the new severity's limit, the ticket breaches immediately. Any breach already recorded stays permanent and is never revoked by a later downgrade. If a first response was already sent, only the resolution SLA is recalculated.
- **Why:** In support teams, resetting the clock on escalation would allow agents to "game" the system (e.g. letting a ticket sit for 4 hours and then changing severity to reset the timer). Applying the new target from the original start ensures honest reporting to clients.
- **Alternative I rejected, and why:** I rejected resetting the clock to zero upon severity change, because that hides delays and misrepresents our response time to customers. I also rejected pro-rating elapsed percentages because it is confusing for agents to understand and impossible to verify simply in audit logs.

## D2: "Same working day" for Critical tickets
- **Question:** How does "same working day" work if a Critical ticket arrives late in the shift?
- **My decision:** For Critical tickets arriving during working hours, the resolution deadline is 18:30 on that same working day. However, if a ticket arrives in the final 2 hours of the day (e.g. 18:00), the 2-hour response clock carries over into the next morning (09:30 - 11:00). To avoid the logical paradox where resolution is due before first response, my code ensures that if a ticket arrives after 16:30, resolution is set to end of next working day (or capped at 1 full working day of 9 hours).
- **Why:** If a customer submits a Critical ticket at 18:25, giving the team only 5 minutes to resolve an entire work stoppage while giving 2 hours to reply is physically impossible and sets agents up to fail.
- **Alternative I rejected, and why:** A rigid 18:30 cutoff regardless of arrival time. I rejected this because any ticket arriving at 18:15 would instantly breach within 15 minutes.

## D3: Reopen window length
- **Question:** How long can a customer reopen a resolved ticket, and what happens when it expires?
- **My decision:** I set the reopen window to exactly 5 working days (45 working hours) from the moment the ticket is marked `resolved`. If the customer replies within those 5 working days, the ticket reopens to `open` and receives a fresh resolution timer (the original first-response timer remains stopped). If the customer messages after 5 working days, the old ticket stays resolved and the system automatically creates a brand new ticket linked to the old one (`linked_ticket_id`).
- **Why:** Meera said "for about one week". Since Arvo operates on a 5-day working week, 5 working days cleanly represents one full business week without penalizing customers for weekends or festival holidays.
- **Alternative I rejected, and why:** Using 7 calendar days. I rejected calendar days because long holiday weekends (like festival holidays) would eat into the customer's reopen window unfairly.

## D4: Ticket closed by silence
- **Question:** When should an inactive waiting ticket be closed, and can it be reopened?
- **My decision:** If a ticket sits in `waiting_customer` for 5 consecutive working days (45 working hours) without a customer reply, our background job automatically transitions the ticket to `closed` with the actor set to `system`. Once closed by silence, the ticket is permanently closed and cannot be reopened. Any future customer message creates a new linked ticket.
- **Why:** Meera explicitly requested: *"If a customer does not reply for about one working week, we close the ticket. They can always contact us again later."* Creating a new linked ticket keeps the old history clean.
- **Alternative I rejected, and why:** Allowing customers to reopen tickets closed by silence. I rejected this because after a week of silence, the customer's problem or environment has often changed, so starting a fresh linked ticket gives agents a clean slate.

## D5: First response definition & private notes
- **Question:** What counts as a "first response", and who can send it?
- **My decision:** I decided that only an agent's **public** message counts as a first response. Internal team notes never count. Furthermore, to prevent incident INC-0291, only the assigned owner of the ticket can send a public reply.
- **Why:** Internal notes are never seen by the customer. If an internal note stopped the clock, an agent could type "looking into it" internally and let the customer wait for days without penalty. Restricting public replies to the owner prevents two agents from sending conflicting answers.
- **Alternative I rejected, and why:** Allowing any agent to reply publicly without claiming. Rejected because INC-0291 proved that multiple agents replying creates confusion for the customer.

## D6: Audit log immutability
- **Question:** How do we guarantee the audit log can never be tampered with?
- **My decision:** I implemented an append-only `ticket_events` table protected by a native PostgreSQL database trigger that raises an exception on any `UPDATE` or `DELETE` query.
- **Why:** INC-0318 showed that disputes arise when neither side can prove when an event happened. Enforcing immutability in the database engine means even application bugs or compromised credentials cannot rewrite history.
- **Alternative I rejected, and why:** Relying solely on application code not to run update/delete queries. Rejected because bugs or future code changes could accidentally modify audit rows.
