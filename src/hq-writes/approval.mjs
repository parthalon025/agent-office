// Write kind `approval` (#198, ADR 0010): approve, reject or ask for a revision of a Paperclip approval, with an optional note. The writer
// reads the approval first: it must be of the connected company and wait for a decision. Self-approval (hq-model.mjs, #203) sends its
// approvals through this kind too, so a Deny in this cell still wins.
import { RULES, idOf, textOf, NOTE_MAX, SAMPLE as S } from './shared.mjs';

// One decision: POST /api/approvals/:id/<route> with { decisionNote } when there is a note. (The contract test reads the route words
// from the calls below.)
const decision = (action, route, summary) => [action, (b) => {
  const approval = idOf(b.approval, 'approval'), note = textOf(b.note, 'note', NOTE_MAX);
  return { method: 'POST', path: () => `/api/approvals/${approval}/${route}`, body: note ? { decisionNote: note } : {}, targets: [{ type: 'approval', id: approval }], summary };
}];

export default {
  kind: 'approval', label: 'Approvals', options: RULES, def: 'confirm',
  actions: Object.fromEntries([decision('approve', 'approve', 'Approve an approval'), decision('reject', 'reject', 'Reject an approval'), decision('revise', 'request-revision', 'Request a revision of an approval')]),
  samples: {
    approve: {
      body: { kind: 'approval', action: 'approve', approval: S.approval, note: 'n' },
      request: { method: 'POST', path: `/api/approvals/${S.approval}/approve`, body: { decisionNote: 'n' } },
      answer: { id: S.approval, status: 'approved' },
      result: { ok: true },
    },
    reject: {
      body: { kind: 'approval', action: 'reject', approval: S.approval, note: 'n' },
      request: { method: 'POST', path: `/api/approvals/${S.approval}/reject`, body: { decisionNote: 'n' } },
      answer: { id: S.approval, status: 'rejected' },
      result: { ok: true },
    },
    revise: {
      body: { kind: 'approval', action: 'revise', approval: S.approval, note: 'n' },
      request: { method: 'POST', path: `/api/approvals/${S.approval}/request-revision`, body: { decisionNote: 'n' } },
      answer: { id: S.approval, status: 'revision_requested' },
      result: { ok: true },
    },
  },
};
