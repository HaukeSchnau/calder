import type { Project } from "./Projects.ts";

/**
 * Whose code Calder runs as trusted: each repository's owner and the controller's `trustedPushers`.
 * Calder's own user `bot` pushes only what it merged, so its push is as trusted as what it merged: the
 * merge train or a pull request onto the default branch's head, and the default branch merged into a pull
 * request's branch (Merges.ts `update`). Code of anyone else, such as the bot `renovate`, runs like a
 * fork's pull request (`RunInput.fork`): in the fork pool, without secrets, deploys or previews, and no
 * trusted run takes its results, plans or records. A pull request's revision runs as one when someone
 * trusted pushed it (Rows.ts `pushed`).
 */
export interface Trusted {
  readonly pushers: ReadonlyArray<string>;
  /** Calder's own user, undefined when Gitea didn't say which it is: then no push counts as Calder's. */
  readonly bot: string | undefined;
}

/** What webhooks said of who pushed a revision (Rows.ts `pushedTrusted`), undefined when none did. */
export type Said = boolean | undefined;

// Gitea's logins are unique regardless of case.
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether `user` is the repository's owner or one of `trustedPushers`. */
export const person = (trusted: Trusted, project: Project, user: string | null | undefined) =>
  user !== null &&
  user !== undefined &&
  (same(user, project.repo.split("/")[0]!) || trusted.pushers.some((p) => same(p, user)));

/** Whether `user` is Calder's own. */
export const bot = (trusted: Trusted, user: string | null | undefined) =>
  user !== null && user !== undefined && trusted.bot !== undefined && same(user, trusted.bot);

/**
 * Whether a push of `branch` by `pusher` runs trusted. Calder's own push to the default branch lands what it
 * merged onto the head it moved from, `before`, which counts like the default branch's head: trusted unless a
 * webhook said someone else pushed it. Its push to another branch is judged as an update (`update`).
 */
export const push = (
  trusted: Trusted,
  project: Project,
  branch: string,
  pusher: string | undefined,
  before: Said,
) =>
  person(trusted, project, pusher) ||
  (bot(trusted, pusher) && branch === project.defaultBranch && before !== false);

/**
 * Whether `sender`'s push to the branch of a pull request into `base` runs trusted. Calder's own merged the
 * default branch's revision `merged` into the head `before` (Merges.ts `update`): trusted when someone trusted
 * pushed `before` and no webhook said someone else pushed `merged`. `merged` is null when the push wasn't
 * such a merge.
 */
export const update = (
  trusted: Trusted,
  project: Project,
  base: string | undefined,
  sender: string | undefined,
  before: Said,
  merged: Said | null,
) =>
  person(trusted, project, sender) ||
  (bot(trusted, sender) &&
    base === project.defaultBranch &&
    before === true &&
    merged !== null &&
    merged !== false);
