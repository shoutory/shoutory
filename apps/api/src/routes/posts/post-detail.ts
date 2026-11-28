import type { AuthorizedScope } from "@shoutory/core/authz/scope";
import type { HealthProvider } from "../../channels/health.js";
import { mayResolve, type Resolution, resolutionsOf, type TargetAction, targetActions } from "./actions.js";

// The targets of a post as one column of the post's own statement, so the ETag names the state shown. $3 says whether
// the caller may see the evidence line and $4 the attempts: a field the caller may not see is left out, never null.
// A provider's words (the code and the excerpt of an attempt) are never selected.

// The one reading of why a scheduled target waits: its media is not ready. `s` is the variant row.
export const HOLD_REASON = `CASE WHEN s.schedule_state = 'scheduled' AND app.media_held(s.workspace_id, s.frozen_version_id)
            THEN 'held_media' END`;

export const TARGETS_COLUMN = `
    coalesce((SELECT jsonb_agg(t.obj ORDER BY t.id) FROM (
      SELECT s.id, jsonb_build_object(
          'variant_id', s.id, 'channel_id', s.channel_id, 'provider_id', c.provider_id,
          'schedule_state', s.schedule_state, 'presence', s.presence, 'published_at', s.published_at,
          'due_at', s.due_at, 'due_tz', s.due_tz, 'settings', s.settings,
          'hold_reason', ${HOLD_REASON},
          'operation', (SELECT jsonb_build_object('id', o.id, 'kind', o.kind, 'state', o.state, 'effect', o.effect,
              'reason_code', o.reason_code, 'part_index', o.part_index)
            FROM app.operations AS o WHERE o.workspace_id = s.workspace_id AND o.variant_id = s.id
            ORDER BY o.created_at DESC, o.id DESC LIMIT 1))
        || CASE WHEN $3::boolean THEN jsonb_build_object('evidence', coalesce((
            SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'level', e.level, 'outcome_kind', e.outcome_kind,
                'permalink', e.permalink, 'observed_at', e.observed_at) ORDER BY e.observed_at DESC)
            FROM (SELECT x.* FROM app.operation_evidence AS x WHERE x.workspace_id = s.workspace_id AND x.operation_id = (
                SELECT o.id FROM app.operations AS o WHERE o.workspace_id = s.workspace_id AND o.variant_id = s.id
                ORDER BY o.created_at DESC, o.id DESC LIMIT 1) ORDER BY x.observed_at DESC LIMIT 5) AS e), '[]'::jsonb))
          ELSE '{}'::jsonb END
        || CASE WHEN $4::boolean THEN jsonb_build_object('attempts', coalesce((
            SELECT jsonb_agg(jsonb_build_object('attempt_no', a.attempt_no, 'step', a.step, 'effect', a.effect,
                'http_status', a.http_status, 'error_class', a.error_class, 'started_at', a.started_at,
                'finished_at', a.finished_at) ORDER BY a.attempt_no DESC)
            FROM (SELECT y.* FROM app.operation_attempts AS y WHERE y.workspace_id = s.workspace_id AND y.operation_id = (
                SELECT o.id FROM app.operations AS o WHERE o.workspace_id = s.workspace_id AND o.variant_id = s.id
                ORDER BY o.created_at DESC, o.id DESC LIMIT 1) ORDER BY y.attempt_no DESC LIMIT 10) AS a), '[]'::jsonb))
          ELSE '{}'::jsonb END AS obj
      FROM app.post_variants AS s JOIN app.channels AS c ON c.workspace_id = s.workspace_id AND c.id = s.channel_id
      WHERE s.workspace_id = p.workspace_id AND s.post_id = p.id) AS t), '[]'::jsonb) AS targets`;

interface RawTarget {
  provider_id: string;
  schedule_state: string;
  presence: string;
  published_at: string | null;
  operation:
    | ({ state: string; kind: string; reason_code: string | null; effect: string } & Record<string, unknown>)
    | null;
  [key: string]: unknown;
}

export interface DetailFacts {
  readonly scope: AuthorizedScope;
  readonly providers: Readonly<Record<string, HealthProvider>>;
  readonly authorId: string | null;
  readonly now: Date;
}

// The provider id leaves the answer: the screens work from the actions, not from who the provider is.
export function targetsWithActions(
  targets: readonly RawTarget[],
  facts: DetailFacts,
): (Omit<RawTarget, "provider_id" | "operation"> & {
  operation: (NonNullable<RawTarget["operation"]> & { resolutions: Resolution[] }) | null;
  actions: TargetAction[];
})[] {
  return targets.map(({ provider_id: providerId, ...target }) => {
    const manifest = Object.hasOwn(facts.providers, providerId)
      ? facts.providers[providerId]?.manifest
      : undefined;
    const editWindow = manifest?.actionWindows.edit;
    const deleteWindow = manifest?.actionWindows.delete;
    const person = {
      postAuthorId: facts.authorId,
      principalId: facts.scope.principalId,
      permissions: facts.scope.permissions,
    };
    const actions = targetActions({
      scheduleState: target.schedule_state,
      presence: target.presence,
      publishedAt: target.published_at === null ? null : new Date(target.published_at),
      operation: target.operation,
      ...person,
      provider: manifest
        ? {
            capabilities: manifest.capabilities,
            ...(editWindow === undefined ? {} : { editWindowSeconds: editWindow }),
            ...(deleteWindow === undefined ? {} : { deleteWindowSeconds: deleteWindow }),
          }
        : undefined,
      now: facts.now,
    });
    const op = target.operation;
    const operation = op === null ? null : { ...op, resolutions: resolutionsOf(op, mayResolve(person)) };
    return { ...target, operation, actions };
  });
}
