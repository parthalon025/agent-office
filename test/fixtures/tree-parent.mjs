// Stand-in office for test/office-server-fixture.test.mjs (#161): says it is open and starts a child of its own,
// like the server starts git. env TREE_PID_FILE is the file that gets the child's pid. env TREE_PARENT_EXITS makes it
// exit by itself 300 ms later (the office that ends before stop(): its child is orphaned).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
fs.writeFileSync(process.env.TREE_PID_FILE, String(c.pid));
console.log('Agent Office is open: stand-in');
if (process.env.TREE_PARENT_EXITS) setTimeout(() => process.exit(0), 300);
else setInterval(() => {}, 1000);
