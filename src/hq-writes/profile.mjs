// Write kind `profile` (#228, ADR 0010, owner only): the profile of the person the board key signs in as, in Paperclip's own words the
// signed-in user. The office changes the name only: the picture (a large data URL) and the e-mail (Paperclip's sign-in) stay out of reach.
// The route is not company-scoped (routes/auth.ts, mounted at /api/auth: PATCH /profile, strict name 1 to 120 characters) and needs a
// board actor, so the writer names no target. GET /api/hq/profile (page group, paperclip.mjs profile()) is the read the HQ shows.
import { RULES, textOf } from './shared.mjs';

export const PROFILE_NAME_MAX = 120;   // updateCurrentUserProfileSchema: name is 1 to 120 characters after trim

export default {
  kind: 'profile', label: 'Your Paperclip profile', options: RULES, def: 'confirm',
  actions: {
    name(b) {
      const name = textOf(b.name, 'name', PROFILE_NAME_MAX, { required: true });
      return { method: 'PATCH', path: () => '/api/auth/profile', body: { name }, targets: [], summary: `Change your Paperclip profile name to "${name}"`,
        forbidden: 'Paperclip would not change the profile. The board key must belong to a signed-in person.' };
    },
  },
  expect: (plan, made) => (made && made.name === plan.body.name ? '' : 'Paperclip did not save the name'),
  samples: {
    name: {
      body: { kind: 'profile', action: 'name', name: 'Justin' },
      request: { method: 'PATCH', path: '/api/auth/profile', body: { name: 'Justin' } },
      answer: { id: 'u1', email: 'j@example.com', name: 'Justin', image: null },
      result: { ok: true },
    },
  },
};
