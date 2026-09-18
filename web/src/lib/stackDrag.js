// Pure stack drag-drop decisions (no React/DOM). Covered by
// test/unit/stack-drag.test.mjs — keep the two in sync.

// Move a block of keys as one unit to before/after a target key in `vis`
// order. Returns the new order, or null when the move is a no-op/invalid.
export function moveKeys(vis, dragKeys, targetKey, after = false) {
  const set = new Set(dragKeys || []);
  if (!set.size || !targetKey || set.has(targetKey)) return null;
  if (!vis.includes(targetKey) || ![...set].every((k) => vis.includes(k))) return null;
  const orderedDrag = vis.filter((k) => set.has(k));
  const next = vis.filter((k) => !set.has(k));
  const idx = next.indexOf(targetKey) + (after ? 1 : 0);
  next.splice(idx, 0, ...orderedDrag);
  return next;
}

// Map a drop X (relative to the pile's left edge) across the pile width to
// an intra-pile index in 0..memberCount.
export function pileDropIndex(x, width, memberCount) {
  const n = Math.max(0, memberCount | 0);
  if (!n) return 0;
  const idx = Math.round((x / Math.max(1, width)) * n);
  return Math.max(0, Math.min(n, idx));
}

// Resolve the custom-order move inserting `outsiders` at `index`
// (0..mem.length) among member keys `mem` in visible order.
// Returns { target, after } or null when there is nothing to position.
export function pileInsertTarget(mem, outsiders, index) {
  const members = Array.isArray(mem) ? mem : [];
  const outside = (Array.isArray(outsiders) ? outsiders : []).filter((k) => !members.includes(k));
  if (!members.length || !outside.length) return null;
  const idx = Math.max(0, Math.min(members.length, index | 0));
  if (idx >= members.length) return { target: members[members.length - 1], after: true };
  return { target: members[idx], after: false };
}

// Decide stack removals for dragged `keys` dropped on `infoKey`
// (null = outside any tile). stackOf(key) owns each key to a stack id;
// membersOf(stackId) lists that stack's member keys. Locked mode never
// detaches; without a spread pile only open-all mode detaches (collapsed
// piles hide their members, so there is nothing to drag out).
export function planDetach({ keys, infoKey, pilesLocked, spreadStackId, stacksMode, stackOf, membersOf }) {
  if (pilesLocked) return [];
  const list = Array.isArray(keys) ? keys : [];
  if (spreadStackId) {
    const mem = membersOf(spreadStackId) || [];
    const dragged = list.filter((k) => mem.includes(k));
    if (!dragged.length) return [];
    if (infoKey && mem.includes(infoKey)) return [];
    return [{ stackId: spreadStackId, keys: dragged }];
  }
  if (stacksMode === "open") {
    const byStack = new Map();
    for (const k of list) {
      const sid = stackOf(k);
      if (!sid) continue;
      if (!byStack.has(sid)) byStack.set(sid, []);
      byStack.get(sid).push(k);
    }
    const out = [];
    for (const [sid, dragged] of byStack) {
      const mem = membersOf(sid) || [];
      if (infoKey && mem.includes(infoKey)) continue;
      out.push({ stackId: sid, keys: dragged });
    }
    return out;
  }
  return [];
}

// Which member to select when keyboard-navigating onto a pile from `dir`.
// Unlocked piles spread open, so land on the nearest edge (first from
// left/above, last from right/below). Locked piles stay collapsed, so
// always land on the first member.
export function pileLandMember(members, dir, locked) {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return undefined;
  if (locked) return list[0];
  return dir === "left" || dir === "up" ? list[list.length - 1] : list[0];
}

// Decide what happens when `keys` are dropped onto pile `stackId` at
// horizontal offset `x` of a `width`-wide pile. Returns null when the drop
// changes nothing (locked mode, unknown stack, nothing new); otherwise
// { addKeys, move } where move ({ target, after } | null) positions the
// block in custom order — null means plain append (non-custom sort).
export function planJoin({ keys, stackId, pilesLocked, customReorder, x, width, membersOf }) {
  if (pilesLocked || !stackId) return null;
  const mem = membersOf(stackId) || [];
  const addKeys = (Array.isArray(keys) ? keys : []).filter((k) => !mem.includes(k));
  if (!addKeys.length) return null;
  let move = null;
  if (customReorder && mem.length) {
    move = pileInsertTarget(mem, addKeys, pileDropIndex(x, width, mem.length));
  }
  return { addKeys, move };
}
