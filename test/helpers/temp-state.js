const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const savedEnv = new Map();

function saveEnv(names) {
  for (const name of names) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  }
}

function restoreEnv(names) {
  for (const name of names) {
    if (!savedEnv.has(name)) continue;
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    savedEnv.delete(name);
  }
}

function setEnv(overrides) {
  saveEnv(Object.keys(overrides));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xdl-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withTempEnv(fn, overrides) {
  setEnv(overrides || {});
  try {
    return await fn();
  } finally {
    restoreEnv(Object.keys(overrides || {}));
  }
}

module.exports = { withTempDir, withTempEnv, setEnv, restoreEnv };