// S5 throwaway: trivial payload for the auto-start test. Appends a line and exits.
const fs = require("fs");
const path = require("path");
const out = path.join(process.env.TEMP, "conductor-s5-autostart.log");
fs.appendFileSync(out, `${new Date().toISOString()} started pid=${process.pid}\n`);
console.log("wrote", out);
