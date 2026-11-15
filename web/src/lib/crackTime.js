// Rough "how long to crack" estimates for the panel password and the 5x5
// pattern (plan 040). Worst case: someone stole a drive and guesses offline
// against the vault file. This app's scrypt settings (N=2^17 password, 2^18
// pattern, 128/256 MB each) limit even a strong GPU rig to roughly the rates
// below. Estimates are deliberately conservative about human choices.

export const GUESSES_PER_SEC = { password: 10000, pattern: 5000 };

// Word list used by the "Suggest" button (≈ 7.9 bits per word).
export const WORDS = "acorn amber anchor apple arrow atlas autumn badge bamboo banjo basil beacon berry bison blossom bonfire bracket breeze bronze bubble cabin cactus camel canal candle canoe canyon carbon castle cedar cello chalk cherry chimney cider cobalt cocoa comet compass copper coral cotton coyote crayon cricket crystal daisy desert dolphin domino dragon dune eagle echo ember engine falcon fennel ferry fiddle flame fleece flute fossil fountain galaxy garden garlic gecko geyser ginger glacier granite grape guitar hammer harbor harvest hazel helmet heron honey horizon igloo island ivory jacket jaguar jasmine jungle kayak kettle koala ladder lagoon lantern lemon lilac linen lizard lotus magnet mango maple marble meadow melon meteor mirror mocha moose mosaic muffin napkin nectar nickel nutmeg oasis ocean olive orbit orchid otter oyster paddle panda papaya parrot peach pebble pelican pepper piano pickle pigeon pillow pirate planet plum pocket polar pony poppy prairie pretzel prism pumpkin puzzle quartz quilt rabbit radar raven reef ribbon rocket saddle saffron salmon satin scarf sesame shadow silver sketch sleigh sparrow spruce squid stapler summit sunset swan tablet taco teapot temple thistle thunder tiger timber toast topaz tornado tractor trumpet tulip tundra turnip turtle umbrella valley vanilla velvet violin volcano waffle walnut walrus whale whistle willow window winter wizard wombat yogurt zebra zephyr zipper".split(" ");
const WORD_SET = new Set(WORDS);

// A few of the most common passwords — anything here falls instantly.
const COMMON = new Set("123456 123456789 12345678 password qwerty 111111 12345 1234567 1234567890 123123 abc123 password1 iloveyou admin welcome monkey dragon letmein football baseball sunshine princess master shadow superman qwerty123 test test123 passw0rd trustno1 000000 654321 changeme secret".split(" "));

export function passwordBits(pw) {
  const s = String(pw || "");
  if (!s) return 0;
  const lower = s.toLowerCase();
  if (COMMON.has(lower)) return 3;
  const parts = lower.split(/[\s\-_.]+/).filter(Boolean);
  // Several words: an attacker guesses whole words, not letters.
  if (parts.length >= 2 && parts.every((p) => /^[a-z]+$/.test(p))) {
    const perWord = parts.every((p) => WORD_SET.has(p)) ? Math.log2(WORDS.length) : 11; // ~2000 common words
    return parts.length * perWord;
  }
  if (/^[a-z]+$/.test(lower) && s.length <= 12) return 16; // a single dictionary-ish word
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/\d/.test(s)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(s)) pool += 33;
  // Repeats and runs (aaa, 1234, abcd) add almost nothing.
  let eff = 0;
  for (let i = 0; i < s.length; i++) {
    const d = i ? s.charCodeAt(i) - s.charCodeAt(i - 1) : 99;
    eff += d === 0 || d === 1 || d === -1 ? 0.25 : 1;
  }
  // Human-made strings are far less random than their alphabet suggests.
  return eff * Math.log2(Math.max(pool, 2)) * 0.6;
}

// Pattern on a size×size grid: upper bound = ordered choices of distinct
// dots, then capped hard for simple shapes (few turns), which attackers try
// first.
export function patternBits(dots, size = 5) {
  if (!Array.isArray(dots) || !dots.length) return 0;
  const n = size * size;
  let bits = 0;
  for (let i = 0; i < dots.length; i++) bits += Math.log2(n - i);
  let turns = 0;
  let prevDir = null;
  for (let i = 1; i < dots.length; i++) {
    const dx = Math.sign((dots[i] % size) - (dots[i - 1] % size));
    const dy = Math.sign(Math.floor(dots[i] / size) - Math.floor(dots[i - 1] / size));
    const dir = `${dx},${dy}`;
    if (prevDir !== null && dir !== prevDir) turns += 1;
    prevDir = dir;
  }
  if (turns <= 1) return Math.min(bits, 10); // straight lines / L-shapes
  if (turns <= 3) return Math.min(bits, 18); // letters, borders, zig-zags
  if (turns <= 5) return Math.min(bits, 26);
  return bits * 0.8;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds > 1e18) return "longer than the age of the universe";
  if (seconds < 1) return "instantly";
  const units = [["year", 31557600], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
  if (seconds >= 31557600 * 1000) {
    const y = seconds / 31557600;
    if (y >= 1e9) return `about ${(y / 1e9).toFixed(y >= 1e10 ? 0 : 1)} billion years`;
    if (y >= 1e6) return `about ${(y / 1e6).toFixed(y >= 1e7 ? 0 : 1)} million years`;
    return `about ${Math.round(y / 1000)} thousand years`;
  }
  for (const [name, sec] of units) {
    if (seconds >= sec) {
      const v = Math.round(seconds / sec);
      return `about ${v} ${name}${v === 1 ? "" : "s"}`;
    }
  }
  return "instantly";
}

// Average time to find it = half the search space at the attacker's rate.
export function crackEstimate(bits, kind = "password") {
  const rate = GUESSES_PER_SEC[kind] || GUESSES_PER_SEC.password;
  const seconds = Math.pow(2, bits) / 2 / rate;
  // Weak: under a year. OK: under a century. Strong: longer.
  const tone = seconds < 31557600 ? "#f87171" : seconds < 31557600 * 100 ? "#f59e0b" : "#10b981";
  const label = seconds < 31557600 ? "Weak" : seconds < 31557600 * 100 ? "OK" : "Strong";
  return { bits: Math.round(bits), seconds, text: formatDuration(seconds), tone, label };
}
