// S5 throwaway: like hello.js but stays alive so we can inspect its window while it runs.
const fs = require("fs");
const path = require("path");
const out = path.join(process.env.TEMP, "conductor-s5-autostart.log");
fs.appendFileSync(out, `${new Date().toISOString()} sleeper started pid=${process.pid}\n`);
setTimeout(() => {
  fs.appendFileSync(out, `${new Date().toISOString()} sleeper exit pid=${process.pid}\n`);
}, 15000);
