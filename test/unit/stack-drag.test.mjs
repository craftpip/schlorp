import test from "node:test";
import assert from "node:assert/strict";

import {
  moveKeys,
  pileDropIndex,
  pileInsertTarget,
  pileLandMember,
  planDetach,
  planJoin,
} from "../../web/src/lib/stackDrag.js";

// Blob of members shared by the detach/join fixtures.
const stackOf = (k) => ({ a: "s1", b: "s1", c: "s2" }[k] ?? null);
const membersOf = (sid) => ({ s1: ["a", "b"], s2: ["c"] }[sid] ?? []);

test("moveKeys: single file before/after a target", () => {
  assert.deepEqual(moveKeys(["a", "b", "c"], ["c"], "a"), ["c", "a", "b"]);
  assert.deepEqual(moveKeys(["a", "b", "c"], ["a"], "c", true), ["b", "c", "a"]);
});

test("moveKeys: block keeps visible order and moves as one unit", () => {
  assert.deepEqual(
    moveKeys(["a", "b", "c", "d"], ["d", "b"], "c"),
    ["a", "b", "d", "c"]
  );
});

test("moveKeys: invalid drops are null (no state change)", () => {
  assert.equal(moveKeys(["a", "b"], [], "a"), null);
  assert.equal(moveKeys(["a", "b"], ["a"], "a"), null);
  assert.equal(moveKeys(["a", "b"], ["b"], "zzz"), null);
  assert.equal(moveKeys(["a", "b"], ["zzz"], "a"), null);
});

test("pileDropIndex: left edge is front, right edge is end, clamped", () => {
  assert.equal(pileDropIndex(0, 100, 3), 0);
  assert.equal(pileDropIndex(100, 100, 3), 3);
  assert.equal(pileDropIndex(50, 100, 4), 2);
  assert.equal(pileDropIndex(-20, 100, 3), 0);
  assert.equal(pileDropIndex(999, 100, 3), 3);
  assert.equal(pileDropIndex(50, 100, 0), 0);
});

test("pileInsertTarget: drop index resolves to before/after a member", () => {
  const mem = ["a", "b", "c"];
  assert.deepEqual(pileInsertTarget(mem, ["x"], 0), { target: "a", after: false });
  assert.deepEqual(pileInsertTarget(mem, ["x"], 1), { target: "b", after: false });
  assert.deepEqual(pileInsertTarget(mem, ["x"], 3), { target: "c", after: true });
  assert.deepEqual(pileInsertTarget(mem, ["x"], 99), { target: "c", after: true });
});

test("pileInsertTarget: nothing to position is null", () => {
  assert.equal(pileInsertTarget([], ["x"], 0), null);
  assert.equal(pileInsertTarget(["a"], [], 0), null);
  assert.equal(pileInsertTarget(["a"], ["a"], 0), null);
});

test("pileLandMember: locked stack always lands on the first member", () => {
  const members = ["a", "b", "c"];
  for (const dir of ["left", "right", "up", "down"]) {
    assert.equal(pileLandMember(members, dir, true), "a");
  }
});

test("pileLandMember: unlocked stack lands on the nearest edge", () => {
  const members = ["a", "b", "c"];
  assert.equal(pileLandMember(members, "right", false), "a");
  assert.equal(pileLandMember(members, "down", false), "a");
  assert.equal(pileLandMember(members, "left", false), "c");
  assert.equal(pileLandMember(members, "up", false), "c");
  assert.equal(pileLandMember([], "right", false), undefined);
});

test("planDetach: locked mode never detaches", () => {
  assert.deepEqual(
    planDetach({ keys: ["a"], infoKey: "z", pilesLocked: true, spreadStackId: "s1", stacksMode: "stacked", stackOf, membersOf }),
    []
  );
  assert.deepEqual(
    planDetach({ keys: ["a"], infoKey: "z", pilesLocked: true, spreadStackId: null, stacksMode: "open", stackOf, membersOf }),
    []
  );
});

test("planDetach: spread member leaving the open pile detaches, staying keeps", () => {
  const base = { pilesLocked: false, spreadStackId: "s1", stacksMode: "stacked", stackOf, membersOf };
  assert.deepEqual(
    planDetach({ ...base, keys: ["a"], infoKey: "z" }),
    [{ stackId: "s1", keys: ["a"] }]
  );
  assert.deepEqual(planDetach({ ...base, keys: ["a"], infoKey: "b" }), []);
  assert.deepEqual(
    planDetach({ ...base, keys: ["a"], infoKey: null }),
    [{ stackId: "s1", keys: ["a"] }]
  );
  assert.deepEqual(planDetach({ ...base, keys: ["c"], infoKey: "z" }), []);
});

test("planDetach: open-all mode detaches per owning stack", () => {
  const base = { pilesLocked: false, spreadStackId: null, stacksMode: "open", stackOf, membersOf };
  assert.deepEqual(
    planDetach({ ...base, keys: ["a"], infoKey: "z" }),
    [{ stackId: "s1", keys: ["a"] }]
  );
  assert.deepEqual(planDetach({ ...base, keys: ["a"], infoKey: "b" }), []);
  assert.deepEqual(
    planDetach({ ...base, keys: ["a", "c"], infoKey: "z" }),
    [{ stackId: "s1", keys: ["a"] }, { stackId: "s2", keys: ["c"] }]
  );
  assert.deepEqual(planDetach({ ...base, keys: ["zzz"], infoKey: "z" }), []);
});

test("planDetach: collapsed pile (stacked, no spread) detaches nothing", () => {
  assert.deepEqual(
    planDetach({ keys: ["a"], infoKey: "z", pilesLocked: false, spreadStackId: null, stacksMode: "stacked", stackOf, membersOf }),
    []
  );
});

test("planJoin: locked mode and no-op drops are null", () => {
  const base = { customReorder: true, x: 0, width: 100, membersOf };
  assert.equal(planJoin({ ...base, keys: ["x"], stackId: "s1", pilesLocked: true }), null);
  assert.equal(planJoin({ ...base, keys: ["x"], stackId: "", pilesLocked: false }), null);
  assert.equal(planJoin({ ...base, keys: ["a", "b"], stackId: "s1", pilesLocked: false }), null);
});

test("planJoin: drop position decides the insert slot, not the end", () => {
  const base = { customReorder: true, width: 100, membersOf, pilesLocked: false };
  assert.deepEqual(planJoin({ ...base, keys: ["x"], stackId: "s1", x: 0 }), {
    addKeys: ["x"],
    move: { target: "a", after: false },
  });
  assert.deepEqual(planJoin({ ...base, keys: ["x"], stackId: "s1", x: 100 }), {
    addKeys: ["x"],
    move: { target: "b", after: true },
  });
});

test("planJoin: non-custom sort appends (no positioning)", () => {
  assert.deepEqual(
    planJoin({ keys: ["x"], stackId: "s1", pilesLocked: false, customReorder: false, x: 0, width: 100, membersOf }),
    { addKeys: ["x"], move: null }
  );
});

test("planJoin: only outsiders are added", () => {
  assert.deepEqual(
    planJoin({ keys: ["a", "x"], stackId: "s1", pilesLocked: false, customReorder: true, x: 100, width: 100, membersOf }),
    { addKeys: ["x"], move: { target: "b", after: true } }
  );
});
