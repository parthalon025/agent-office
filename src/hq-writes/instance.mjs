// Write kind `instance` (#221, ADR 0010, owner only: Paperclip needs an instance admin for each). The office changes only what it can show
// and undo: the two general settings, one environment's name, description and status, and the instance's default environment. It makes
// and deletes no environment (a sandbox, an ssh host or a plugin: those hold credentials and leases) and never sends a config or env value.
// An environment is a target: the writer reads the instance's environments and refuses one that is not there (404). GET /api/hq/instance
// (page group, paperclip.mjs instance(): the settings and the environments by name and state) is the read the HQ shows.
import { RULES, gridError, idOf, textOf, NAME_MAX, DESC_MAX, SAMPLE as S } from './shared.mjs';

export const FEEDBACK_SHARING = ['allowed', 'not_allowed', 'prompt'], ENVIRONMENT_STATUS = ['active', 'archived'];

export default {
  kind: 'instance', label: 'Instance and environments', options: RULES, def: 'confirm',
  actions: {
    general(b) {
      const body = {};
      if (b.censorUsernameInLogs !== undefined) { if (typeof b.censorUsernameInLogs !== 'boolean') throw gridError(400, 'Hiding the user name must be on or off.'); body.censorUsernameInLogs = b.censorUsernameInLogs; }
      if (b.feedbackDataSharingPreference !== undefined) { if (!FEEDBACK_SHARING.includes(b.feedbackDataSharingPreference)) throw gridError(400, 'Choose: allowed, not allowed or ask each time.'); body.feedbackDataSharingPreference = b.feedbackDataSharingPreference; }
      if (!Object.keys(body).length) throw gridError(400, 'Give a setting to change.');
      const what = [body.censorUsernameInLogs !== undefined && 'user name in logs', body.feedbackDataSharingPreference !== undefined && 'feedback sharing'].filter(Boolean).join(', ');
      return { method: 'PATCH', path: () => '/api/instance/settings/general', body, targets: [], summary: `Change the Paperclip instance settings (${what})` };
    },
    defaultEnvironment(b) {
      const none = b.environment === undefined || b.environment === null || b.environment === '';
      const env = none ? null : idOf(b.environment, 'environment');
      return { method: 'PATCH', path: () => '/api/instance/settings', body: { defaultEnvironmentId: env }, targets: env ? [{ type: 'environment', id: env }] : [], summary: env ? 'Set the default environment' : 'Clear the default environment' };
    },
    environment(b) {
      const environment = idOf(b.environment, 'environment'), body = {};
      if (b.name !== undefined) body.name = textOf(b.name, 'environment name', NAME_MAX, { required: true });
      if (b.description !== undefined) body.description = b.description === null ? null : textOf(b.description, 'description', DESC_MAX);
      if (b.status !== undefined) { if (!ENVIRONMENT_STATUS.includes(b.status)) throw gridError(400, 'Choose a status: active or archived.'); body.status = b.status; }
      if (!Object.keys(body).length) throw gridError(400, 'Give something to change.');
      const what = body.status && Object.keys(body).length === 1 ? (body.status === 'archived' ? 'Archive an environment' : 'Restore an environment') : 'Change an environment';
      return { method: 'PATCH', path: () => `/api/environments/${environment}`, body, targets: [{ type: 'environment', id: environment }], summary: what };
    },
  },
  samples: {
    general: {
      body: { kind: 'instance', action: 'general', censorUsernameInLogs: true, feedbackDataSharingPreference: 'prompt' },
      request: { method: 'PATCH', path: '/api/instance/settings/general', body: { censorUsernameInLogs: true, feedbackDataSharingPreference: 'prompt' } },
      answer: { censorUsernameInLogs: true, feedbackDataSharingPreference: 'prompt' },
      result: { ok: true },
    },
    defaultEnvironment: {
      body: { kind: 'instance', action: 'defaultEnvironment', environment: S.environment },
      request: { method: 'PATCH', path: '/api/instance/settings', body: { defaultEnvironmentId: S.environment } },
      answer: { id: 'is1', defaultEnvironmentId: S.environment, general: {} },
      result: { ok: true },
    },
    environment: {
      body: { kind: 'instance', action: 'environment', environment: S.environment, name: 'E', description: 'D', status: 'archived' },
      request: { method: 'PATCH', path: `/api/environments/${S.environment}`, body: { name: 'E', description: 'D', status: 'archived' } },
      answer: { id: S.environment, name: 'E', status: 'archived' },
      result: { ok: true },
    },
  },
};
