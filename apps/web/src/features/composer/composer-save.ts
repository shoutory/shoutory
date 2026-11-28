import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ApiError, request } from "../../http/client";
import { useOnline } from "../../shell/offline-banner";
import { useSignIn } from "../channels/channels-hub";
import { type Doc, toDraft } from "./composer-data";

export type SaveState = "saved" | "saving" | "unsaved" | "paused";

const AUTOSAVE_MS = 2000;
const PAUSE_MS = 5000;

const answerSchema = z.object({
  id: z.string(),
  version_id: z.string(),
  pending_changes: z.array(z.string()).default([]),
});
type Answer = z.infer<typeof answerSchema>;

interface Baseline {
  json: string;
  version: string | null;
  postId: string | undefined;
}

export interface Buffered {
  at: string;
  doc: Doc;
}

const bufferKey = (workspace: string, postId: string | undefined) =>
  `shoutory.composer.${workspace}.${postId ?? "new"}`;

// A blocked or full storage is a normal answer: the words are still in the page.
function readBuffer(key: string): Buffered | null {
  try {
    const text = localStorage.getItem(key);
    return text === null ? null : (JSON.parse(text) as Buffered);
  } catch (error) {
    if (error instanceof DOMException || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeBuffer(key: string, value: Buffered | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

interface Args {
  workspace: string;
  postId: string | undefined;
  version: string | null;
  doc: Doc;
  canSave: boolean;
  onCreated: (id: string) => void;
  onReplace: (doc: Doc) => void;
}

interface View {
  state: SaveState;
  savedAt: Date | null;
  failure: ApiError | null;
  /** The version someone else saved first; set while the person has not chosen yet. */
  conflict: string | null;
  pending: string[];
}

// The facts a save works from, kept in refs so a save that started earlier still reads the latest document.
function useCore(args: Args) {
  const baseline = useRef<Baseline>({
    json: JSON.stringify(args.doc),
    version: args.version,
    postId: args.postId,
  });
  const docRef = useRef(args.doc);
  docRef.current = args.doc;
  const held = useRef(false);
  const [view, setView] = useState<View>({
    state: "saved",
    savedAt: null,
    failure: null,
    conflict: null,
    pending: [],
  });
  const patch = useCallback((change: Partial<View>) => setView((now) => ({ ...now, ...change })), []);
  return { baseline, docRef, held, view, patch };
}
type Core = ReturnType<typeof useCore>;

function send(base: string, now: Baseline, doc: Doc): Promise<Answer> {
  const body = { draft: toDraft(doc) };
  if (now.postId === undefined) return request(answerSchema, `${base}/posts`, { method: "POST", body });
  return request(answerSchema, `${base}/posts/${now.postId}`, {
    method: "PATCH",
    body,
    headers: { "If-Match": `"${now.version}"` },
  });
}

// What each refusal of a save does to the screen: a conflict waits for a choice, a fast pace waits a moment, a lost
// network waits for the network, and anything else is shown.
function useRefusal({ held, patch }: Core, signIn: () => void, retry: () => void) {
  return useCallback(
    (error: ApiError) => {
      patch({ state: "unsaved" });
      if (error.code === "precondition_failed") {
        held.current = true;
        patch({ conflict: error.details?.current_version_id ?? "" });
      } else if (error.state === "session_expired") signIn();
      else if (error.code === "too_many_requests") {
        patch({ state: "paused" });
        setTimeout(retry, PAUSE_MS);
      } else if (error.code !== "network") patch({ failure: error });
    },
    [held, patch, signIn, retry],
  );
}

function useSend(args: Args, core: Core) {
  const { workspace } = args;
  const { baseline, docRef, held, patch } = core;
  const signIn = useSignIn();
  const latest = useRef({ args, signIn });
  latest.current = { args, signIn };
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const again = useRef<() => void>(() => undefined);

  const settle = useCallback(
    (answer: Answer, json: string) => {
      const was = baseline.current.postId;
      baseline.current = { json, version: answer.version_id, postId: answer.id };
      writeBuffer(bufferKey(workspace, was), null);
      patch({
        pending: answer.pending_changes,
        savedAt: new Date(),
        state: JSON.stringify(docRef.current) === json ? "saved" : "unsaved",
      });
      if (was === undefined) latest.current.args.onCreated(answer.id);
    },
    [workspace, baseline, docRef, patch],
  );

  const signInNow = useCallback(() => latest.current.signIn(), []);
  const retryNow = useCallback(() => again.current(), []);
  const refuse = useRefusal(core, signInNow, retryNow);

  const run = useCallback(async (): Promise<boolean> => {
    const json = JSON.stringify(docRef.current);
    const now = baseline.current;
    if (json === now.json) return true;
    const { args: current } = latest.current;
    if (held.current || !current.canSave || docRef.current.variants.length === 0 || !navigator.onLine) {
      patch({ state: "unsaved" });
      return false;
    }
    patch({ state: "saving", failure: null });
    try {
      settle(await send(`/api/v1/workspaces/${workspace}`, now, docRef.current), json);
      return true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      refuse(error);
      return false;
    }
  }, [workspace, baseline, docRef, held, patch, settle, refuse]);

  return useCallback((): Promise<boolean> => {
    const next = chain.current.then(run, run) as Promise<boolean>;
    chain.current = next;
    again.current = () => void next.then(() => run());
    return next;
  }, [run]);
}

function useAutosave(args: Args, core: Core, saveNow: () => Promise<boolean>, locked: boolean) {
  const online = useOnline();
  const { baseline, patch } = core;
  const json = JSON.stringify(args.doc);
  const { workspace, canSave } = args;
  useEffect(() => {
    if (locked) return;
    const clean = json === baseline.current.json;
    const key = bufferKey(workspace, baseline.current.postId ?? args.postId);
    writeBuffer(key, clean ? null : { at: new Date().toISOString(), doc: core.docRef.current });
    if (!canSave || clean) return;
    patch({ state: "unsaved" });
    if (!online) return;
    const timer = setTimeout(() => void saveNow(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [json, canSave, online, locked, workspace, args.postId, saveNow, baseline, patch, core.docRef]);
  useEffect(() => {
    const hidden = () => document.visibilityState === "hidden" && void saveNow();
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [saveNow]);
  return online;
}

function useOffer(args: Args, baseline: RefObject<Baseline>) {
  const [offer, setOffer] = useState<Buffered | null>(() => {
    const kept = readBuffer(bufferKey(args.workspace, args.postId));
    return kept && JSON.stringify(kept.doc) !== baseline.current.json ? kept : null;
  });
  return {
    offer,
    restore: () => {
      if (offer) args.onReplace(offer.doc);
      setOffer(null);
    },
    discard: () => {
      writeBuffer(bufferKey(args.workspace, args.postId), null);
      setOffer(null);
    },
  };
}

/**
 * Saves the document to the server a little after the person stops typing, keeps a copy on this device until the server
 * has it, and holds the answers a screen needs: the state, a refusal, a conflict and the scheduled variants now changed.
 */
export function useSaver(args: Args) {
  const core = useCore(args);
  const saveNow = useSend(args, core);
  const { offer, restore, discard } = useOffer(args, core.baseline);
  const online = useAutosave(args, core, saveNow, offer !== null);
  const { baseline, held, patch, view } = core;
  return {
    ...view,
    offer,
    online,
    postId: baseline.current.postId,
    saveNow,
    restore,
    discard,
    keepMine: (theirs: string) => {
      baseline.current = { ...baseline.current, version: theirs };
      held.current = false;
      patch({ conflict: null });
      return saveNow();
    },
    // The server's own version of the document becomes the one the page holds: another person's save, or a restore.
    adopt: (doc: Doc, version: string, pending: string[] = []) => {
      baseline.current = { ...baseline.current, json: JSON.stringify(doc), version };
      held.current = false;
      patch({ conflict: null, state: "saved", pending, savedAt: new Date() });
      args.onReplace(doc);
    },
    /** The version the next save is made against. */
    currentVersion: () => baseline.current.version,
  };
}
