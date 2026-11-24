// `operator_exception`: a driver the operator configures, listed in
// `packages/testkit/test/invariants/egress-operator-exceptions.json` under `exceptionId`.
export interface UrlField {
  readonly id: string;
  readonly route: "egress" | "operator_exception";
  readonly exceptionId?: string;
  readonly milestone: string;
}

const egress = (id: string, milestone: string): UrlField => ({ id, route: "egress", milestone });
const exception = (id: string, exceptionId: string): UrlField => ({
  id,
  route: "operator_exception",
  exceptionId,
  milestone: "M1",
});

export const URL_FIELDS: readonly UrlField[] = [
  egress("server-instance-url", "M1"),
  egress("identity-server-url", "M1"),
  egress("identity-handle", "M1"),
  egress("media-import", "M1"),
  egress("shortener-host", "M1"),
  egress("rss", "M2"),
  egress("oidc-issuer", "M3"),
  egress("notification-webhook", "M3"),
  egress("webhook-target", "M4"),
  egress("cimd", "M4"),
  egress("site-url", "M5"),
  egress("ai-base-url", "M7"),
  exception("s3-endpoint", "s3-driver"),
  exception("s3-public-endpoint", "s3-driver"),
  exception("clamav-host", "media-scan"),
  exception("smtp-url", "smtp-driver"),
  exception("otlp-endpoint", "otlp-exporter"),
  exception("mail-check-dns", "mail-check-dns"),
];
