import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request, requestPages } from "../../http/client";
import {
  type Fit,
  fitSchema,
  type Media,
  mediaSchema,
  STATE_WORDS,
  stateOf,
  UNKNOWN_STATE,
} from "../media/media";
import { type Session, uploadFile } from "./upload";

export type Facts = ReadonlyMap<string, Media>;

/** The word for a file's state; a state this page does not know gets the unknown word, never Ready. */
export function useStateWord() {
  const { i18n } = useLingui();
  return (state: string): string => {
    const known = stateOf(state);
    return i18n._(known === "unknown" ? UNKNOWN_STATE : STATE_WORDS[known]);
  };
}

/** The name, type and state of each file the draft uses, read once and kept; a file that cannot be read has no entry. */
export function useMediaFacts(workspace: string, ids: readonly string[]) {
  const [facts, setFacts] = useState<Map<string, Media>>(new Map());
  const asked = useRef(new Set<string>());
  const wanted = ids.join(",");
  const remember = useCallback((row: Media) => {
    asked.current.add(row.id);
    setFacts((now) => new Map(now).set(row.id, row));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` stands for `ids`
  useEffect(() => {
    for (const id of ids.filter((one) => !asked.current.has(one))) {
      asked.current.add(id);
      request(mediaSchema, `/api/v1/workspaces/${workspace}/media/${id}`).then(
        (row) => setFacts((now) => new Map(now).set(id, row)),
        (error: unknown) => {
          if (!(error instanceof ApiError)) throw error;
        },
      );
    }
  }, [workspace, wanted]);
  return { facts, remember };
}

const fitRows = fitSchema.shape.data;

/** Where each file fits: one answer per file, by channel. */
export function useFits(workspace: string, ids: readonly string[]) {
  const [fits, setFits] = useState<Map<string, Map<string, Fit>>>(new Map());
  const asked = useRef(new Set<string>());
  const wanted = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` stands for `ids`
  useEffect(() => {
    for (const id of ids.filter((one) => !asked.current.has(one))) {
      asked.current.add(id);
      requestPages(fitRows, `/api/v1/workspaces/${workspace}/media/${id}/fit`).then(
        (rows) => setFits((now) => new Map(now).set(id, new Map(rows.map((row) => [row.channel_id, row])))),
        (error: unknown) => {
          if (!(error instanceof ApiError)) throw error;
        },
      );
    }
  }, [workspace, wanted]);
  return fits;
}

export interface Entry {
  key: number;
  name: string;
  percent: number;
  status: "uploading" | "done" | "failed";
  duplicate: boolean;
  error: ApiError | null;
}

interface Held {
  file: File;
  session?: Session;
}

/** Uploads files one at a time, each with its progress; a failed one is tried again from where it stopped. */
export function useUploader(workspace: string, onUploaded: (id: string, mime: string) => void) {
  // The newest handler, so a file that ends later adds itself to the newest document.
  const onDone = useRef(onUploaded);
  onDone.current = onUploaded;
  const [entries, setEntries] = useState<Entry[]>([]);
  const held = useRef(new Map<number, Held>());
  const next = useRef(0);
  const change = useCallback(
    (key: number, patch: Partial<Entry>) =>
      setEntries((now) => now.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry))),
    [],
  );

  const run = useCallback(
    async (key: number) => {
      const one = held.current.get(key);
      if (!one) return;
      change(key, { status: "uploading", error: null });
      try {
        const done = await uploadFile(workspace, one.file, {
          ...(one.session ? { resume: one.session } : {}),
          onSession: (session) => {
            one.session = session;
          },
          onProgress: (percent) => change(key, { percent }),
        });
        change(key, { status: "done", duplicate: done.duplicate, percent: 100 });
        onDone.current(done.id, one.file.type);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        change(key, { status: "failed", error });
      }
    },
    [workspace, change],
  );

  const add = useCallback(
    async (files: readonly File[]) => {
      const fresh = files.map((file) => ({ key: next.current++, file }));
      for (const { key, file } of fresh) held.current.set(key, { file });
      setEntries((now) => [
        ...now,
        ...fresh.map(({ key, file }) => ({
          key,
          name: file.name,
          percent: 0,
          status: "uploading" as const,
          duplicate: false,
          error: null,
        })),
      ]);
      for (const { key } of fresh) await run(key);
    },
    [run],
  );
  return { entries, add, retry: (key: number) => void run(key) };
}
