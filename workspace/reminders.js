"use strict";

const v = require("./validation");
const { check } = require("./errors");
const { publicAction } = require("./actions");

function localParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const read = (type) => parts.find((part) => part.type === type).value;
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    hour: Number(read("hour")),
  };
}

function dueState(action, now) {
  if (action.dueAt) {
    const due = Date.parse(action.dueAt);
    if (due > now.getTime()) return null;
    return localParts(new Date(due), action.dueTimezone).date ===
      localParts(now, action.dueTimezone).date
      ? "today"
      : "overdue";
  }
  if (!action.dueDate) return null;
  const today = localParts(now, action.dueTimezone).date;
  if (action.dueDate > today) return null;
  return action.dueDate === today ? "today" : "overdue";
}

function rows(store, workspaceId, now = new Date()) {
  store.getWorkspace({ workspaceId });
  const ids = store._db
    .prepare(
      `SELECT id FROM actions
       WHERE workspace_id=? AND deleted_at IS NULL
         AND status IN ('accepted','deferred') AND owner_kind='self'
       ORDER BY updated_at DESC,id`,
    )
    .all(workspaceId);
  const state = store._db.prepare(
    "SELECT snoozed_until,last_notified_at FROM action_reminders WHERE workspace_id=? AND action_id=?",
  );
  return ids.flatMap(({ id }) => {
    const action = store.get({ workspaceId }, "action", id);
    const kind = dueState(action, now);
    if (!kind) return [];
    const reminder = state.get(workspaceId, id) ?? {};
    return [{
      ...publicAction(action),
      dueState: kind,
      snoozedUntil: reminder.snoozed_until ?? null,
      lastNotifiedAt: reminder.last_notified_at ?? null,
    }];
  });
}

function due(store, workspaceId, now = new Date()) {
  const items = rows(store, workspaceId, now);
  return {
    items,
    overdue: items.filter((item) => item.dueState === "overdue").length,
    today: items.filter((item) => item.dueState === "today").length,
  };
}

function snooze(store, context, id, until) {
  v.uuid(id);
  const instant = v.instant(until, "snooze time");
  check(Date.parse(instant) > Date.now(), "INVALID_INPUT", "Snooze time must be in the future");
  return store._mutate(context, "reminder.snooze", { id, until: instant }, () => {
    const action = store.get({ workspaceId: context.workspaceId }, "action", id);
    check(
      ["accepted", "deferred"].includes(action.status) && action.owner.kind === "self",
      "INVALID_TRANSITION",
      "Only active self-owned actions can be snoozed",
    );
    const now = new Date().toISOString();
    store._db.prepare(
      `INSERT INTO action_reminders(action_id,workspace_id,snoozed_until,last_notified_at,updated_at)
       VALUES (?,?,?,NULL,?)
       ON CONFLICT(action_id,workspace_id) DO UPDATE SET snoozed_until=excluded.snoozed_until,updated_at=excluded.updated_at`,
    ).run(id, context.workspaceId, instant, now);
    return { actionId: id, snoozedUntil: instant };
  });
}

class ReminderService {
  constructor({ catalog, notify, now = () => new Date(), intervalMs = 60000 }) {
    this.catalog = catalog;
    this.notify = notify;
    this.now = now;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
    this.check().catch(() => {});
  }

  async check() {
    return this.catalog.serialize(async () => {
      const store = this.catalog.store;
      if (!store) return [];
      const workspace = this.catalog.active();
      const now = this.now();
      const local = localParts(now, workspace.preferences.timezone);
      if (!workspace.preferences.notificationsEnabled || local.hour < workspace.preferences.reminderHour)
        return [];
      const candidates = rows(store, workspace.id, now).filter((item) => {
        if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now.getTime()) return false;
        if (!item.lastNotifiedAt) return true;
        return localParts(new Date(item.lastNotifiedAt), workspace.preferences.timezone).date !== local.date;
      });
      if (!candidates.length) return [];
      const overdue = candidates.filter((item) => item.dueState === "overdue").length;
      await this.notify({
        title: overdue ? `${overdue} overdue action${overdue === 1 ? "" : "s"}` : "Actions due today",
        body: candidates.length === 1 ? candidates[0].title : `${candidates.length} actions need your attention.`,
      });
      const stamp = now.toISOString();
      const save = store._db.prepare(
        `INSERT INTO action_reminders(action_id,workspace_id,snoozed_until,last_notified_at,updated_at)
         VALUES (?,?,NULL,?,?)
         ON CONFLICT(action_id,workspace_id) DO UPDATE SET snoozed_until=NULL,last_notified_at=excluded.last_notified_at,updated_at=excluded.updated_at`,
      );
      store._db.transaction(() => {
        for (const item of candidates) save.run(item.id, workspace.id, stamp, stamp);
      }).immediate();
      return candidates;
    });
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { localParts, dueState, due, snooze, ReminderService };
