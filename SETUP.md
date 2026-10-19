# UIU Academic Toolkit setup

The toolkit still works as a static site. The admin dashboard, shared routine publishing, and visitor analytics require a Supabase project.

## Connect Supabase

1. Create a Supabase project and open its **SQL Editor**.
2. Run the complete contents of `supabase-setup.sql` once.
3. In **Authentication → Providers**, enable **Anonymous sign-ins**. Anonymous sessions let the site count active visitors without asking students to create accounts.
4. In **Authentication → Users**, create and confirm the administrator account with the email `mainuddinshakib05@gmail.com`. Do not add a public sign-up form. Its password is stored and verified by Supabase Auth; never put it in website code.
5. The SQL setup authorizes that exact authenticated email as an administrator. Other administrators, if needed, must be added to `public.uiu_admins` by their Auth user UUID.
6. In **Project Settings → API**, copy the project URL and its publishable key (or legacy `anon` key) into `supabase-config.js`. These are browser-public values; **never put a `service_role` or secret key in this file**.
7. Deploy `index.html`, `routine-backend.js`, `supabase-config.js`, and the PDF.js dependency together. Supabase's private `uiu-routine-pdfs` bucket is created by the SQL setup.
8. Open **Admin** in the navigation and sign in with the email and password set for that account in Supabase Auth.

The login form does not create or store administrator credentials. If Supabase reports **Invalid login credentials**, the email/password combination is not recognized by Auth in this project; create or reset that user's password in **Authentication → Users**. The admin dashboard remains hidden until the database setup has been run and Supabase confirms the authenticated account is authorized. Analytics (active visitors, visits today, and most-visited pages) also require anonymous sign-ins to be enabled.

## Publish a semester routine

In the admin dashboard, enter the semester name and upload the official text-based routine PDF. The browser extracts course meetings and shows a review preview before enabling **Publish routine**. Publishing stores the PDF privately and atomically replaces the current semester release; if upload or publishing fails, the previous release stays current. Student pages check for a new release once per minute and clear old course picks when the semester changes.

The student planner exposes course names and the faculty teaching each course. Class times and meeting days are sent only for the course/faculty combinations a student actually selects. The full PDF remains in a private bucket and is only available to administrators. Students add the subjects they need and select a preferred faculty for each. Routine generation checks all meetings across every selected section so it never returns an overlapping combination, then shows up to the seven best schedule options automatically.

The automatic PDF reader needs selectable text and recognizable course codes, faculty names, meeting days, and time ranges; image-only scans are not recognized. Confirm the preview matches the official schedule before publishing. Routine PDFs can use different table layouts, and a real semester PDF has not yet been provided to validate this parser against UIU's exact format. If rows are missing or incorrect, do not publish that preview; a text-based export with one complete class meeting per row may be needed.

## Visitor analytics and privacy

The administrator dashboard shows visitors active in the last 90 seconds, today's visits, the most visited toolkit pages over the last seven days, and current active page counts. A heartbeat updates the active count every 30 seconds. Analytics records page names and a random anonymous Supabase account ID only; it does not request students' names or record IP-based location. Individual visit events are automatically removed after 90 days.

Create and remove administrators in the Supabase Auth dashboard and the `public.uiu_admins` table. Never share an administrator password, JWT secret, or service-role key in website code.
