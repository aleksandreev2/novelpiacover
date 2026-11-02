const { test } = require("node:test");
const assert = require("node:assert/strict");
const { temporary } = require("./helpers.cjs");
const { Store } = require("../src/store.cjs");
const legacyTargets = ["completed", "discontinued", "ongoing"];
test("upgrade adds the missing delayed state only to legacy all-status policies", async (t) => {
  const root = await temporary(t),
    store = await Store.open(root);
  await store.update((s) => {
    delete s.statusPolicyVersion;
    s.statusNotifications = {
      enabled: false,
      targets: [...legacyTargets],
      sound: false,
    };
    s.novels = [
      {
        id: "1",
        statusNotifications: { enabled: true, targets: [...legacyTargets] },
      },
      {
        id: "2",
        statusNotifications: { enabled: true, targets: ["completed"] },
      },
    ];
    s.retired = {
      3: {
        id: "3",
        statusNotifications: { enabled: false, targets: [...legacyTargets] },
      },
    };
  });
  const upgraded = (await Store.open(root)).state;
  assert.equal(upgraded.statusPolicyVersion, 2);
  assert.equal(upgraded.statusNotifications.enabled, false);
  assert.equal(upgraded.statusNotifications.sound, false);
  assert.ok(upgraded.statusNotifications.targets.includes("delayed"));
  assert.ok(upgraded.novels[0].statusNotifications.targets.includes("delayed"));
  assert.deepEqual(upgraded.novels[1].statusNotifications.targets, [
    "completed",
  ]);
  assert.ok(
    upgraded.retired["3"].statusNotifications.targets.includes("delayed"),
  );
  assert.equal(upgraded.retired["3"].statusNotifications.enabled, false);
});
test("a saved decision to disable delayed alerts is not reversed on restart", async (t) => {
  const root = await temporary(t),
    store = await Store.open(root);
  await store.update((s) => {
    s.statusPolicyVersion = 2;
    s.statusNotifications = {
      enabled: true,
      targets: [...legacyTargets],
      sound: true,
    };
  });
  const reopened = (await Store.open(root)).state;
  assert.deepEqual(reopened.statusNotifications.targets, legacyTargets);
});
