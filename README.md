# Frontdesk — Arvo Systems Support Platform

Frontdesk is a specialized support ticket management platform built to replace Arvo Systems' legacy shared spreadsheet and WhatsApp group. It strictly enforces business hours, SLA timers, concurrent ticket claiming, private note leak prevention, and immutable audit logging.

Built as a submission for the Full Stack Developer hiring evaluation (specifications in `docs/00-original-test.pdf`).

---

## Tech Stack

- **Backend:** Node.js (v20+), Express.js (v5)
- **Database:** PostgreSQL (with connection pooling via `pg`, native constraints, and an append-only trigger)
- **Frontend:** Plain React (v19) powered by Vite (clean CSS, responsive, zero heavy component libraries)
- **Testing:** Vitest (comprehensive unit & integration test suite mapped directly to business rule IDs)

---

## Key Business Rules & Architectural Highlights

1. **Business Hours Engine (Rules T1–T5):**
   - Operating hours: Monday–Friday, 09:30 to 18:30 (9 working hours / 540 working minutes per day).
   - Nights, weekends, and festival holidays (stored in an editable database table) count as zero elapsed minutes.
   - Off-hours arrivals advance to the next working moment (e.g. Saturday 11:00 starts Monday 09:30).
2. **SLA Deadlines & Severity Management (Rules S1–S5, V1–V3):**
   - **Critical:** First public reply within 2 working hours; resolution by end of same working day (18:30).
   - **Medium:** First public reply within 4.5 working hours; resolution within 3 working days (27 working hours).
   - **Low:** First public reply within 9 working hours; resolution within 5 working days (45 working hours).
   - Retrospective escalation: escalating a ticket applies targets from the original creation time; if already elapsed, the ticket breaches immediately.
3. **Customer Pause & Auto-Close (Rules W1–W4):**
   - Marking a ticket as "Waiting on customer" freezes both SLA clocks.
   - Resumes automatically when the customer replies.
   - If silent for 5 working days, an automated job closes the ticket with actor `system`.
4. **Lifecycle & Reopen Window (Rules L1–L5):**
   - Strictly enforced state machine (`new`, `open`, `waiting_customer`, `resolved`, `closed`).
   - Customer can reopen a resolved ticket within 5 working days (grants a fresh resolution clock).
   - Customer messages sent after 5 working days (or on closed tickets) create a new linked ticket (`linked_ticket_id`).
5. **Concurrency & Atomic Claiming (Incident INC-0291, Rules C1–C2):**
   - "Take this ticket" runs as an atomic SQL statement (`UPDATE tickets ... WHERE owner_agent_id IS NULL`).
   - If multiple agents click simultaneously, exactly one succeeds; all others receive HTTP 409 Conflict.
6. **Leak Prevention by Architecture (Incident INC-0304, Rules N1–N4):**
   - Customer-facing queries strictly filter `WHERE visibility = 'public'` and return a customer DTO shape that physically cannot contain internal team notes.
7. **Tamper-Proof Audit Trail (Incident INC-0318, Rules A1–A6):**
   - Every action logs an immutable event with server clock (`NOW()`).
   - A PostgreSQL trigger raises an exception on any attempted `UPDATE` or `DELETE` on `ticket_events`.
   - Manager report (`/api/reports/breaches`) lists late tickets and explains why (`unassigned` vs `no_action`).

---

## Local Setup & Development

### Prerequisites
- Node.js (v20+)
- npm
- PostgreSQL database (or use the configured cloud Supabase instance)

### 1. Clone & Install
```bash
git clone <your-repo-link>
cd frontdesk
npm run build
```

### 2. Configure Environment Variables
Create a file at `backend/.env` with your database URL:
```env
DATABASE_URL=postgresql://postgres:<password>@<host>:5432/postgres
PORT=5000
```

### 3. Run Migrations & Seed Data
```bash
node backend/src/db/migrate.js
```

### 4. Run Locally

**Start Backend:**
```bash
node backend/src/server.js
# Or with auto-reload: npm run dev --prefix backend
```

**Start Frontend Dev Server:**
```bash
cd frontend
npm run dev
```
Open **`http://localhost:3000`** in your browser.

*(Alternatively, the backend on port 5000 also serves the built frontend statically at `http://127.0.0.1:5000`).*

---

## Automated Test Suite

Run the full automated test suite (34 tests) validating all business rules:
```bash
npm test
```

Test coverage includes:
- `workingTime.test.js` (Rules T1–T5): full workday calculation, weekend skipping, festival holidays, next working moment, lateness logic.
- `sla.test.js` (Rules S1–S5, W1–W3, V1–V3): separate clocks, same-day critical resolution, customer pause/resume, retrospective severity escalation, breach preservation.
- `api.test.js` (Rules C1–C4, A1–A6, N1–N4, L1–L5, W4): atomic claim concurrency race (10 simultaneous claims), trigger immutability, leak prevention, customer portal, auto-close worker, breach detection reason codes, manager report.

---

## Deployment (One-Click / Cloud Hosting)

This project is configured for single-service deployment on **Render**, **Railway**, or **Fly.io**:

### Deploying to Render
1. Push your repository to GitHub.
2. Sign in to [Render](https://render.com) and click **New + > Web Service**.
3. Select your GitHub repository.
4. Configure settings:
   - **Environment:** Node
   - **Build Command:** `npm run build`
   - **Start Command:** `npm start`
5. Add Environment Variable:
   - `DATABASE_URL`: Your PostgreSQL connection string.
6. Click **Deploy Web Service**.

Your live URL will be available at `https://frontdesk-xxxx.onrender.com`.

---

## Section 5 Note: What did you not finish, and why?

> *"A short note answering one question: what did you not finish, and why? Running out of time is normal. Not knowing what you skipped is not."* (Section 5, `00-original-test.pdf`)

In keeping with the project brief's guideline to deliver **"8 honest hours over a full weekend of extra polish"**, I focused 100% of my time on the core business logic, strict SLA calculations, data integrity, and solving the three historical incidents:

### What I completed:
- Core working time engine handling 9:30–18:30 business hours, holidays, and off-hour arrivals.
- SLA calculations for Critical, Medium, and Low severities.
- Pause and resume logic for customer waiting with 5-day auto-close.
- Retrospective severity escalation with immediate breach detection and breach preservation.
- Atomic conditional claiming preventing duplicate ownership (INC-0291).
- Architectural leak prevention guaranteeing internal notes never reach customer views (INC-0304).
- Database-level trigger guaranteeing an append-only audit trail (INC-0318).
- Manager breach reporting endpoint.
- Responsive React agent dashboard with distinct yellow "Team only" notes, unassigned queue, and SLA badges.
- 34 automated unit and integration tests passing against live PostgreSQL.

### What I skipped, and why:
1. **Real Email & WhatsApp Delivery:**
   - *Why:* Setting up external third-party communication services (Twilio / SendGrid) introduces external dependencies, API credentials, and billing complexity without adding value to the core business logic.
   - *Alternative implemented:* Built a dedicated tokenized customer portal (`/api/customer/tickets/:token`) demonstrating the public message flow and customer replies cleanly.
2. **Complex User Authentication & Password Reset:**
   - *Why:* Building a full IAM system (OAuth, password reset tokens, MFA) was outside the core scope of the problem.
   - *Alternative implemented:* Seeded the 9 Arvo support agents directly in the database with a fast agent switcher in the UI to easily test multi-agent interactions and ownership permissions.
3. **File Attachments & Rich Text Editors:**
   - *Why:* File storage (S3 buckets / multipart upload handling) was secondary to ensuring private notes never leak and claims remain atomic.
   - *Alternative implemented:* Plain-text public replies and team notes with strict database visibility separation.
