// Write kind `access` (#213, ADR 0010, owner only: the page group is the owner's, and this cell decides): create or revoke an invite,
// approve or reject a join request, change a member's role or status. Each names its invite, join request or member as a target; the
// writer reads the company's lists and refuses what is not in them (404), an invite that is not active or a request that waits for no
// decision (409). The answer of an invite is its id, never the invite token or link: a link that lets people in stays in Paperclip.
// GET /api/hq/access (paperclip.mjs hq.access(): invites, join requests and members as names, roles and states, read through the invites,
// joinRequests and members shapes) feeds `Access` in public/hq.js and those checks.
import { RULES, gridError, idOf, textOf, SAMPLE as S } from './shared.mjs';

export const JOIN_TYPES = ['human', 'agent', 'both'], HUMAN_ROLES = ['owner', 'admin', 'operator', 'viewer'], MEMBER_STATUS = ['pending', 'active', 'suspended'];

export default {
  kind: 'access', label: 'Invites and access', options: RULES, def: 'confirm',
  actions: {
    invite(b) {
      const join = b.allowedJoinTypes === undefined || b.allowedJoinTypes === null ? 'both' : b.allowedJoinTypes;
      if (!JOIN_TYPES.includes(join)) throw gridError(400, 'Choose who may join: people, agents or both.');
      const body = { allowedJoinTypes: join };
      if (b.humanRole !== undefined && b.humanRole !== null && b.humanRole !== '') {
        if (!HUMAN_ROLES.includes(b.humanRole) || b.humanRole === 'owner') throw gridError(400, 'Choose a role: admin, operator or viewer.');
        body.humanRole = b.humanRole;
      }
      const message = textOf(b.agentMessage, 'message', 1000);
      if (message) body.agentMessage = message;
      const who = { human: 'people', agent: 'agents', both: 'people and agents' }[join];
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/invites`, body, targets: [], summary: `Create an invite for ${who}${body.humanRole ? ` as ${body.humanRole}` : ''}` };
    },
    revoke(b) {
      const invite = idOf(b.invite, 'invite');
      return { method: 'POST', path: () => `/api/invites/${invite}/revoke`, body: {}, targets: [{ type: 'invite', id: invite }], summary: 'Revoke an invite' };
    },
    approveJoin(b) {
      const join = idOf(b.join, 'join request');
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/join-requests/${join}/approve`, body: {}, targets: [{ type: 'join', id: join }], summary: 'Approve a join request' };
    },
    rejectJoin(b) {
      const join = idOf(b.join, 'join request');
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/join-requests/${join}/reject`, body: {}, targets: [{ type: 'join', id: join }], summary: 'Reject a join request' };
    },
    member(b) {
      const member = idOf(b.member, 'member'), body = {};
      if (b.role !== undefined && b.role !== null) { if (!HUMAN_ROLES.includes(b.role)) throw gridError(400, 'Choose a role: owner, admin, operator or viewer.'); body.membershipRole = b.role; }
      if (b.status !== undefined && b.status !== null) { if (!MEMBER_STATUS.includes(b.status)) throw gridError(400, 'Choose a status: pending, active or suspended.'); body.status = b.status; }
      if (!Object.keys(body).length) throw gridError(400, 'Give a role or a status.');
      return { method: 'PATCH', path: (co) => `/api/companies/${encodeURIComponent(co)}/members/${member}`, body, targets: [{ type: 'member', id: member }], summary: `Change the access of a member${body.membershipRole ? ` to ${body.membershipRole}` : ''}${body.status ? ` (${body.status})` : ''}` };
    },
  },
  expect: (plan, made) => (plan.action === 'invite' && !made.id ? 'Paperclip did not name the invite it made' : ''),
  result: (plan, made) => (plan.action === 'invite' ? { id: String(made.id) } : {}),
  samples: {
    invite: {
      body: { kind: 'access', action: 'invite', allowedJoinTypes: 'both', humanRole: 'viewer', agentMessage: 'hi' },
      request: { method: 'POST', path: `/api/companies/${S.co}/invites`, body: { allowedJoinTypes: 'both', humanRole: 'viewer', agentMessage: 'hi' } },
      answer: { id: S.invite, token: 'pcp_invite_never_shown', inviteUrl: 'http://127.0.0.1:3100/invite/never-shown' },
      result: { ok: true, id: S.invite },
    },
    revoke: {
      body: { kind: 'access', action: 'revoke', invite: S.invite },
      request: { method: 'POST', path: `/api/invites/${S.invite}/revoke`, body: {} },
      answer: { id: S.invite, state: 'revoked' },
      result: { ok: true },
    },
    approveJoin: {
      body: { kind: 'access', action: 'approveJoin', join: S.join },
      request: { method: 'POST', path: `/api/companies/${S.co}/join-requests/${S.join}/approve`, body: {} },
      answer: { id: S.join, status: 'approved' },
      result: { ok: true },
    },
    rejectJoin: {
      body: { kind: 'access', action: 'rejectJoin', join: S.join },
      request: { method: 'POST', path: `/api/companies/${S.co}/join-requests/${S.join}/reject`, body: {} },
      answer: { id: S.join, status: 'rejected' },
      result: { ok: true },
    },
    member: {
      body: { kind: 'access', action: 'member', member: S.member, role: 'viewer', status: 'active' },
      request: { method: 'PATCH', path: `/api/companies/${S.co}/members/${S.member}`, body: { membershipRole: 'viewer', status: 'active' } },
      answer: { id: S.member, membershipRole: 'viewer', status: 'active' },
      result: { ok: true },
    },
  },
};
