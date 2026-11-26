import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "react-router";
import { DirText } from "../ui/dir-text";

declare global {
  interface ImportMetaEnv {
    readonly SHOUTORY_VERSION: string;
    readonly SHOUTORY_SOURCE_COMMIT: string;
  }
}

const REPOSITORY = "https://github.com/shoutory/shoutory";
const LINK = "min-h-6 pointer-coarse:min-h-11 text-link underline";

export function AboutPage() {
  const { t } = useLingui();
  const version = import.meta.env.SHOUTORY_VERSION;
  const commit = import.meta.env.SHOUTORY_SOURCE_COMMIT;
  // A nightly build has no release tag of its own, so it links the commit it was built from.
  const source = `${REPOSITORY}/tree/${commit || `v${version}`}`;
  return (
    <main id="main" className="mx-auto flex max-w-prose flex-col gap-5 px-5 py-10">
      <h1 className="font-heading text-2xl">
        <Trans id="system.about.title">About Shoutory</Trans>
      </h1>
      <p>
        <Trans id="system.about.version">Version</Trans>{" "}
        <span data-testid="about-version">
          <DirText dir="ltr">{version}</DirText>
        </span>
      </p>
      <p>
        <Trans id="system.about.licence">
          Shoutory is free software under the GNU Affero General Public License, version 3. You may get the
          source code of the version you are using.
        </Trans>
      </p>
      <a
        href={source}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="about-source"
        aria-label={t({
          id: "system.about.source_label",
          message: "Source code of this version (opens in a new tab)",
        })}
        className={LINK}
      >
        <Trans id="system.about.source">Source code of this version</Trans>
      </a>
      <Link to="/" className={LINK}>
        <Trans id="system.action.home">Go to the start page</Trans>
      </Link>
    </main>
  );
}
