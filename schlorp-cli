#!/usr/bin/env node
require("dotenv").config({ quiet: true });
const { run } = require("./scan-videos/index");

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
