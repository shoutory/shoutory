import type { ReactNode } from "react";

/**
 * User text (a name, a title, a code) inside a sentence of another direction: isolated with `bdi`, so its direction
 * never reorders the words around it. Direction is `auto` unless the caller knows it.
 */
export function DirText({
  children,
  lang,
  dir = "auto",
}: {
  children: ReactNode;
  lang?: string;
  dir?: "ltr" | "rtl" | "auto";
}) {
  return (
    <bdi dir={dir} lang={lang}>
      {children}
    </bdi>
  );
}
