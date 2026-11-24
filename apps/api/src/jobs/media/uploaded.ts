import { z } from "zod";
import type { OutboxHandlers } from "../outbox-relay.js";
import { failAsset, type PipelineDeps, processAsset } from "./pipeline.js";

// The relay counts each claim, so the claims are the retries: a run that crashes or times out leaves the asset
// `processing` and the next claim continues it. The bound is checked first, because a run that never returns cannot
// count itself: the claim after the last one ends the asset as `processing_failed`.
const MAX_CLAIMS = 3;
const payloadSchema = z.object({ media_id: z.guid() });

export function mediaUploadedHandler(deps: PipelineDeps): OutboxHandlers[string] {
  return async (event, signal) => {
    const { media_id: mediaId } = payloadSchema.parse(event.payload);
    if (event.workspaceId === null) throw new Error("a media.uploaded event names no workspace");
    if (event.attempts > MAX_CLAIMS) await failAsset(deps, event.workspaceId, mediaId);
    else await processAsset(deps, event.workspaceId, mediaId, signal);
  };
}
