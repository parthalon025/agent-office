// Write kind `secret` (ADR 0010): its cell of the write grid only. No write is planned yet, so every secret write is 400 and nothing is
// sent. A secret never takes Allow: the cell offers Confirm and Deny (CODING_STANDARDS.md, Writes).
export default {
  kind: 'secret', label: 'Secrets', options: ['confirm', 'deny'], def: 'confirm',
  actions: {},
  samples: {},
};
