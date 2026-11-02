"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { defaultPolicy } = require("./status.cjs");
async function atomicWrite(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data, { flag: "wx" });
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
function defaults() {
  return {
    version: 1,
    root: "",
    interval: 30,
    paused: false,
    login: false,
    notifications: true,
    statusNotifications: defaultPolicy(),
    statusPolicyVersion: 2,
    novels: [],
    retired: {},
  };
}
class Store {
  constructor(directory, state, recovered = false) {
    this.directory = directory;
    this.state = state;
    this.recovered = recovered;
  }
  static async open(directory) {
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "settings.json");
    for (const [i, candidate] of [file, file + ".bak"].entries()) {
      try {
        const s = JSON.parse(await fs.readFile(candidate, "utf8"));
        if (s.version !== 1 || !Array.isArray(s.novels) || !s.retired)
          throw new Error("Неподдерживаемые настройки.");
        if ((s.statusPolicyVersion || 1) < 2) {
          const legacy = ["completed", "discontinued", "ongoing"];
          const migrate = (policy) =>
            policy &&
            Array.isArray(policy.targets) &&
            policy.targets.length === legacy.length &&
            legacy.every((status) => policy.targets.includes(status))
              ? { ...policy, targets: [...policy.targets, "delayed"] }
              : policy;
          if (s.statusNotifications)
            s.statusNotifications = migrate(s.statusNotifications);
          for (const novel of [...s.novels, ...Object.values(s.retired)])
            if (novel?.statusNotifications)
              novel.statusNotifications = migrate(novel.statusNotifications);
          s.statusPolicyVersion = 2;
        }
        return new Store(directory, { ...defaults(), ...s }, i === 1);
      } catch (e) {
        if (
          i === 0 &&
          e.code === "ENOENT" &&
          !(await fs.stat(file + ".bak").catch(() => null))
        )
          return new Store(directory, defaults());
        if (i === 1)
          throw new Error(
            "Не удалось прочитать настройки и резервную копию. Ваш архив PNG сохранён. Файлы настроек: " +
              directory,
          );
      }
    }
  }
  async update(fn) {
    const next = structuredClone(this.state);
    fn(next);
    const file = path.join(this.directory, "settings.json");
    // Back up the last valid in-memory version, never a possibly damaged primary.
    if (await fs.stat(file).catch(() => null))
      await atomicWrite(file + ".bak", JSON.stringify(this.state, null, 2));
    await atomicWrite(file, JSON.stringify(next, null, 2));
    this.state = next;
    return next;
  }
}
module.exports = { Store, atomicWrite };
