# Growth Squad Team Work Log: admin README

This is the reference for whoever looks after the tool. It covers how the tool is built, where each part lives, how to ship an update, the free-plan limits, and what to check when something breaks.

Last updated: 6 Nov 2026. Owner: mostapha@mygrowthsquad.com.

---

## 1. What the tool is

A web app for the whole company. People sign in with their @mygrowthsquad.com Google account, then:

- start and end their day
- plan their tasks and track time on them
- log work they finished
- request leave

Team leads assign tasks and follow their team. Admins see everything, including attendance.

It has no server of its own. It is one HTML file that talks straight to Google Firebase, plus a Google Apps Script that sends the emails.

## 2. Architecture

```
 People's browsers
 (www.mygrowthsquad.com/gs-team, or the GitHub Pages copy)
        │  index.html: the whole app (HTML + CSS + JavaScript in one file)
        │
        │  Firebase Web SDK 10.12.2 (loaded from gstatic.com)
        ▼
 ┌──────────────────────── Firebase project "growthsquad-team-log" ───────────────────────┐
 │  Authentication: Google sign-in, limited to @mygrowthsquad.com (+ allowed extra emails) │
 │  Cloud Firestore (eur3, Europe): all data                                              │
 │  Security rules: who can read and write what (firestore.rules)                         │
 └────────────────────────────────────────────────────────────────────────────────────────┘
        ▲
        │  Firestore REST API, every minute, as the script owner
        │
 Google Apps Script "Team Log email notifications" (on mostapha@mygrowthsquad.com)
        │  MailApp → sends from that account
        ▼
 Email to team members, leads and admins
```

| Part | What it does | Where |
|---|---|---|
| `index.html` | The app. Every page, the styles, the logic. | Domain: www.mygrowthsquad.com/gs-team (website team uploads it). Copy: https://moustapharabea.github.io/team-log/ |
| `config.js` | Firebase web keys, allowed domain, owner email. In the domain version it is inlined into `index.html`. | GitHub repo `MoustaphaRabea/team-log` |
| Firebase Authentication | Google sign-in. Only `@mygrowthsquad.com`, plus emails an admin allows in Settings → Access. | console.firebase.google.com → growthsquad-team-log → Authentication |
| Cloud Firestore | The database (see section 5). Location eur3 (Europe). | Firebase console → Firestore |
| Security rules | Enforce roles and team limits on the database itself. | `firestore.rules` → Firebase console → Firestore → Rules → Publish |
| Apps Script notifier | Reads Firestore every minute and sends emails. | script.google.com → "Team Log email notifications", code = `notifier-Code.gs` |

The Firebase web keys in `config.js` are public by design. They identify the project; they don't grant access. Access is controlled by sign-in and the security rules.

## 3. Accounts and places

| What | Value |
|---|---|
| Firebase project ID | `growthsquad-team-log` |
| Firebase plan | Spark (free) |
| Firebase owner | mostapha@mygrowthsquad.com. In the console it is the second signed-in Google account, so URLs use `/u/1/`. |
| Firestore location | eur3 (multi-region Europe). This can't be changed later. |
| Authorized sign-in domains | localhost, the firebaseapp.com / web.app defaults, moustapharabea.github.io, team.mygrowthsquad.com, mygrowthsquad.com (this covers www) |
| Apps Script project | "Team Log email notifications", owned by mostapha@mygrowthsquad.com |
| Apps Script time zone | Africa/Cairo |
| App link used in emails | `APP_URL = 'https://www.mygrowthsquad.com/gs-team'` (top of `notifier-Code.gs`) |
| Source copies | claude.ai Project "Growth squad dashboards" → `team-log/` (latest files and these notes). GitHub repo `MoustaphaRabea/team-log`. |

Moving the app to a new web address means adding that host under Firebase → Authentication → Settings → Authorized domains. Otherwise Google sign-in fails there. Also update `APP_URL` in the script.

## 4. Roles

| Role | How someone gets it | Can do |
|---|---|---|
| Member | Default for everyone who signs in | Own day, plan, tasks, time and leave. Create tasks for themselves or for anyone in the company. See and comment on their team's tasks. |
| Lead | Admin sets Role = Lead and a team in Settings → Teams & people | Everything a member can, plus manage their team: assign, edit, approve leave, reports, people pages, team types of work and brands. Can't approve their own leave. |
| Admin | Hard-coded owner (`ADMIN_EMAILS` in rules, `owners` in config), or Role = Admin | Everything, for every team. Also Attendance, teams and roles, working hours, holidays and access. |

## 5. Data model (Firestore)

| Collection | One document per | Main fields |
|---|---|---|
| `people/{uid}` | Person (created at first sign-in) | name, email, photo, team, role, annualLeave |
| `teams/{id}` | Team | name, kinds[{name, unit, target}] (types of work) |
| `logs/{uid}` | Person's live status | state (working/break/off), since, dayKey |
| `logs/{uid}/days/{YYYY-MM-DD}` | Person × day | sessions[{in, out, breaks[], manual, edit}], tasks[] (logged work: text, brand, kind, mins, qty, unit, asg) |
| `logs/{uid}/reviews/{day__session}` | A time change marked "Got it" | status (seen, or approved/rejected on older entries), by, at |
| `assignments/{id}` | Task | title, assignee, team, createdBy, brand, kind, due, priority, status, notes, links[], estimate (min), watchers[] (tagged uids), planFor, planDays[], workMs, workDays{day: ms}, runSince, selfMade, lastComment, and email bookkeeping fields (notifiedAt, doneNotifiedAt, commentNotifiedAt, estNotifiedAt, remindedFor, overdueFor) |
| `assignments/{id}/comments/{id}` | Comment | uid, text, at, mentions[] |
| `recurring/{id}` | Repeating task | same as a task + repeat (daily / w0–w6). A copy is made each matching day as `assignments/{rid}__{date}`. |
| `templates/{id}` | Saved task template | name, task fields, dueIn, who[], team |
| `changes/{id}` | Time changed by hand | uid, team, day, text, reason, at, notifiedAt |
| `leaves/{id}` | Leave request | uid, team, from, to, type, note, status |
| `roster/{uid}` | Brands a person covers | brands[] |
| `settings/team` | Company settings | start, grace, target, annualLeave, weekend[], holidays[] |
| `settings/brands` | Brand list | list[] |
| `members/{email}` | Extra allowed email | addedBy, addedAt |
| `admins/{email}` | Extra admin (console only) | — |

The app loads the last 70 days of day logs (`HISTORY_DAYS`). Older data stays in the database.

## 6. Security rules: the key points

The file is `firestore.rules`. It is the real security of the tool. Hiding something in the app is not enough: these rules are what stop people opening data they shouldn't see.

- Sign-in is required, with a verified email. A member is anyone with an @mygrowthsquad.com address, or an email listed in `members`.
- **People** can edit only their own name and photo. Only admins change team, role or leave days.
- **Day logs** (`logs/…`): a person writes only their own. They can be read by that person, their team's lead and admins.
- **Tasks** can be seen by:
    - their assignee
    - the person who created them
    - anyone in the same team
    - anyone tagged on them
    - admins

  They can be changed:
    - by the assignee: status, time, plan, estimate and comments only
    - by whoever created them: anything
    - by the team lead
    - by anyone who can see them: comments and tags only
- **Leave:** members request, and leads or admins decide. A lead can't decide their own leave.
- **Attendance** data is the same day logs. The app shows late/absent only to admins. Leads can read team day logs, which is how they see hours.
- Anything not listed is denied.

To change the rules, edit `firestore.rules`, then go to the Firebase console → Firestore → Rules, paste it and press **Publish**. The console checks the syntax before it publishes.

## 7. Email notifier (Apps Script)

It runs `checkNewTasks` every minute through a time trigger. Each run reads recent changes from Firestore over REST, as the script owner, and sends what's needed with MailApp. Emails come from mostapha@mygrowthsquad.com.

| Email | To | When |
|---|---|---|
| New / moved task | Assignee | Task created or moved to them (not for tasks you give yourself) |
| Tagged | Tagged people | They are tagged on a new task |
| Task done | Whoever created it | Marked Done |
| New comment / mentioned you | Everyone on the task except the writer: assignee, creator, tagged people, earlier commenters, @mentioned people | 2 minutes after the last comment in a burst |
| Expected time changed | Assignee + creator (one email) | Assignee changes an estimate someone else set |
| Time change | Person's lead (admins if no lead) | Someone fixes their start or end time, or adds time by hand |
| Due soon / Overdue | Assignee (+ creator for overdue) | Once a day after 9:00 on workdays |
| Weekly summary | Person, lead in cc | First workday of the week after 9:00, for the week before (Sat–Fri) |

Functions you can run from the editor (pick one in the dropdown, then press Run):

| Function | Use |
|---|---|
| `setup` | Creates the every-minute trigger and does a first check. Run it after pasting new code. |
| `stop` | Removes the trigger, which stops all emails. |
| `sendDailyNow` | Sends today's due-soon and overdue emails now. |
| `sendWeeklyNow` | Sends last week's summaries now. |

Script properties (Project Settings → Script properties) are bookkeeping. Leave them alone unless you are fixing something:

- `from`: when the current email logic started. Nothing older than this is emailed.
- `last`: time of the last run.
- `daily`: last day the daily emails went out.
- `weekly`: last week the weekly emails went out.
- `noOr`: set if Firestore refused OR queries.

To update the script, open the project, select all in `Code.gs`, paste the new `notifier-Code.gs`, save, then run `setup` once. Permission scopes are in `appsscript.json` (Firestore, external requests, send mail, triggers). If a new version needs a new scope, Google asks the owner to approve it once.

## 8. Shipping an update

1. Edit the source `index.html`, which loads `config.js`.
2. If data access changed, publish the new `firestore.rules` **first**. Otherwise new features get "permission denied".
3. Upload `index.html` to GitHub (`MoustaphaRabea/team-log`, branch main, "Add file → Upload files"). GitHub Pages rebuilds in 1–2 minutes. Test there first.
4. Build the single-file version by putting the contents of `config.js` inline in place of `<script src="config.js">`. Send it to the website team to replace the file at `/gs-team`.
5. If the email logic changed, paste the new `notifier-Code.gs` into Apps Script, save, and run `setup`.
6. Save the latest files in the claude.ai Project under `team-log/`.

## 9. Limits and scaling

### Free (Spark) limits that matter

| Service | Free limit | What happens at the limit |
|---|---|---|
| Firestore document reads | 50,000 / day | Firestore stops answering until the daily reset, so the app stops loading data |
| Firestore document writes | 20,000 / day | Same, for saving |
| Firestore deletes | 20,000 / day | Same |
| Firestore stored data | 1 GiB | Over this needs Blaze |
| Firestore outbound data | 10 GiB / month | Over this needs Blaze |
| Firebase Authentication (Google sign-in) | No charge for social sign-in | — |
| Apps Script email recipients | 1,500 / day (Workspace account) | Emails fail for the rest of the day |
| Apps Script trigger runtime | 6 hours / day (Workspace account) | Trigger stops for the rest of the day |
| Apps Script URL fetches | 100,000 / day (Workspace account) | Script calls to Firestore fail |

Every query is charged at least one read, even if it finds nothing.

### Current usage (checked 6 Nov 2026)

- **Firestore:** 140 reads and 0 writes so far today. That is 0.3% of the daily read limit, with only a few people using the tool so far.
- **Apps Script:** the trigger runs every minute and takes about 3–6 seconds per run. That is roughly 1.5–2 hours a day of the 6-hour limit.

### What drives cost as the company grows

- **Reads on each page load.** Each person loads:
    - the people list
    - teams
    - settings
    - their team's tasks
    - their own last 70 days

  Leads also load their team's 70 days, and admins load everyone's. A rough guide is 150–400 reads per member page load and 1,000–2,500 per admin page load at 25–30 people.
- **Task history.** Team tasks are loaded with no date limit, so the number of reads per load grows as tasks pile up over months.
- **Live updates.** Each change re-reads only the changed documents, which is cheap.

**Estimate for 25–30 daily users:** about 25,000–45,000 reads a day. That is close to the free 50,000. Writes, storage and emails stay well within the free limits.

### Recommendations

1. **Upgrade to Blaze (pay as you go) before rolling out to every team, and set a budget alert at $5/month.** On Blaze the free daily amounts still apply, and you only pay above them. Reads cost about $0.03 per 100,000, so going over the free amount would cost cents a month. The main benefit is that the tool won't stop mid-day if a busy day passes the free limit. The upgrade needs a billing account linked to the Firebase project.
2. **When task history grows** (a few thousand tasks), change the app to load only open tasks plus tasks finished in the last 60 days. This needs one composite index in Firestore.
3. **If Apps Script runtime ever gets tight,** change the trigger from every 1 minute to every 5 minutes in `setup`. Emails would then arrive within about 5 minutes instead of 1.
4. **Firestore location is fixed** (eur3). It is fine for Egypt and the GCC.

Pricing references:
- [Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)
- [Firestore pricing](https://cloud.google.com/firestore/pricing). Check the eur3 rate there; multi-region prices can differ.
- [Apps Script quotas](https://developers.google.com/apps-script/quotas)

## 10. Troubleshooting

| Problem | Check |
|---|---|
| Google sign-in fails on a new address | Add the host under Firebase → Authentication → Settings → Authorized domains. |
| "You don't have access" for someone | They must use their @mygrowthsquad.com account, or an admin adds their email in Settings → Access. |
| "Permission denied" after an update | The new `firestore.rules` wasn't published, or hasn't taken effect yet (wait a minute and reload). |
| Someone didn't get an email | Check **who** that email goes to (section 7). Comment emails go only to people on the task: the assignee, the creator, tagged people, earlier commenters and anyone @mentioned. A comment on a task you made for yourself, with nobody tagged, emails no one. Then check Apps Script → Executions for failed runs, and the person's spam folder. |
| No emails at all | Apps Script → Triggers: there should be one `checkNewTasks` trigger, every minute. If not, run `setup`. |
| Weekly email didn't arrive | It goes out after 9:00 on the first workday of the week. On the very first run it only sets itself up, and the first email goes the next week. Run `sendWeeklyNow` to test. |
| A lead sees nothing | They need both Role = Lead and a team, in Settings → Teams & people (then press Save changes). |
| Settings change "didn't work" | Working hours and Teams & people now wait for **Save changes**. Leaving the page asks before throwing away unsaved changes. |
| The app stopped loading data mid-day | Probably the daily free read limit (section 9). It comes back after the daily reset, or right away on Blaze. |
