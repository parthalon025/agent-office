/* Agent Office for Claude Code x0.2: the ask-first protocol.
   Some calls need the user's yes before they run: merge, fork, skill, cost, goal, handoff, runtime, memory, write (the server asks), and pull request
   and remove (the page asks before it calls). One Module owns both sides, so a ninth kind is one row in KINDS:
     build side (server):  OfficeAsk.answer(kind, text, extra) -> { status, body }   the first call, before it runs
     read side (page):     OfficeAsk.asked(x, kind, confirmed) -> { text, body } | null   x is the Error a client command rejects with
   The page then sends the same call again with its confirmation flag (`confirmed: true`; `confirmCost: true` for cost).
   A cost question is a normal answer (200 { confirm, question }, no error); every other server kind is 409 { error, confirm }.
   Plain script, no I/O: the page loads it as a script (window.OfficeAsk); the server and the tests import it for its side
   effect and read globalThis.OfficeAsk. */
(function (root) {
  'use strict';
  var KINDS = Object.freeze({
    merge: { status: 409 },
    fork: { status: 409 },
    skill: { status: 409 },
    goal: { status: 409 },
    handoff: { status: 409 },
    memory: { status: 409 },                 // forgetting one company memory (#205): it is gone for good
    write: { status: 409 },                  // a Paperclip write the HQ write grid says Confirm for (#198); the answer names the write
    runtime: { status: 409 },                // installing the Paperclip runtime (#193): downloads packages and runs their install scripts
    cost: { status: 200, question: true },   // not an error: the page logs no failed request each time it asks
    pr: { local: true },                     // the page asks in its own dialog, then makes the call
    rm: { local: true },
  });
  function kindOf(kind) {
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) throw new Error('Unknown ask-first kind: ' + kind);
    return KINDS[kind];
  }
  // The answer a route sends for a call that needs the user's yes. extra: fields the question shows (handoff: the tasks).
  function answer(kind, text, extra) {
    var k = kindOf(kind);
    if (k.local) throw new Error('The page asks the ' + kind + ' question itself.');
    if (k.question) return { status: k.status, body: { confirm: kind, question: text } };
    return { status: k.status, body: Object.assign({ error: text, confirm: kind }, extra || {}) };
  }
  // True for a 200 body that is a question and not a result (client.js turns it into an Error).
  function isQuestion(j) { return !!(j && j.confirm && j.question); }
  // The question of a rejected call, when it is this kind and the user has not said yes yet. Else null: the caller shows the error.
  function asked(x, kind, confirmed) {
    kindOf(kind);
    var b = x && x.body;
    if (confirmed === true || !b || b.confirm !== kind) return null;
    return { text: x.message, body: b };
  }
  // The name of a page-asked kind ('pr', 'rm'), checked against the table.
  function local(kind) { if (!kindOf(kind).local) throw new Error(kind + ' is asked by the server.'); return kind; }
  root.OfficeAsk = { KINDS: KINDS, answer: answer, isQuestion: isQuestion, asked: asked, local: local };
})(typeof globalThis !== 'undefined' ? globalThis : window);
