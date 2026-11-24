import type { ReactNode } from "react";

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
