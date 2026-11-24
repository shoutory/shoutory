import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { useEffect, useRef } from "react";
import { type UIMatch, useLocation, useNavigationType } from "react-router";

export interface PageHandle {
  title: MessageDescriptor | ((matches: UIMatch[]) => MessageDescriptor);
}

const SITE = "Shoutory";

export function usePageTitleAndFocus(title: MessageDescriptor | undefined): void {
  const { i18n } = useLingui();
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const previous = useRef<string | null>(null);
  // Worded here, in render, so a change of language changes it.
  const name = title ? i18n._(title) : null;

  useEffect(() => {
    document.title = name ? `${name} - ${SITE}` : SITE;
  }, [name]);

  useEffect(() => {
    // A page that mounts after a navigation (the error page replaces the root element) is a new page too; one that
    // mounts on the first load (a "POP" with nothing before it) is not.
    const changed = previous.current === null ? navigationType === "PUSH" : previous.current !== pathname;
    if (changed && navigationType !== "REPLACE") {
      const target =
        document.querySelector<HTMLElement>("h1") ?? document.querySelector<HTMLElement>("#main");
      if (target) {
        target.tabIndex = -1;
        target.focus();
      }
    }
    previous.current = pathname;
  }, [pathname, navigationType]);
}
