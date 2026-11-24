// `operator_exception`: a driver the operator configures, listed in
// `packages/testkit/test/invariants/egress-operator-exceptions.json` under `exceptionId`.
// A new URL field joins this list in the change that adds it.
export interface UrlField {
  readonly id: string;
  readonly route: "egress" | "operator_exception";
  readonly exceptionId?: string;
}

const egress = (id: string): UrlField => ({ id, route: "egress" });
const exception = (id: string, exceptionId: string): UrlField => ({
  id,
  route: "operator_exception",
  exceptionId,
});

export const URL_FIELDS: readonly UrlField[] = [
  egress("server-instance-url"),
  egress("media-import"),
  exception("s3-endpoint", "s3-driver"),
  exception("s3-public-endpoint", "s3-driver"),
  exception("clamav-host", "media-scan"),
  exception("smtp-url", "smtp-driver"),
  exception("otlp-endpoint", "otlp-exporter"),
  exception("mail-check-dns", "mail-check-dns"),
];
