import { afterEach, describe, expect, it } from "vitest";
import { click, closeApp, json, openApp, refusal, settle } from "../../../test/support/app";
import {
  allById,
  byId,
  type Call,
  CH,
  callsOf,
  detailOf,
  field,
  POST,
  stubComposerApi,
  VERSION_1,
  VERSION_2,
  VERSION_3,
  variantRow,
} from "../../../test/support/composer-api";

afterEach(closeApp);

const row = (id: string, no: number, kind: string) => ({
  id,
  version_no: no,
  kind,
  created_by: "u1",
  created_at: "2026-11-28T10:00:00.000Z",
});

interface Setup {
  restore?: (call: Call) => Response;
  list?: (call: Call) => Response;
}

async function open(setup: Setup = {}) {
  const stub = stubComposerApi({
    answer: (call) => {
      if (call.method === "GET" && call.path === `posts/${POST}`) {
        return detailOf([variantRow(CH.short, "Current words")], undefined, undefined, VERSION_2);
      }
      if (call.method === "GET" && call.path === `posts/${POST}/versions`) {
        return (
          setup.list?.(call) ??
          json({
            data: [row(VERSION_2, 2, "save"), row(VERSION_1, 1, "autosave")],
            meta: { next_cursor: null },
          })
        );
      }
      if (call.method === "GET" && call.path === `posts/${POST}/versions/${VERSION_1}`) {
        return json({
          data: {
            ...row(VERSION_1, 1, "autosave"),
            draft: { variants: [variantRow(CH.short, "Older words")] },
          },
        });
      }
      if (call.method === "POST" && call.path.endsWith("/restore")) {
        return (
          setup.restore?.(call) ??
          json({ data: { id: POST, version_id: VERSION_3, pending_changes: [] } }, 201)
        );
      }
      return undefined;
    },
  });
  await openApp(`/w/w1/posts/${POST}/edit`);
  await settle();
  await click(byId("versions-open") as HTMLElement);
  await settle();
  return stub;
}

describe("version history", () => {
  it("lists the versions with what made each one", async () => {
    await open();
    const rows = allById("version-row").map((one) => one.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Saved");
    expect(rows[1]).toContain("Autosave");
  });

  it("asks for the next page with the cursor of the last version shown", async () => {
    const stub = await open({
      list: (call) =>
        call.query.get("cursor") === null
          ? json({ data: [row(VERSION_2, 2, "save")], meta: { next_cursor: VERSION_2 } })
          : json({ data: [row(VERSION_1, 1, "autosave")], meta: { next_cursor: null } }),
    });
    await click(byId("versions-more") as HTMLElement);
    await settle();
    expect(allById("version-row")).toHaveLength(2);
    expect(callsOf(stub, "GET", `versions?limit=20&cursor=${VERSION_2}`)).toHaveLength(1);
  });

  it("sends a cursor with characters of a query as one value", async () => {
    const cursor = "a+b/c d&e=1#f";
    let asked: string | null = null;
    await open({
      list: (call) => {
        if (call.query.get("cursor") === null) {
          return json({ data: [row(VERSION_2, 2, "save")], meta: { next_cursor: cursor } });
        }
        asked = call.query.get("cursor");
        return json({ data: [row(VERSION_1, 1, "autosave")], meta: { next_cursor: null } });
      },
    });
    await click(byId("versions-more") as HTMLElement);
    await settle();
    expect(asked).toBe(cursor);
  });

  it("previews one version's text without changing the draft", async () => {
    await open();
    await click(allById("version-preview")[1] as HTMLElement);
    await settle();
    expect(byId("version-view")?.textContent).toContain("Older words");
    expect(field("composer-base").value).toBe("Current words");
  });

  it("restores a version as a new one against the version the page holds, and shows its text", async () => {
    const stub = await open();
    await click(allById("version-restore")[1] as HTMLElement);
    await settle();
    const [call] = callsOf(stub, "POST", "/restore");
    expect(call?.headers["If-Match"]).toBe(`"${VERSION_2}"`);
    expect(field("composer-base").value).toBe("Older words");
  });

  it("a refused restore says nothing changed and keeps the text", async () => {
    await open({ restore: () => refusal("conflict", 409, { reason: "post_archived" }) });
    await click(allById("version-restore")[1] as HTMLElement);
    await settle();
    expect(byId("version-failure")?.textContent).toContain("Nothing was changed");
    expect(field("composer-base").value).toBe("Current words");
  });
});
