import { afterEach, describe, expect, it } from "vitest";
import { closeApp, json, refusal } from "../../../test/support/app";
import { type Call, callsOf, stubComposerApi } from "../../../test/support/composer-api";
import { ApiError } from "../../http/client";
import { type Session, uploadFile } from "./upload";

afterEach(closeApp);

const MEDIA = "0190a000-0000-7000-8000-0000000000f9";
const base = `media/${MEDIA}`;
const file = (bytes: number[], name = "photo.png") =>
  new File([new Uint8Array(bytes)], name, { type: "image/png" });
const hex = async (bytes: number[]) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

type Answer = (call: Call) => Response | undefined;
const stub = (answer: Answer) => stubComposerApi({ answer });
const done = (duplicate = false) => json({ data: { id: MEDIA, duplicate } });
const percents: number[] = [];
const hooks = (resume?: Session) => ({
  ...(resume ? { resume } : {}),
  onSession: () => undefined,
  onProgress: (percent: number) => percents.push(percent),
});

describe("uploading one file", () => {
  it("registers the file with its digest, sends the bytes where it is told and completes it", async () => {
    const seen = stub((call) => {
      if (call.method === "POST" && call.path === "media") {
        return json(
          { data: { id: MEDIA, duplicate: false, url: `/api/v1/workspaces/w1/${base}/original` } },
          201,
        );
      }
      if (call.method === "PUT") return json({ data: { id: MEDIA } });
      if (call.path === `${base}/complete`) return done();
      return undefined;
    });
    const bytes = [1, 2, 3, 4];
    const result = await uploadFile("w1", file(bytes), hooks());
    expect(result).toEqual({ id: MEDIA, duplicate: false });
    expect(percents.at(-1)).toBe(100);
    const [registered] = callsOf(seen, "POST", "/media");
    expect(registered?.body).toEqual({
      file_name: "photo.png",
      mime: "image/png",
      byte_size: 4,
      sha256: await hex(bytes),
    });
    expect(callsOf(seen, "PUT", `${base}/original`)).toHaveLength(1);
  });

  it("a file the workspace already has is not sent again", async () => {
    const seen = stub((call) =>
      call.method === "POST" && call.path === "media"
        ? json({ data: { id: MEDIA, duplicate: true } }, 201)
        : undefined,
    );
    const result = await uploadFile("w1", file([9, 9]), hooks());
    expect(result).toEqual({ id: MEDIA, duplicate: true });
    expect(callsOf(seen, "PUT", "/media")).toHaveLength(0);
  });

  it("a refusal to register is raised with its reason", async () => {
    stub((call) =>
      call.path === "media" ? refusal("unprocessable_content", 422, { reason: "too_large" }) : undefined,
    );
    const failure = await uploadFile("w1", file([1]), hooks()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).details?.reason).toBe("too_large");
  });
});

describe("a file sent in parts", () => {
  const bytes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  const urlsFor = (call: Call) => {
    const wanted = (call.body as { parts: { number: number }[] }).parts;
    const parts = wanted.map(({ number }) => ({
      number,
      url: `/api/v1/workspaces/w1/${base}/parts/${number}`,
      headers: {},
    }));
    return json({ data: { parts } });
  };

  function parts(held: { number: number; size: number }[]) {
    const routes: Record<string, (call: Call) => Response> = {
      "POST media": () => json({ data: { id: MEDIA, duplicate: false, part_size: 4 } }, 201),
      [`GET ${base}/parts`]: () => json({ data: { part_size: 4, part_count: 3, parts: held } }),
      [`POST ${base}/parts`]: urlsFor,
      [`POST ${base}/complete`]: () => done(),
    };
    return stub((call) =>
      call.method === "PUT" ? json({ data: { number: 1 } }) : routes[`${call.method} ${call.path}`]?.(call),
    );
  }

  const registrations = (seen: ReturnType<typeof stub>) =>
    seen.mock.calls.filter(([url, init]) => url.endsWith("/media") && init?.method === "POST");

  it("sends every part and the digest of each", async () => {
    const seen = parts([]);
    await uploadFile("w1", file(bytes), hooks());
    const [asked] = callsOf(seen, "POST", `${base}/parts`);
    expect(asked?.body).toEqual({
      parts: [
        { number: 1, sha256: await hex([1, 2, 3, 4]) },
        { number: 2, sha256: await hex([5, 6, 7, 8]) },
        { number: 3, sha256: await hex([9, 10]) },
      ],
    });
    expect(callsOf(seen, "PUT", "/parts/")).toHaveLength(3);
  });

  it("resumes from the parts the server already holds and sends only the missing ones", async () => {
    const seen = parts([{ number: 1, size: 4 }]);
    const first = await uploadFile("w1", file(bytes), hooks({ id: MEDIA, partSize: 4 }));
    expect(first.id).toBe(MEDIA);
    expect(registrations(seen)).toHaveLength(0);
    const asked = callsOf(seen, "POST", `${base}/parts`)[0]?.body as { parts: { number: number }[] };
    expect(asked.parts.map((part) => part.number)).toEqual([2, 3]);
    expect(callsOf(seen, "PUT", "/parts/")).toHaveLength(2);
  });

  it("a held part of the wrong length is sent again", async () => {
    const seen = parts([{ number: 1, size: 3 }]);
    await uploadFile("w1", file(bytes), hooks({ id: MEDIA, partSize: 4 }));
    expect(callsOf(seen, "PUT", "/parts/")).toHaveLength(3);
  });
});
