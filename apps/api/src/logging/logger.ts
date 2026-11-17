import { pino } from "pino";
import { redactUrl } from "./redact-url.js";
import { createScrubber, type Scrubber } from "./scrub.js";

interface LogStream {
  write(line: string): void;
}

export interface LoggerOptions {
  /** Values (KEK, pepper, session secret, passwords, URLs) replaced in every string in five spellings. */
  readonly secrets: readonly string[];
  readonly stream: LogStream;
}

export interface Logger {
  info(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
  child(bindings: object): Logger;
}

export interface ProviderAnswer {
  readonly class: string;
  readonly code: string;
  readonly body: string;
}

export interface RequestLine {
  readonly method: string;
  readonly url: string;
  readonly status: number;
}

const WITHHELD = JSON.stringify({ level: "error", msg: "[log line withheld]" });

type BindingsFormatter = (value: object) => Record<string, unknown>;

function wrap(logger: pino.Logger, bindings: BindingsFormatter): Logger {
  return {
    info: (fields, message) => logger.info(fields, message),
    error: (fields, message) => logger.error(fields, message),
    child: (more) => wrap(logger.child(more, { formatters: { bindings } }), bindings),
  };
}

/** Pino JSON lines to `stream`; the scrubber sees the message, every argument and the child bindings. */
export function createLogger(options: LoggerOptions): Logger {
  const scrub: Scrubber = createScrubber(options.secrets);
  const withhold = () => options.stream.write(`${WITHHELD}\n`);
  // Pino resets this formatter on a child, so every child passes it again.
  const bindings = (value: object): Record<string, unknown> => {
    try {
      return scrub(value) as Record<string, unknown>;
    } catch {
      return { bindings: "[withheld]" };
    }
  };
  const logger = pino(
    {
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      // Pino's own err serializer would run after the scrubber; the scrubber already made the Error plain.
      serializers: { err: (value: unknown) => value },
      formatters: { level: (label) => ({ level: label }), bindings },
      hooks: {
        logMethod(args, method) {
          let clean: unknown[];
          try {
            clean = args.map(scrub);
          } catch {
            withhold();
            return;
          }
          method.apply(this, clean as Parameters<typeof method>);
        },
      },
    },
    options.stream,
  );
  return wrap(logger, bindings);
}

/** A provider answer is logged as its class and code only; the body never reaches a log. */
export function logProviderAnswer(logger: Logger, answer: ProviderAnswer): void {
  logger.info({ answer: { class: answer.class, code: answer.code } }, "provider answer");
}

export function logRequest(logger: Logger, request: RequestLine): void {
  logger.info({ method: request.method, path: redactUrl(request.url), status: request.status }, "request");
}
