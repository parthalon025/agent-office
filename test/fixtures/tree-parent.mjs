// Stand-in office for test/office-server-fixture.test.mjs (#161): says it is open and starts a child of its own,
// like the server starts git. env TREE_PID_FILE is the file that gets the child's pid.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
fs.writeFileSync(process.env.TREE_PID_FILE, String(c.pid));
console.log('Agent Office is open: stand-in');
setInterval(() => {}, 1000);
