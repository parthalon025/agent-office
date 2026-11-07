// A fake headless CLI for test/cli-tools.test.mjs: one process per turn, JSON lines on stdout, like cursor-agent, grok and pi.
// No model, no network, no paid call. The shapes follow what Paperclip's adapters read (cursor-local, grok-local and pi-local
// parse.ts, MIT, see NOTICE.md); they are not a recording of the real tools.
// FAKE_CLI_FAMILY: cursor | grok | pi. The prompt is stdin (cursor), the --single value (grok) or the last argument (pi).
// Prompt "FAIL" ends with the family's error line, "HANG" waits until it is killed, "TOOL" (pi only) runs one tool call.
// FAKE_CLI_LOG: a file where the arguments, the working folder and the prompt are written as one JSON line.
import fs from 'node:fs';

const env = process.env, argv = process.argv.slice(2), family = env.FAKE_CLI_FAMILY || 'cursor';
if (argv.includes('--version')) { process.stdout.write('1.2.3\n'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const run = (prompt) => {
  if (env.FAKE_CLI_LOG) fs.appendFileSync(env.FAKE_CLI_LOG, JSON.stringify({ argv, cwd: process.cwd(), prompt }) + '\n');
  if (prompt === 'HANG') { setInterval(() => {}, 1000); return; }
  const sid = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : 'sess-' + family;
  const usage = { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 5 };
  if (family === 'cursor') {
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model' });
    if (prompt === 'FAIL') { out({ type: 'result', subtype: 'error', is_error: true, session_id: sid, result: 'boom', usage }); process.exit(1); }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo: ' + prompt }] }, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'echo: ' + prompt, usage });
  } else if (family === 'grok') {
    out({ type: 'thought', data: 'thinking' });
    if (prompt === 'FAIL') { out({ type: 'error', error: 'boom' }); process.exit(1); }
    out({ type: 'text', data: 'echo: ' }); out({ type: 'text', data: prompt });
    out({ type: 'end', sessionId: sid, stopReason: 'end_turn', usage });
  } else {
    out({ type: 'agent_start' });
    if (prompt === 'TOOL') {
      out({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
      out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: 'a.txt', isError: false });
    }
    if (prompt === 'FAIL') { out({ type: 'error', message: 'boom' }); process.exit(1); }
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'echo: ' + prompt } });
    out({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + prompt }], usage: { input: 30, output: 12, cacheRead: 5, cost: { total: 0.001 } } } });
    out({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'echo: ' + prompt }] }] });
  }
  process.exit(0);
};
if (family === 'cursor') { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { b += d; }); process.stdin.on('end', () => run(b)); }
else if (family === 'grok') run(argv[argv.indexOf('--single') + 1]);
else run(argv[argv.length - 1]);
