import type { Project } from "./Projects.ts";

/**
 * Whose code Calder runs as trusted: each repository's owner, the controller's `trustedPushers`, and on
 * the default branch Calder's own user `bot`, which lands the merge train there. Elsewhere Calder only
 * pushes the base merged into a pull request's branch (Merges.ts `update`), whose code is the pull
 * request's. Code of anyone else, such as the bot `renovate`, runs like a fork's pull request
 * (`RunInput.fork`): in the fork pool, without secrets, deploys or previews, and no trusted run takes its
 * results, plans or records. A pull request's revision runs as one when someone trusted pushed it
 * (Rows.ts `pushed`).
 */
export interface Trusted {
  readonly pushers: ReadonlyArray<string>;
  readonly bot: string;
}

// Gitea's logins are unique regardless of case.
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether `user` is the repository's owner or one of `trustedPushers`. */
export const person = (trusted: Trusted, project: Project, user: string | null | undefined) =>
  user !== null &&
  user !== undefined &&
  (same(user, project.repo.split("/")[0]!) || trusted.pushers.some((p) => same(p, user)));

/** Whether `user` is Calder's own. */
export const bot = (trusted: Trusted, user: string | null | undefined) =>
  user !== null && user !== undefined && same(user, trusted.bot);

/** Whether a push of `branch` by `pusher` runs trusted. */
export const push = (
  trusted: Trusted,
  project: Project,
  branch: string,
  pusher: string | undefined,
) => person(trusted, project, pusher) || (bot(trusted, pusher) && branch === project.defaultBranch);
