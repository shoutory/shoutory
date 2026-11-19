import { Trans } from "@lingui/react/macro";

/** A measure with no source yet, or a value that could not be read: said in words, never shown as a zero. */
export function NotAvailable() {
  return <Trans id="admin.not_available">Not available</Trans>;
}
