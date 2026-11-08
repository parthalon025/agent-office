// Write kind `comment` (#198, ADR 0010): one comment on a task of the connected company. Allow by default: the user's own comments.
import { RULES, idOf, textOf, TEXT_MAX, SAMPLE as S } from './shared.mjs';

export default {
  kind: 'comment', label: 'Comments', options: RULES, def: 'allow',
  actions: {
    add(b) {
      const issue = idOf(b.issue, 'task'), text = textOf(b.text, 'comment', TEXT_MAX, { required: true });
      return { method: 'POST', path: () => `/api/issues/${issue}/comments`, body: { body: text }, targets: [{ type: 'issue', id: issue }], summary: 'Comment on a task' };
    },
  },
  samples: {
    add: {
      body: { kind: 'comment', action: 'add', issue: S.issue, text: 'hello' },
      request: { method: 'POST', path: `/api/issues/${S.issue}/comments`, body: { body: 'hello' } },
      answer: { id: 'cm1', issueId: S.issue, body: 'hello' },
      result: { ok: true },
    },
  },
};
