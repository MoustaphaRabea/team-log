/**
 * Growth Squad Team Log — task emails.
 *
 * Runs every minute (set up by running `setup` once) and sends:
 *  - New task:     to the person a task is assigned (or moved) to.
 *  - Comments:     to everyone on a task's thread except the person who wrote it
 *                  (waits ~2 minutes so a burst of comments arrives as one email).
 *  - Task done:    to the person who assigned it.
 *  - Due soon:     once a day after 9:00, to each person with tasks due today or
 *                  before the next workday (one email listing them all).
 *  - Overdue:      once a day after 9:00, to the person and to whoever assigned it.
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
const DAILY_HOUR = 9;          // due-soon and overdue emails go out after this hour

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

    const asg = recentAny_('assignments', ['createdAt', 'assignedAt', 'doneAt', 'lastComment.at'], since);
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

    if (fresh.length || repeats.length || done.length || talk.length) {
      const people = loadPeople_();
      fresh.forEach(function (t) { safe_(function () { notifyNew_('assignments', t, people, false); }); });
      repeats.forEach(function (t) { safe_(function () { notifyNew_('recurring', t, people, true); }); });
      done.forEach(function (t) { safe_(function () { notifyDone_(t, people); }); });
      talk.forEach(function (t) { safe_(function () { notifyComments_(t, people, from); }); });
    }
    PROPS.setProperty('last', String(now));
    daily_(false);
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
  [assignee, String(a.createdBy || '').toLowerCase()].concat(all.map(function (c) { return emailOf(c.uid); }))
    .forEach(function (e) { if (e) who[e] = true; });

  Object.keys(who).forEach(function (to) {
    const mine = fresh.filter(function (c) { return emailOf(c.uid) !== to; });
    if (!mine.length) return;
    const writers = unique_(mine.map(function (c) { return nameOfUid_(people, c.uid); }));
    const link = APP_URL + (to === assignee ? '#mytasks' : '#tasks');
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
    send_(to, 'New comment on: ' + a.title, text, body, mine.length === 1 ? emailOf(mine[0].uid) : '');
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

/* ---------- email building ---------- */
function send_(to, subject, text, innerHtml, replyTo) {
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1B2F33">' +
      '<div style="background:#1B2F33;border-radius:14px 14px 0 0;padding:18px 22px">' +
        '<div style="color:#FF4F00;font-weight:800;font-size:18px">GrowthSquad</div>' +
        '<div style="color:#F8F2DC;font-size:13px;margin-top:2px">Team Work Log</div>' +
      '</div>' +
      '<div style="background:#FFFCF2;border:1px solid #E2D8B6;border-top:0;border-radius:0 0 14px 14px;padding:22px">' + innerHtml + '</div>' +
    '</div>';
  const opts = { name: SENDER_NAME, htmlBody: html };
  if (replyTo) opts.replyTo = replyTo;
  MailApp.sendEmail(to, subject, text, opts);
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
