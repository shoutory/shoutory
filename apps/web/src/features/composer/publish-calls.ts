import { useRef, useState } from "react";
import { z } from "zod";
import { ApiError, request, uuidv7 } from "../../http/client";

export const idsSchema = z.object({ variant_ids: z.array(z.string()) });
export const scheduledSchema = idsSchema.extend({ due_at: z.string(), due_tz: z.string() });

// One effect at a time: a press while another runs is ignored, and the answer's refusal is kept to be shown.
export function useEffectCall() {
  const running = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const run = async (name: string, act: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(name);
    setFailure(null);
    try {
      await act();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setFailure(error);
    } finally {
      running.current = false;
      setBusy(null);
    }
  };
  return { busy, failure, run, clear: () => setFailure(null) };
}

// A press gets its own key; only a retry of the same request after a lost answer keeps the key it had.
export function useKeys() {
  const lost = useRef<{ signature: string; key: string } | null>(null);
  return async <T>(schema: z.ZodType<T>, path: string, body: Record<string, unknown>): Promise<T> => {
    const signature = JSON.stringify([path, body]);
    const key = lost.current?.signature === signature ? lost.current.key : uuidv7();
    try {
      const answer = await request(schema, path, { method: "POST", body, idempotencyKey: key });
      lost.current = null;
      return answer;
    } catch (error) {
      lost.current = error instanceof ApiError && error.code === "network" ? { signature, key } : null;
      throw error;
    }
  };
}
