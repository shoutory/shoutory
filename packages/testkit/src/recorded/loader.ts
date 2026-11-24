import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type RecordedExchange, scrubExchange } from "./scrubber.js";

const MAX_FILE_BYTES = 5_242_880;
const MAX_ENTRIES = 500;
const MAX_BODY_CHARS = 1_048_576;
const MAX_HEADERS = 100;

const headers = z
  .record(z.string().max(256), z.string().max(8192))
  .refine((all) => Object.keys(all).length <= MAX_HEADERS);
const body = z.string().max(MAX_BODY_CHARS).optional();

const exchangeSchema: z.ZodType<RecordedExchange> = z.strictObject({
  request: z.strictObject({
    method: z.string().max(16),
    url: z.string().max(8192),
    headers,
    body,
  }),
  response: z.strictObject({ status: z.number().int().min(100).max(599), headers, body }),
});

const answersSchema = z.array(exchangeSchema).max(MAX_ENTRIES);

// A file the scrubber would still change is a raw capture and is refused; the message names the exchange, never its content.
export function loadRecordedAnswers(text: string): readonly RecordedExchange[] {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error("recorded answers file is too large");
  const exchanges = answersSchema.parse(JSON.parse(text));
  const raw = exchanges.findIndex((exchange) => !isDeepStrictEqual(scrubExchange(exchange), exchange));
  if (raw >= 0) throw new Error(`recorded exchange ${raw} still holds a secret: scrub the capture first`);
  return exchanges;
}
