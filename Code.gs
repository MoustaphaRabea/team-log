/**
 * Growth Squad Team Log — task emails.
 *
 * Runs every minute (set up by running `setup` once) and sends:
 *  - New task:     to the person a task is assigned (or moved) to.
 *  - Tagged:       to people tagged on a new task (they can follow it)
 *  - Comments:     to everyone on a task's thread (assignee, creator, tagged people,
 *                  earlier commenters, anyone @mentioned) except the person who wrote it
 *                  (waits ~2 minutes so a burst of comments arrives as one email).
 *  - Task done:    to the person who assigned it.
 *  - Due soon:     once a day after 9:00, to each person with tasks due today or
 *                  before the next workday (one email listing them all).
 *  - Overdue:      once a day after 9:00, to the person and to whoever assigned it.
 *  - Expected time: when someone changes the expected time their lead set on a task,
 *                  one email to them and to whoever assigned it.
 *  - Time changes: when someone fixes their start/end of day or adds time by hand,
 *                  to their team lead (or the admins if they have none).
 *  - Weekly:       on the first workday of each week after 9:00, each person's summary
 *                  of the week before (time by task type, estimates, plans), to them
 *                  with their lead in cc.
 * Repeating tasks are emailed once, when they're first set up; their daily copies
 * don't send reminders, overdue or done emails.
 *
 * Runs as the account that owns this script, which must be an owner/editor
 * of the Firebase project below.
 */
const PROJECT_ID = 'growthsquad-team-log';
const APP_URL = 'https://www.mygrowthsquad.com/gs-team';
const SENDER_NAME = 'Growth Squad Team Log';
const OVERLAP_MIN = 15;        // each run re-checks this many minutes back
const COMMENT_WAIT_MIN = 2;    // wait this long after the last comment before emailing
const DAILY_HOUR = 9;          // due-soon, overdue and weekly emails go out after this hour
const OWNER_EMAILS = ['mostapha@mygrowthsquad.com'];

const BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';
const PROPS = PropertiesService.getScriptProperties();

/** Run once: creates the every-minute trigger and does a first check. */
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'checkNewTasks'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('checkNewTasks').timeBased().everyMinutes(1).create();
  checkNewTasks();
  Logger.log('Set up. Task emails go out within about a minute.');
}

/** Stops all emails (removes the trigger). */
function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Stopped.');
}

/** Sends last week's summaries now (for testing), even if they already went out. */
function sendWeeklyNow() {
  PROPS.deleteProperty('weekly');
  weekly_(true);
}

/** Sends today's due-soon and overdue emails now, even before 9:00 or if already sent today. */
function sendDailyNow() {
  PROPS.deleteProperty('daily');
  daily_(true);
}

function checkNewTasks() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const now = Date.now();
    // Follow-up emails (comments, done) only cover activity after this version was installed.
    let from = Number(PROPS.getProperty('from') || 0);
    if (!from) { from = now; PROPS.setProperty('from', String(now)); }
    const last = Number(PROPS.getProperty('last') || 0);
    const since = last ? last - OVERLAP_MIN * 60e3 : now - 48 * 3600e3;

    const asg = recentAny_('assignments', ['createdAt', 'assignedAt', 'doneAt', 'lastComment.at', 'estAt'], since);
    const changes = recentAny_('changes', ['at'], since).filter(function (t) {
      return !t.data.notifiedAt && (t.data.at || 0) >= from && t.data.at <= now - COMMENT_WAIT_MIN * 60e3;
    });
    const rec = recentAny_('recurring', ['createdAt', 'assignedAt'], since);

    const fresh = asg.filter(function (t) {
      const a = t.data;
      return !a.notifiedAt && !a.recurringId && a.status !== 'done' && a.assignee &&
        Math.max(a.createdAt || 0, a.assignedAt || 0) >= since;
    });
    const repeats = rec.filter(function (t) {
      const a = t.data;
      return !a.notifiedAt && a.assignee && a.active !== false && Math.max(a.createdAt || 0, a.assignedAt || 0) >= since;
    });
    const done = asg.filter(function (t) {
      const a = t.data;
      return a.status === 'done' && !a.recurringId && !a.doneNotifiedAt && (a.doneAt || 0) >= Math.max(since, from);
    });
    const talk = asg.filter(function (t) {
      const lc = t.data.lastComment;
      return lc && lc.at >= from && lc.at > (t.data.commentNotifiedAt || 0) && lc.at <= now - COMMENT_WAIT_MIN * 60e3;
    });

    const est = asg.filter(function (t) {
      const a = t.data;
      return a.estBy && a.estBy === a.assignee && !a.selfMade && !a.recurringId && a.createdBy && (a.estFrom || 0) > 0 &&
        (a.estAt || 0) >= from && a.estAt > (a.estNotifiedAt || 0) && a.estAt <= now - COMMENT_WAIT_MIN * 60e3;
    });

    if (fresh.length || repeats.length || done.length || talk.length || est.length || changes.length) {
      const people = loadPeople_();
      fresh.forEach(function (t) { safe_(function () { notifyNew_('assignments', t, people, false); }); });
      repeats.forEach(function (t) { safe_(function () { notifyNew_('recurring', t, people, true); }); });
      done.forEach(function (t) { safe_(function () { notifyDone_(t, people); }); });
      talk.forEach(function (t) { safe_(function () { notifyComments_(t, people, from); }); });
      est.forEach(function (t) { safe_(function () { notifyEstimate_(t, people); }); });
      if (changes.length) safe_(function () { notifyChanges_(changes, people); });
    }
    PROPS.setProperty('last', String(now));
    daily_(false);
    safe_(function () { weekly_(false); });
  } finally {
    lock.releaseLock();
  }
}

function safe_(fn) { try { fn(); } catch (e) { console.error(e && e.stack || e); } }

/* ---------- new task ---------- */
function notifyNew_(collection, t, people, isRepeat) {
  const a = t.data;
  const p = people.byUid[a.assignee];
  const to = p && p.email;
  const now = Date.now();
  if (!to) { patch_(collection, t.id, { notifiedAt: now, notifiedHow: 'no-email' }); return; }
  const moved = a.assignedAt && a.editedBy && a.assignedAt > (a.createdAt || 0) + 5000;
  const byEmail = String((moved ? a.editedBy : a.createdBy) || '').toLowerCase();
  if (!moved) safe_(function () { notifyTagged_(a, people, byEmail); });
  // Don't email people about tasks they gave themselves.
  if (byEmail && byEmail === String(to).toLowerCase()) { patch_(collection, t.id, { notifiedAt: now, notifiedHow: 'self' }); return; }
  const byName = personName_(people, byEmail) || 'Your lead';
  const toName = firstName_(p);

  const rows = [];
  if (a.brand) rows.push(['Client / brand', a.brand]);
  if (a.kind) rows.push(['Type of work', a.kind]);
  if (isRepeat) rows.push(['Repeats', repeatLabel_(a.repeat)]);
  else if (a.due) rows.push(['Due', formatDate_(a.due)]);
  if (a.priority === 'high') rows.push(['Priority', 'High']);

  const what = isRepeat ? 'a repeating task' : 'a task';
  const body =
    '<p style="margin:0 0 6px">Hi ' + esc_(toName) + ',</p>' +
    '<p style="margin:0 0 16px">' + esc_(byName) + (moved ? ' moved ' + what + ' to you:' : ' assigned you ' + what + ':') + '</p>' +
    taskBlock_(a, rows) +
    button_('Open my tasks', APP_URL + '#mytasks') +
    small_('Press Start when you begin, Pause when you step away and Done when you finish. Your time on the task is counted for you.');
  const text = 'Hi ' + toName + ',\n\n' + byName + (moved ? ' moved ' + what + ' to you: ' : ' assigned you ' + what + ': ') + a.title + '\n' +
    rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n') + (a.notes ? '\n\n' + a.notes : '') + linksText_(a.links) + '\n\nOpen the Team Log: ' + APP_URL + '#mytasks';

  send_(to, (a.priority === 'high' ? '[High priority] ' : '') + (isRepeat ? 'Repeating task: ' : 'New task: ') + a.title, text, body, byEmail);
  patch_(collection, t.id, { notifiedAt: now, notifiedHow: 'sent' });
}

/* ---------- people tagged on a new task ---------- */
function notifyTagged_(a, people, byEmail) {
  const assignee = String((people.byUid[a.assignee] || {}).email || '').toLowerCase();
  const byName = personName_(people, byEmail) || 'Someone';
  unique_((a.watchers || []).map(function (u) { return String((people.byUid[u] || {}).email || '').toLowerCase(); }))
    .filter(function (e) { return e && e !== assignee && e !== byEmail; })
    .forEach(function (to) {
      const rows = [['Assigned to', nameOfUid_(people, a.assignee)]];
      if (a.brand) rows.push(['Client / brand', a.brand]);
      if (a.due) rows.push(['Due', formatDate_(a.due)]);
      const body = '<p style="margin:0 0 6px">Hi ' + esc_(firstName_(people.byEmail[to])) + ',</p>' +
        '<p style="margin:0 0 16px">' + esc_(byName) + ' tagged you on a task:</p>' + taskBlock_(a, rows) +
        button_('Open team tasks', APP_URL + '#mytasks') + small_('You’ll get an email when someone comments on it.');
      send_(to, 'Tagged: ' + a.title, byName + ' tagged you on: ' + a.title + '\n\n' + APP_URL + '#mytasks', body, byEmail);
    });
}

/* ---------- task done → whoever assigned it ---------- */
function notifyDone_(t, people) {
  const a = t.data;
  const now = Date.now();
  const doer = people.byUid[a.assignee] || {};
  const to = String(a.createdBy || '').toLowerCase();
  if (!to || to === String(doer.email || '').toLowerCase()) { patch_('assignments', t.id, { doneNotifiedAt: now }); return; }
  const doerName = doer.name || doer.email || 'Someone';
  const rows = [];
  if (a.brand) rows.push(['Client / brand', a.brand]);
  if (a.kind) rows.push(['Type of work', a.kind]);
  if (a.workMs) rows.push(['Time on task', dur_(a.workMs)]);
  if (a.due) rows.push(['Was due', formatDate_(a.due) + (a.doneAt && dayKey_(a.doneAt) > a.due ? ' (finished late)' : '')]);
  rows.push(['Finished', formatTime_(a.doneAt || now)]);
  const body =
    '<p style="margin:0 0 6px">Hi ' + esc_(firstName_(people.byEmail[to])) + ',</p>' +
    '<p style="margin:0 0 16px">' + esc_(doerName) + ' finished a task you assigned:</p>' +
    taskBlock_(a, rows, true) +
    button_('Open tasks', APP_URL + '#tasks');
  const text = doerName + ' finished: ' + a.title + '\n' + rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n') + '\n\n' + APP_URL + '#tasks';
  send_(to, '✓ ' + firstName_(doer) + ' finished: ' + a.title, text, body, doer.email);
  patch_('assignments', t.id, { doneNotifiedAt: now });
}

/* ---------- comments → everyone on the thread except the writer ---------- */
function notifyComments_(t, people, from) {
  const a = t.data;
  const after = Math.max(a.commentNotifiedAt || 0, from);
  const all = listDocs_('/assignments/' + encodeURIComponent(t.id) + '/comments').map(function (d) { return d.data; })
    .filter(function (c) { return c && c.at && c.text; }).sort(function (x, y) { return x.at - y.at; });
  const fresh = all.filter(function (c) { return c.at > after; });
  const mark = { commentNotifiedAt: a.lastComment.at };
  if (!fresh.length) { patch_('assignments', t.id, mark); return; }

  const emailOf = function (uid) { const p = people.byUid[uid]; return p && p.email ? String(p.email).toLowerCase() : ''; };
  const assignee = emailOf(a.assignee);
  const who = {};
  const mentioned = {};
  fresh.forEach(function (c) { (c.mentions || []).forEach(function (u) { const e = emailOf(u); if (e) mentioned[e] = true; }); });
  [assignee, String(a.createdBy || '').toLowerCase()].concat(all.map(function (c) { return emailOf(c.uid); }))
    .concat((a.watchers || []).map(emailOf)).concat(Object.keys(mentioned))
    .forEach(function (e) { if (e) who[e] = true; });

  Object.keys(who).forEach(function (to) {
    const mine = fresh.filter(function (c) { return emailOf(c.uid) !== to; });
    if (!mine.length) return;
    const writers = unique_(mine.map(function (c) { return nameOfUid_(people, c.uid); }));
    const p = people.byEmail[to] || {};
    const link = APP_URL + (to === assignee || !(p.role === 'lead' || p.role === 'admin') ? '#mytasks' : '#tasks');
    const body =
      '<p style="margin:0 0 6px">Hi ' + esc_(firstName_(people.byEmail[to])) + ',</p>' +
      '<p style="margin:0 0 12px">' + esc_(listNames_(writers)) + ' commented on <b>' + esc_(a.title) + '</b>' +
        (to === assignee ? '' : ' (' + esc_(nameOfUid_(people, a.assignee)) + '’s task)') + ':</p>' +
      mine.map(function (c) {
        return '<div style="background:#F8F2DC;border-radius:10px;padding:10px 12px;font-size:14px;margin:0 0 8px">' +
          '<div style="font-weight:700;font-size:13px;margin:0 0 4px">' + esc_(nameOfUid_(people, c.uid)) +
          ' <span style="font-weight:400;color:#5B6B69">' + esc_(formatTime_(c.at)) + '</span></div>' + linkify_(c.text) + '</div>';
      }).join('') +
      button_('Reply in the Team Log', link) +
      small_('Open the task and press “Comments” to reply.');
    const text = mine.map(function (c) { return nameOfUid_(people, c.uid) + ': ' + c.text; }).join('\n\n') + '\n\nReply in the Team Log: ' + link;
    const tagged = mentioned[to] && mine.some(function (c) { return (c.mentions || []).some(function (u) { return emailOf(u) === to; }); });
    send_(to, (tagged ? listNames_(writers) + ' mentioned you: ' : 'New comment on: ') + a.title, text, body, mine.length === 1 ? emailOf(mine[0].uid) : '');
  });
  patch_('assignments', t.id, mark);
}

/* ---------- once a day: due soon + overdue ---------- */
function daily_(force) {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (PROPS.getProperty('daily') === today) return;
  if (!force && Number(Utilities.formatDate(new Date(), tz, 'H')) < DAILY_HOUR) return;
  const set = getDoc_('/settings/team') || {};
  const weekend = Array.isArray(set.weekend) ? set.weekend : [5, 6];
  const holidays = (set.holidays || []).map(function (h) { return h && h.date; });
  const isWorkday = function (k) { return weekend.indexOf(weekday_(k)) < 0 && holidays.indexOf(k) < 0; };
  if (!force && !isWorkday(today)) { PROPS.setProperty('daily', today); return; }

  const open = rangeDocs_('assignments', 'due', addDaysKey_(today, -21), addDaysKey_(today, 10)).filter(function (t) {
    const a = t.data; return a.status !== 'done' && !a.recurringId && a.assignee && a.due;
  });
  // the last workday before a due date (or the due date itself when it's today)
  const remindOn = function (due) {
    let k = addDaysKey_(due, -1);
    for (let i = 0; i < 10 && !isWorkday(k); i++) k = addDaysKey_(k, -1);
    return k;
  };
  const soon = open.filter(function (t) { const a = t.data; return a.due >= today && remindOn(a.due) <= today && a.remindedFor !== a.due; });
  const late = open.filter(function (t) { const a = t.data; return a.due < today && a.overdueFor !== a.due; });
  if (!soon.length && !late.length) { PROPS.setProperty('daily', today); return; }

  const people = loadPeople_();
  const by = function (list, key) {
    const m = {}; list.forEach(function (t) { const k = key(t.data); if (k) (m[k] = m[k] || []).push(t); }); return m;
  };

  // Due soon → each person
  const soonBy = by(soon, function (a) { return a.assignee; });
  Object.keys(soonBy).forEach(function (uid) {
    safe_(function () {
      const p = people.byUid[uid]; const list = soonBy[uid].sort(byDue_);
      if (p && p.email) {
        const n = list.length;
        const body = '<p style="margin:0 0 6px">Hi ' + esc_(firstName_(p)) + ',</p>' +
          '<p style="margin:0 0 14px">' + (n === 1 ? 'A task of yours is due soon:' : n + ' of your tasks are due soon:') + '</p>' +
          taskList_(list, today, false, people) + button_('Open my tasks', APP_URL + '#mytasks');
        send_(p.email, n === 1 ? 'Due ' + dueWord_(list[0].data.due, today) + ': ' + list[0].data.title : n + ' tasks due soon',
          plainList_(list, today, false, people) + '\n\n' + APP_URL + '#mytasks', body);
      }
      list.forEach(function (t) { patch_('assignments', t.id, { remindedFor: t.data.due }); });
    });
  });

  // Overdue → each person, plus one summary to each person who assigned them
  const lateBy = by(late, function (a) { return a.assignee; });
  Object.keys(lateBy).forEach(function (uid) {
    safe_(function () {
      const p = people.byUid[uid]; const list = lateBy[uid].sort(byDue_);
      if (p && p.email) {
        const n = list.length;
        const body = '<p style="margin:0 0 6px">Hi ' + esc_(firstName_(p)) + ',</p>' +
          '<p style="margin:0 0 14px">' + (n === 1 ? 'This task is past its due date:' : n + ' of your tasks are past their due date:') + '</p>' +
          taskList_(list, today, false, people) +
          small_('Finish it, or reply in the task’s comments if you need more time.') + button_('Open my tasks', APP_URL + '#mytasks');
        send_(p.email, n === 1 ? 'Overdue: ' + list[0].data.title : n + ' tasks are overdue',
          plainList_(list, today, false, people) + '\n\n' + APP_URL + '#mytasks', body);
      }
    });
  });
  const bossBy = by(late, function (a) {
    const c = String(a.createdBy || '').toLowerCase(); const p = people.byUid[a.assignee];
    return c && !(p && String(p.email || '').toLowerCase() === c) ? c : '';
  });
  Object.keys(bossBy).forEach(function (to) {
    safe_(function () {
      const list = bossBy[to].sort(byDue_); const n = list.length;
      const body = '<p style="margin:0 0 6px">Hi ' + esc_(firstName_(people.byEmail[to])) + ',</p>' +
        '<p style="margin:0 0 14px">' + (n === 1 ? 'A task you assigned is overdue:' : n + ' tasks you assigned are overdue:') + '</p>' +
        taskList_(list, today, true, people) + button_('Open tasks', APP_URL + '#tasks');
      send_(to, n === 1 ? 'Overdue: ' + nameOfUid_(people, list[0].data.assignee) + ' · ' + list[0].data.title : n + ' assigned tasks are overdue',
        plainList_(list, today, true, people) + '\n\n' + APP_URL + '#tasks', body);
    });
  });
  late.forEach(function (t) { safe_(function () { patch_('assignments', t.id, { overdueFor: t.data.due }); }); });
  PROPS.setProperty('daily', today);
}

/* ---------- expected time changed by the person → them + whoever assigned it ---------- */
function notifyEstimate_(t, people) {
  const a = t.data;
  const p = people.byUid[a.assignee] || {};
  const me = String(p.email || '').toLowerCase();
  const boss = String(a.createdBy || '').toLowerCase();
  const mark = { estNotifiedAt: a.estAt };
  if (!me || !boss || me === boss || a.estimate === a.estFrom) { patch_('assignments', t.id, mark); return; }
  const who = p.name || p.email;
  const from = estLabel_(a.estFrom), to = estLabel_(a.estimate);
  const rows = [['Expected time', from + ' → ' + to]];
  if (a.brand) rows.push(['Client / brand', a.brand]);
  if (a.due) rows.push(['Due', formatDate_(a.due)]);
  if (a.workMs) rows.push(['Time spent so far', dur_(a.workMs)]);
  const body =
    '<p style="margin:0 0 6px">Hi ' + esc_(firstName_(p)) + ' and ' + esc_(firstName_(people.byEmail[boss])) + ',</p>' +
    '<p style="margin:0 0 16px">' + esc_(who) + ' changed the expected time on this task' + (a.estimate ? '' : ' (removed it)') + ':</p>' +
    taskBlock_(a, rows, true) +
    small_('If the new time doesn’t work, talk it through in the task’s comments.') +
    button_('Open the task', APP_URL + '#tasks');
  const text = who + ' changed the expected time on "' + a.title + '": ' + from + ' → ' + to + '\n\n' + APP_URL + '#tasks';
  send_(me + ',' + boss, 'Expected time changed: ' + a.title + ' (' + from + ' → ' + to + ')', text, body);
  patch_('assignments', t.id, mark);
}

/* ---------- time changes → the person's lead ---------- */
function leadsOf_(people, uid) {
  const p = people.byUid[uid] || {};
  const me = String(p.email || '').toLowerCase();
  let out = [];
  if (p.team) Object.keys(people.byUid).forEach(function (u) {
    const x = people.byUid[u];
    if (u !== uid && x.role === 'lead' && x.team === p.team && x.email) out.push(String(x.email).toLowerCase());
  });
  if (!out.length) out = admins_(people);
  return unique_(out.filter(function (e) { return e && e !== me; }));
}
function admins_(people) {
  const list = OWNER_EMAILS.slice();
  Object.keys(people.byUid).forEach(function (u) { const x = people.byUid[u]; if (x.role === 'admin' && x.email) list.push(String(x.email).toLowerCase()); });
  return unique_(list.map(function (e) { return String(e).toLowerCase(); }));
}
function notifyChanges_(changes, people) {
  const by = {};
  changes.forEach(function (t) { leadsOf_(people, t.data.uid).forEach(function (e) { (by[e] = by[e] || []).push(t); }); });
  Object.keys(by).forEach(function (to) {
    safe_(function () {
      const list = by[to].sort(function (x, y) { return x.data.at - y.data.at; });
      const n = list.length;
      const items = list.map(function (t) {
        const c = t.data;
        return '<div style="background:#F8F2DC;border-radius:10px;padding:10px 12px;font-size:14px;margin:0 0 8px">' +
          '<div style="font-weight:700;font-size:13px;margin:0 0 4px">' + esc_(nameOfUid_(people, c.uid)) + ' · ' + esc_(formatShort_(c.day)) + '</div>' +
          esc_(c.text) + (c.reason ? '<div style="color:#5B6B69;margin-top:4px">“' + esc_(c.reason) + '”</div>' : '') + '</div>';
      }).join('');
      const body = '<p style="margin:0 0 6px">Hi ' + esc_(firstName_(people.byEmail[to])) + ',</p>' +
        '<p style="margin:0 0 12px">' + (n === 1 ? 'Someone on your team changed their time:' : n + ' time changes from your team:') + '</p>' + items +
        small_('Nothing to approve. This is so you know. You can mark it as seen under Approvals.') + button_('Open Approvals', APP_URL + '#approvals');
      const text = list.map(function (t) { return nameOfUid_(people, t.data.uid) + ' · ' + t.data.day + ': ' + t.data.text + (t.data.reason ? ' ("' + t.data.reason + '")' : ''); }).join('\n') + '\n\n' + APP_URL + '#approvals';
      send_(to, n === 1 ? 'Time change: ' + nameOfUid_(people, list[0].data.uid) + ' · ' + formatShort_(list[0].data.day) : n + ' time changes from your team', text, body);
    });
  });
  const now = Date.now();
  changes.forEach(function (t) { safe_(function () { patch_('changes', t.id, { notifiedAt: now }); }); });
}

/* ---------- weekly summary (week starts Saturday) → each person, their lead in cc ---------- */
function workCal_() {
  const set = getDoc_('/settings/team') || {};
  const weekend = Array.isArray(set.weekend) ? set.weekend : [5, 6];
  const holidays = (set.holidays || []).map(function (h) { return h && h.date; });
  return { isWorkday: function (k) { return weekend.indexOf(weekday_(k)) < 0 && holidays.indexOf(k) < 0; } };
}
function weekly_(force) {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const weekStart = addDaysKey_(today, -((weekday_(today) + 1) % 7));
  const done = PROPS.getProperty('weekly');
  if (!force) {
    if (!done) { PROPS.setProperty('weekly', weekStart); return; }   // first run: start with next week
    if (done >= weekStart) return;
    if (Number(Utilities.formatDate(new Date(), tz, 'H')) < DAILY_HOUR) return;
    const cal = workCal_();
    let first = weekStart; for (let i = 0; i < 7 && !cal.isWorkday(first); i++) first = addDaysKey_(first, 1);
    if (today < first) return;
  }
  sendWeekly_(addDaysKey_(weekStart, -7), addDaysKey_(weekStart, -1));
  PROPS.setProperty('weekly', weekStart);
}
function keyStartMs_(k) { const p = k.split('-').map(Number); const tz = Session.getScriptTimeZone();
  const guess = Date.UTC(p[0], p[1] - 1, p[2]); const off = Number(Utilities.formatDate(new Date(guess), tz, 'H')); return guess - (off > 12 ? off - 24 : off) * 3600e3; }
function sendWeekly_(lo, hi) {
  const people = loadPeople_();
  const keys = []; for (let k = lo; k <= hi; k = addDaysKey_(k, 1)) keys.push(k);
  const tasks = recentAny_('assignments', ['updatedAt', 'doneAt'], keyStartMs_(lo) - 7 * 864e5).map(function (t) { return Object.assign({ _id: t.id }, t.data); });
  Object.keys(people.byUid).forEach(function (uid) {
    safe_(function () {
      const p = people.byUid[uid];
      if (!p.email) return;
      const days = runQueryAt_('/logs/' + encodeURIComponent(uid), { from: [{ collectionId: 'days' }], where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: lo } } },
        { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: hi } } }] } } });
      const s = weekStats_(uid, keys, days, tasks.filter(function (a) { return a.assignee === uid; }));
      if (!s.worked && !s.tracked && !s.done.length) return;
      const cc = leadsOf_(people, uid);
      const html = weeklyHtml_(p, s, lo, hi);
      const text = firstName_(p) + '’s week (' + formatShort_(lo) + ' – ' + formatShort_(hi) + '): ' + hm_(s.worked) + ' worked, ' + hm_(s.tracked) + ' on tasks, ' +
        s.done.length + ' tasks finished.\n\n' + APP_URL + '#insights';
      const opts = { name: SENDER_NAME, htmlBody: emailWrap_(html) };
      if (cc.length) opts.cc = cc.join(',');
      MailApp.sendEmail(p.email, 'Your week, ' + formatShort_(lo) + ' – ' + formatShort_(hi) + ': ' + hm_(s.tracked) + ' on tasks, ' + s.done.length + ' finished', text, opts);
    });
  });
}
function weekStats_(uid, keys, days, tasks) {
  const byDay = {}; days.forEach(function (d) { byDay[d.data.date || d.id] = d.data; });
  const has = {}; keys.forEach(function (k) { has[k] = true; });
  let worked = 0, tracked = 0; const items = []; const heavy = [];
  keys.forEach(function (k) {
    const d = byDay[k] || {};
    (d.sessions || []).forEach(function (x) {
      if (x.out == null) return;
      let ms = x.out - x.in; (x.breaks || []).forEach(function (b) { if (b.e != null) ms -= (b.e - b.s); }); worked += Math.max(0, ms);
    });
    const list = [];
    tasks.forEach(function (a) {
      let ms = Number((a.workDays || {})[k]) || 0;
      if (!a.workDays && a.workMs && a.status === 'done' && a.doneAt && dayKey_(a.doneAt) === k) ms += Number(a.workMs) || 0;
      if (ms > 0) list.push({ title: a.title, brand: a.brand || '', kind: a.kind || '', ms: ms });
    });
    (d.tasks || []).forEach(function (x) { if (x.asg && tasks.some(function (a) { return a._id === x.asg && (a.workDays || a.workMs); })) return;
      if (Number(x.mins) > 0) list.push({ title: x.text, brand: x.brand || '', kind: x.kind || '', ms: x.mins * 60000 }); });
    const t = list.reduce(function (s, x) { return s + x.ms; }, 0); tracked += t;
    list.sort(function (a, b) { return b.ms - a.ms; });
    if (list[0] && t >= 3 * 3600e3 && list[0].ms / t >= 0.6) heavy.push({ k: k, title: list[0].title, ms: list[0].ms, share: list[0].ms / t });
    Array.prototype.push.apply(items, list);
  });
  const done = tasks.filter(function (a) { return a.status === 'done' && a.doneAt && has[dayKey_(a.doneAt)]; });
  const withEst = done.filter(function (a) { return a.estimate && a.workMs; });
  const estSum = withEst.reduce(function (s, a) { return s + a.estimate * 60000; }, 0), actSum = withEst.reduce(function (s, a) { return s + a.workMs; }, 0);
  const over = tasks.filter(function (a) {
    if (!a.estimate || !a.workMs) return false;
    const touched = Object.keys(a.workDays || {}).some(function (k) { return has[k]; }) || (a.status === 'done' && a.doneAt && has[dayKey_(a.doneAt)]);
    return touched && a.workMs > a.estimate * 60000 * 1.25 && a.workMs - a.estimate * 60000 >= 10 * 60000;
  }).sort(function (x, y) { return (y.workMs - y.estimate * 60000) - (x.workMs - x.estimate * 60000); });
  let pDays = 0, pDone = 0;
  tasks.forEach(function (a) { keys.forEach(function (k) {
    if (a.planFor === k || (a.planDays || []).indexOf(k) >= 0) { pDays++; if (a.status === 'done' && a.doneAt && dayKey_(a.doneAt) <= k) pDone++; }
  }); });
  const group = function (key, none) { const m = {}; items.forEach(function (x) { const n = x[key] || none; m[n] = (m[n] || 0) + x.ms; });
    return Object.keys(m).map(function (n) { return { name: n, ms: m[n] }; }).sort(function (a, b) { return b.ms - a.ms; }); };
  return { worked: worked, tracked: tracked, done: done, nEst: withEst.length, estSum: estSum, actSum: actSum, over: over, heavy: heavy,
    pDays: pDays, pDone: pDone, byKind: group('kind', 'No type of work'), byBrand: group('brand', 'No client') };
}
function weeklyHtml_(p, s, lo, hi) {
  const tile = function (v, l) { return '<td style="padding:10px 12px;background:#F8F2DC;border-radius:10px;vertical-align:top;width:25%"><div style="font-size:20px;font-weight:800">' + v + '</div><div style="font-size:12px;color:#5B6B69">' + esc_(l) + '</div></td>'; };
  const ratio = s.nEst ? s.actSum / s.estSum : 0;
  const acc = !s.nEst ? '—' : ratio > 1.1 ? Math.round((ratio - 1) * 100) + '% over' : ratio < 0.9 ? Math.round((1 - ratio) * 100) + '% under' : 'On target';
  const bars = function (rows, total) {
    if (!rows.length) return '<p style="color:#5B6B69;font-size:14px;margin:0 0 14px">Nothing tracked.</p>';
    const max = rows[0].ms;
    return '<table style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 16px">' + rows.slice(0, 6).map(function (r) {
      return '<tr><td style="padding:4px 10px 4px 0;white-space:nowrap;width:35%">' + esc_(r.name) + '</td><td style="padding:4px 0;width:45%"><div style="background:#EFE7CB;border-radius:5px;height:10px"><div style="background:#FF4F00;border-radius:5px;height:10px;width:' + Math.max(2, Math.round(r.ms / max * 100)) + '%"></div></div></td>' +
        '<td style="padding:4px 0 4px 10px;text-align:right;white-space:nowrap;color:#5B6B69">' + hm_(r.ms) + (total ? ' · ' + Math.round(r.ms / total * 100) + '%' : '') + '</td></tr>';
    }).join('') + '</table>';
  };
  let tip = '';
  if (s.worked && s.tracked / s.worked < 0.5) tip = 'Less than half of your day was on a task. Press Start on a task when you begin it, so you can see where the rest of the time goes.';
  else if (s.nEst >= 2 && ratio > 1.25) tip = 'Tasks took about ' + Math.round((ratio - 1) * 100) + '% longer than you expected. Try adding that much buffer when you plan, or split big tasks into smaller ones.';
  else if (!s.pDays) tip = 'Try planning 2 or 3 tasks each morning in My plan, with a time for each. It makes it easier to see when something is eating your day.';
  else if (s.heavy.length) tip = 'On ' + s.heavy.length + (s.heavy.length === 1 ? ' day' : ' days') + ' one task took most of your time. If it was stuck, split it or ask for help early.';
  else if (s.pDays && s.pDone / s.pDays >= 0.8) tip = 'You finished most of what you planned. Nice week.';
  return '<p style="margin:0 0 6px">Hi ' + esc_(firstName_(p)) + ',</p>' +
    '<p style="margin:0 0 14px">Here’s how your time went from ' + esc_(formatShort_(lo)) + ' to ' + esc_(formatShort_(hi)) + '.</p>' +
    '<table style="border-collapse:separate;border-spacing:6px;width:100%;margin:0 0 12px"><tr>' +
      tile(hm_(s.worked), 'Hours worked') + tile(hm_(s.tracked) + (s.worked ? ' <span style="font-size:13px;color:#5B6B69">' + Math.min(100, Math.round(s.tracked / s.worked * 100)) + '%</span>' : ''), 'On tasks') +
      tile(String(s.done.length), 'Tasks finished') + tile(s.pDays ? s.pDone + ' / ' + s.pDays : '—', 'Planned tasks finished') + '</tr></table>' +
    '<div style="font-weight:700;margin:6px 0 6px">Where the time went</div>' + bars(s.byKind, s.tracked) +
    '<div style="font-weight:700;margin:6px 0 6px">By client</div>' + bars(s.byBrand, s.tracked) +
    '<div style="font-weight:700;margin:6px 0 6px">Estimates</div><p style="font-size:14px;margin:0 0 8px">' +
      (s.nEst ? 'Across ' + s.nEst + ' finished tasks with an expected time: <b>' + esc_(acc) + '</b> (' + hm_(s.actSum) + ' spent vs ' + hm_(s.estSum) + ' expected).' : 'No finished tasks had an expected time this week.') + '</p>' +
    (s.over.length ? '<table style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 14px">' + s.over.slice(0, 5).map(function (a) {
      return '<tr><td style="padding:6px 10px 6px 0;border-top:1px solid #E2D8B6">' + esc_(a.title) + '</td><td style="padding:6px 0;border-top:1px solid #E2D8B6;text-align:right;white-space:nowrap;color:#C2410C;font-weight:600">' + hm_(a.workMs) + ' vs ' + esc_(estLabel_(a.estimate)) + '</td></tr>';
    }).join('') + '</table>' : '') +
    (s.heavy.length ? '<div style="font-weight:700;margin:6px 0 6px">Days that went mostly to one task</div><ul style="font-size:14px;margin:0 0 14px;padding-left:18px">' + s.heavy.slice(0, 4).map(function (h) {
      return '<li>' + esc_(formatShort_(h.k)) + ': ' + hm_(h.ms) + ' on “' + esc_(h.title) + '” (' + Math.round(h.share * 100) + '%)</li>';
    }).join('') + '</ul>' : '') +
    (tip ? '<div style="background:#FFF1E8;border:1px solid #FFC9AA;border-radius:10px;padding:10px 12px;font-size:14px;margin:0 0 16px"><b>Tip:</b> ' + esc_(tip) + '</div>' : '') +
    button_('Open My insights', APP_URL + '#insights') +
    small_('Your lead gets a copy of this summary. It shows time on tasks, not when you started or ended your day.');
}
function hm_(ms) { return ms >= 60000 ? dur_(ms) : '0m'; }
function estLabel_(m) { m = Number(m) || 0; if (!m) return 'no estimate'; if (m < 60) return m + ' min'; const h = m / 60; return (h === Math.floor(h) ? h : h.toFixed(1)) + (h === 1 ? ' hour' : ' hours'); }

/* ---------- email building ---------- */
function send_(to, subject, text, innerHtml, replyTo) {
  const opts = { name: SENDER_NAME, htmlBody: emailWrap_(innerHtml) };
  if (replyTo) opts.replyTo = replyTo;
  MailApp.sendEmail(to, subject, text, opts);
}
function emailWrap_(innerHtml) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1B2F33">' +
      '<div style="background:#1B2F33;border-radius:14px 14px 0 0;padding:18px 22px">' +
        '<div style="color:#FF4F00;font-weight:800;font-size:18px">GrowthSquad</div>' +
        '<div style="color:#F8F2DC;font-size:13px;margin-top:2px">Team Work Log</div>' +
      '</div>' +
      '<div style="background:#FFFCF2;border:1px solid #E2D8B6;border-top:0;border-radius:0 0 14px 14px;padding:22px">' + innerHtml + '</div>' +
    '</div>';
}
function taskBlock_(a, rows, done) {
  return '<div style="font-size:18px;font-weight:700;margin:0 0 12px">' + (done ? '✓ ' : '') + esc_(a.title) + '</div>' +
    (rows.length ? '<table style="border-collapse:collapse;font-size:14px;margin:0 0 12px">' + rows.map(function (r) {
      return '<tr><td style="padding:3px 16px 3px 0;color:#5B6B69">' + esc_(r[0]) + '</td><td style="padding:3px 0;font-weight:600">' + esc_(r[1]) + '</td></tr>';
    }).join('') + '</table>' : '') +
    (a.notes && !done ? '<div style="background:#F8F2DC;border-radius:10px;padding:10px 12px;font-size:14px;margin:0 0 12px;white-space:pre-line">' + linkify_(a.notes) + '</div>' : '') +
    (!done ? linksHtml_(a.links) : '');
}
function taskList_(list, today, showWho, people) {
  return '<table style="border-collapse:collapse;font-size:14px;width:100%;margin:0 0 16px">' + list.map(function (t) {
    const a = t.data; const late = a.due < today;
    return '<tr><td style="padding:8px 10px 8px 0;border-top:1px solid #E2D8B6;vertical-align:top">' +
      '<div style="font-weight:700">' + esc_(a.title) + (a.priority === 'high' ? ' <span style="color:#C2410C;font-size:12px">· High priority</span>' : '') + '</div>' +
      '<div style="color:#5B6B69;font-size:13px">' + [showWho ? nameOfUid_(people, a.assignee) : '', a.brand, a.kind].filter(String).map(esc_).join(' · ') + '</div></td>' +
      '<td style="padding:8px 0;border-top:1px solid #E2D8B6;vertical-align:top;text-align:right;white-space:nowrap;font-weight:600;color:' + (late ? '#C2410C' : '#1B2F33') + '">' +
      esc_(late ? 'Was due ' + formatShort_(a.due) : 'Due ' + dueWord_(a.due, today)) + '</td></tr>';
  }).join('') + '</table>';
}
function plainList_(list, today, showWho, people) {
  return list.map(function (t) {
    const a = t.data;
    return '- ' + (showWho ? nameOfUid_(people, a.assignee) + ': ' : '') + a.title + ' (' + (a.due < today ? 'was due ' + formatShort_(a.due) : 'due ' + dueWord_(a.due, today)) + ')';
  }).join('\n');
}
function button_(label, href) {
  return '<a href="' + esc_(href) + '" style="display:inline-block;background:#FF4F00;color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:999px">' + esc_(label) + '</a>';
}
function small_(s) { return '<p style="font-size:12px;color:#5B6B69;margin:14px 0 14px">' + esc_(s) + '</p>'; }
function linksHtml_(links) {
  if (!links || !links.length) return '';
  return '<div style="margin:0 0 16px;font-size:14px">' + links.map(function (u) {
    return '<div style="margin:2px 0">🔗 <a href="' + esc_(u) + '" style="color:#FF4F00">' + esc_(u.length > 70 ? u.slice(0, 67) + '…' : u) + '</a></div>';
  }).join('') + '</div>';
}
function linksText_(links) { return links && links.length ? '\n\nLinks:\n' + links.join('\n') : ''; }
function linkify_(s) {
  return esc_(s).replace(/https?:\/\/[^\s<]+/g, function (m) {
    const href = m.replace(/(&quot;|&#39;|[),.;!?])+$/, '');
    return '<a href="' + href + '" style="color:#FF4F00">' + href + '</a>' + m.slice(href.length);
  });
}

/* ---------- people ---------- */
function loadPeople_() {
  const byUid = {}, byEmail = {};
  listDocs_('/people').forEach(function (d) {
    byUid[d.id] = d.data; if (d.data.email) byEmail[String(d.data.email).toLowerCase()] = d.data;
  });
  return { byUid: byUid, byEmail: byEmail };
}
function firstName_(p) { return ((p && (p.name || p.email)) || 'there').split(/[ @]/)[0]; }
function personName_(people, email) { const p = people.byEmail[String(email || '').toLowerCase()]; return (p && p.name) || email || ''; }
function nameOfUid_(people, uid) { const p = people.byUid[uid]; return (p && (p.name || p.email)) || 'Someone'; }
function listNames_(a) { return a.length <= 2 ? a.join(' and ') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
function unique_(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }

/* ---------- Firestore REST helpers ---------- */
function fs_(path, options) {
  const res = UrlFetchApp.fetch(BASE + path, Object.assign({
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': PROJECT_ID },
    contentType: 'application/json',
    muteHttpExceptions: true
  }, options || {}));
  const code = res.getResponseCode();
  if (code === 404 && (!options || !options.method)) return null;
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + res.getContentText().slice(0, 400));
  const body = res.getContentText();
  return body ? JSON.parse(body) : {};
}
function runQuery_(structuredQuery) {
  const out = fs_(':runQuery', { method: 'post', payload: JSON.stringify({ structuredQuery: structuredQuery }) });
  return (out || []).filter(function (r) { return r.document; }).map(function (r) {
    return { id: r.document.name.split('/').pop(), data: fields_(r.document) };
  });
}
function runQueryAt_(parent, structuredQuery) {
  const out = fs_(parent + ':runQuery', { method: 'post', payload: JSON.stringify({ structuredQuery: structuredQuery }) });
  return (out || []).filter(function (r) { return r.document; }).map(function (r) {
    return { id: r.document.name.split('/').pop(), data: fields_(r.document) };
  });
}
function geFilter_(field, since) {
  return { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value: { integerValue: String(Math.floor(since)) } } };
}
/** Docs where any of the fields is >= since. One OR query when possible, else one query per field. */
function recentAny_(collection, fieldList, since) {
  try {
    if (PROPS.getProperty('noOr')) throw new Error('skip');
    return runQuery_({ from: [{ collectionId: collection }],
      where: { compositeFilter: { op: 'OR', filters: fieldList.map(function (f) { return geFilter_(f, since); }) } }, limit: 500 });
  } catch (e) {
    if (String(e.message).indexOf('Firestore 400') === 0) PROPS.setProperty('noOr', '1');
    const seen = {}, out = [];
    fieldList.forEach(function (f) {
      runQuery_({ from: [{ collectionId: collection }], where: geFilter_(f, since), limit: 300 }).forEach(function (d) {
        if (!seen[d.id]) { seen[d.id] = true; out.push(d); }
      });
    });
    return out;
  }
}
function rangeDocs_(collection, field, lo, hi) {
  return runQuery_({ from: [{ collectionId: collection }], where: { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: lo } } },
    { fieldFilter: { field: { fieldPath: field }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: hi } } }
  ] } }, limit: 1000 });
}
function listDocs_(path) {
  const out = []; let token = '';
  do {
    const page = fs_(path + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : '')) || {};
    (page.documents || []).forEach(function (d) { out.push({ id: d.name.split('/').pop(), data: fields_(d) }); });
    token = page.nextPageToken || '';
  } while (token);
  return out;
}
function getDoc_(path) { const d = fs_(path); return d && d.fields ? fields_(d) : null; }
/** Updates only the given fields of a document. */
function patch_(collection, id, obj) {
  const keys = Object.keys(obj);
  const fields = {};
  keys.forEach(function (k) {
    const v = obj[k];
    fields[k] = typeof v === 'number' ? { integerValue: String(Math.floor(v)) } : v == null ? { nullValue: null } : { stringValue: String(v) };
  });
  fs_('/' + collection + '/' + encodeURIComponent(id) + '?' + keys.map(function (k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&'), {
    method: 'patch', payload: JSON.stringify({ fields: fields })
  });
}
function val_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue).getTime();
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k in f) o[k] = val_(f[k]); return o; }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val_);
  return null;
}
function fields_(doc) { const o = {}; const f = doc.fields || {}; for (const k in f) o[k] = val_(f[k]); return o; }

/* ---------- dates & formatting ---------- */
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function keyDate_(k) { const p = String(k).split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)); }
function addDaysKey_(k, n) { const d = keyDate_(k); d.setUTCDate(d.getUTCDate() + n); return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'); }
function weekday_(k) { return keyDate_(k).getUTCDay(); }
function dayKey_(ms) { return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function formatDate_(k) { return Utilities.formatDate(keyDate_(k), 'UTC', 'EEE d MMM yyyy'); }
function formatShort_(k) { return Utilities.formatDate(keyDate_(k), 'UTC', 'EEE d MMM'); }
function formatTime_(ms) { return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'EEE d MMM, h:mm a'); }
function dueWord_(due, today) { return due === today ? 'today' : due === addDaysKey_(today, 1) ? 'tomorrow' : formatShort_(due); }
function byDue_(x, y) { return String(x.data.due).localeCompare(String(y.data.due)); }
function dur_(ms) { const m = Math.round(ms / 60000); const h = Math.floor(m / 60), r = m % 60; return h ? (r ? h + 'h ' + r + 'm' : h + 'h') : r + 'm'; }
function repeatLabel_(r) {
  if (r === 'daily') return 'Every workday';
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return r && r[0] === 'w' ? 'Every ' + days[Number(r.slice(1))] : '';
}
