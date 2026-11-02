"use strict";
const { EventEmitter } = require("node:events");
const { parseNovelUrl, extractNovel, safeFolder } = require("./novelpia.cjs");
const {
  STATUS_LABELS,
  extractStatus,
  validatePolicy,
  observeStatus,
  shouldNotify,
} = require("./status.cjs");
class Monitor extends EventEmitter {
  constructor({ store, archive, fetchResource, decode }) {
    super();
    Object.assign(this, { store, archive, fetchResource, decode });
    this.queue = Promise.resolve();
    this.busy = new Set();
    this.pending = new Map();
    this.ticking = false;
  }
  snapshot() {
    return {
      ...structuredClone(this.store.state),
      busy: [...this.busy],
      recovered: this.store.recovered,
      statusLabels: STATUS_LABELS,
    };
  }
  changed() {
    this.emit("changed", this.snapshot());
  }
  enqueue(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }
  async add(input) {
    const { id, url } = parseNovelUrl(input);
    await this.enqueue(async () => {
      if (!this.store.state.root)
        throw new Error("Сначала выберите папку архива.");
      if (this.store.state.novels.some((n) => n.id === id))
        throw new Error("Эта новелла уже добавлена.");
      await this.store.update((s) => {
        const old = s.retired[id];
        s.novels.push(
          old || {
            id,
            url,
            title: `Novelpia ${id}`,
            folder: "",
            history: [],
            nextCheck: 0,
            lastCheck: null,
            error: "",
            failures: 0,
          },
        );
        delete s.retired[id];
      });
      this.changed();
    });
    await this.check(id);
    return this.snapshot();
  }
  async update(patch) {
    return this.enqueue(async () => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("Неверные настройки.");
      const allowed = [
        "root",
        "interval",
        "paused",
        "notifications",
        "login",
        "statusNotifications",
      ];
      if (Object.keys(patch).some((k) => !allowed.includes(k)))
        throw new Error("Неизвестная настройка.");
      if (
        "interval" in patch &&
        (!Number.isInteger(patch.interval) ||
          patch.interval < 5 ||
          patch.interval > 1440)
      )
        throw new Error("Интервал — целое число от 5 до 1440 минут.");
      for (const key of ["paused", "notifications", "login"])
        if (key in patch && typeof patch[key] !== "boolean")
          throw new Error("Неверное значение настройки.");
      if ("root" in patch && typeof patch.root !== "string")
        throw new Error("Неверная папка.");
      if ("statusNotifications" in patch)
        patch = {
          ...patch,
          statusNotifications: validatePolicy(patch.statusNotifications),
        };
      await this.store.update((s) => {
        Object.assign(s, patch);
        if ("interval" in patch)
          for (const n of s.novels)
            n.nextCheck = Math.min(
              n.nextCheck || 0,
              Date.now() + s.interval * 60000,
            );
      });
      this.changed();
      return this.snapshot();
    });
  }
  async remove(id) {
    return this.enqueue(async () => {
      await this.store.update((s) => {
        const n = s.novels.find((n) => n.id === id);
        if (n) s.retired[id] = n;
        s.novels = s.novels.filter((n) => n.id !== id);
      });
      this.changed();
      return this.snapshot();
    });
  }
  async setNovelNotifications(id, policy) {
    const validated =
      policy === null ? null : validatePolicy(policy, { allowSound: false });
    return this.enqueue(async () => {
      if (!this.store.state.novels.some((n) => n.id === id))
        throw new Error("Новелла не найдена.");
      await this.store.update((s) => {
        s.novels.find((n) => n.id === id).statusNotifications = validated;
      });
      this.changed();
      return this.snapshot();
    });
  }
  check(id, { automatic = false } = {}) {
    const pending = this.pending.get(id);
    if (pending) {
      if (!automatic) pending.force = true;
      return pending.promise;
    }
    const ticket = { force: !automatic, promise: null };
    const job = this.enqueue(() => {
      const state = this.store.state;
      const novel = state.novels.find((n) => n.id === id);
      if (
        !ticket.force &&
        (state.paused || !state.root || !novel || novel.nextCheck > Date.now())
      )
        return this.snapshot();
      return this.performCheck(id);
    });
    ticket.promise = job;
    this.pending.set(id, ticket);
    job.finally(() => this.pending.delete(id)).catch(() => {});
    return job;
  }
  async performCheck(id) {
    const state = this.store.state;
    if (!state.root) throw new Error("Выберите папку архива.");
    const existing = state.novels.find((n) => n.id === id);
    if (!existing) return this.snapshot();
    let novel = structuredClone(existing),
      errors = [],
      newCount = 0,
      retryAfter = 0,
      currentHash,
      statusChange;
    this.busy.add(id);
    this.changed();
    try {
      const page = (
        await this.fetchResource(novel.url, { kind: "page" })
      ).toString("utf8");
      statusChange = observeStatus(novel, extractStatus(page));
      const data = extractNovel(page, novel.url);
      novel.title = data.title;
      if (statusChange) statusChange.title = novel.title;
      novel.folder ||= safeFolder(novel.title, id);
      novel.sources = data.sources;
      // Commit the stable location before any PNG can outlive this check.
      if (!existing.folder)
        await this.store.update((s) => {
          const target = s.novels.find((n) => n.id === id);
          if (target)
            Object.assign(target, {
              title: novel.title,
              folder: novel.folder,
              sources: novel.sources,
            });
        });
      const recovered = await this.archive.recover(novel, state.root);
      for (const entry of recovered)
        if (
          !novel.history.some(
            (e) => e.hash === entry.hash && e.file === entry.file,
          )
        )
          novel.history.push(entry);
      for (const source of data.sources) {
        try {
          const buffer = await this.fetchResource(source.url, {
              kind: "image",
            }),
            image = await this.decode(buffer);
          const result = await this.archive.save(
            novel,
            source,
            image,
            state.root,
          );
          novel.history = novel.history.filter(
            (e) => e.hash !== result.entry.hash,
          );
          novel.history.push(result.entry);
          currentHash ||= result.entry.hash;
          novel.latestHash = currentHash;
          if (result.saved) newCount++;
        } catch (e) {
          errors.push(
            `${source.kind === "original" ? "Оригинал" : "Обложка"}: ${e.message}`,
          );
          retryAfter = Math.max(retryAfter, e.retryAfterMs || 0);
        }
      }
    } catch (e) {
      errors.push(e.message);
      retryAfter = Math.max(retryAfter, e.retryAfterMs || 0);
    }
    try {
      novel.lastCheck = new Date().toISOString();
      novel.error = errors.join("\n");
      novel.failures = errors.length ? (novel.failures || 0) + 1 : 0;
      const delay = errors.length
        ? Math.max(
            retryAfter,
            Math.min(
              state.interval * 60000,
              60000 * 2 ** Math.min(novel.failures - 1, 10),
            ),
          )
        : state.interval * 60000;
      novel.nextCheck = Date.now() + delay;
      novel.lastSaved = newCount;
      await this.store.update((s) => {
        const i = s.novels.findIndex((n) => n.id === id);
        if (i >= 0) s.novels[i] = novel;
      });
      if (
        statusChange &&
        shouldNotify(
          this.store.state.statusNotifications,
          novel.statusNotifications,
          statusChange.to,
        )
      )
        this.emit("status-changed", statusChange);
      if (newCount)
        this.emit("saved", { id, title: novel.title, count: newCount });
      return this.snapshot();
    } finally {
      this.busy.delete(id);
      this.changed();
    }
  }
  async checkAll() {
    for (const { id } of this.store.state.novels) await this.check(id);
    return this.snapshot();
  }
  async tick() {
    if (this.ticking || this.store.state.paused || !this.store.state.root)
      return;
    this.ticking = true;
    try {
      for (const n of this.store.state.novels) {
        if (this.store.state.paused || !this.store.state.root) break;
        if ((n.nextCheck || 0) <= Date.now())
          await this.check(n.id, { automatic: true });
      }
    } finally {
      this.ticking = false;
    }
  }
}
module.exports = { Monitor };
