import test from "node:test";
import assert from "node:assert/strict";
import { passwordBits, patternBits, crackEstimate, formatDuration, WORDS } from "../../web/src/lib/crackTime.js";

test("common and short passwords crack instantly", () => {
  for (const p of ["password", "123456", "test", "qwerty123"]) assert.ok(crackEstimate(passwordBits(p)).seconds < 60, p);
});

test("6 suggested words are strong, 4 are not", () => {
  const six = WORDS.slice(0, 6).join("-");
  const four = WORDS.slice(0, 4).join("-");
  assert.equal(crackEstimate(passwordBits(six)).label, "Strong");
  assert.notEqual(crackEstimate(passwordBits(four)).label, "Strong");
});

test("repeats and runs add little", () => {
  assert.ok(passwordBits("aaaaaaaaaaaa") < passwordBits("k7#Qz!m2Pw@x"));
  assert.ok(passwordBits("abcdefgh1234") < 25);
});

test("simple pattern shapes are weak, complex ones stronger", () => {
  const line = [0, 1, 2, 3, 4, 9, 14, 19]; // top row + down the side: 1 turn
  const twisty = [12, 6, 18, 3, 21, 9, 15, 2, 22, 10];
  assert.equal(crackEstimate(patternBits(line), "pattern").label, "Weak");
  assert.ok(patternBits(twisty) > patternBits(line) + 15);
});

test("durations read naturally", () => {
  assert.equal(formatDuration(0.2), "instantly");
  assert.equal(formatDuration(7200), "about 2 hours");
  assert.match(formatDuration(31557600 * 5e6), /million years/);
  assert.equal(formatDuration(Infinity), "longer than the age of the universe");
});
