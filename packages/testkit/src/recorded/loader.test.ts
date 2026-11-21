import { describe, expect, it } from "vitest";
import { loadRecordedAnswers } from "./loader.js";

const entry = {
  request: { method: "POST", url: "https://api.fixture.example/posts", headers: {}, body: "{}" },
  response: { status: 201, headers: { "content-type": "application/json" }, body: '{"id":"post-1"}' },
};

describe("recorded-answer loader", () => {
  it("returns the exchanges of a well-formed file", () => {
    expect(loadRecordedAnswers(JSON.stringify([entry]))).toEqual([entry]);
  });

  it.each([
    ["not JSON", "{"],
    ["not a list", JSON.stringify(entry)],
    ["a status outside HTTP", JSON.stringify([{ ...entry, response: { ...entry.response, status: 99 } }])],
    [
      "a header that is not text",
      JSON.stringify([{ ...entry, request: { ...entry.request, headers: { a: 1 } } }]),
    ],
    [
      "a raw capture with a credential header",
      JSON.stringify([
        {
          ...entry,
          request: {
            ...entry.request,
            headers: { authorization: `Bearer ${["raw", "capture", "1"].join("-")}` },
          },
        },
      ]),
    ],
    [
      "a raw capture with a token in the answer",
      JSON.stringify([
        {
          ...entry,
          response: {
            ...entry.response,
            body: JSON.stringify({ refresh_token: ["raw", "capture", "2"].join("-") }),
          },
        },
      ]),
    ],
    ["more than 500 exchanges", JSON.stringify(Array.from({ length: 501 }, () => entry))],
    ["a file over 5 MiB", `[${" ".repeat(5_242_880)}]`],
  ])("refuses %s", (_name, text) => {
    expect(() => loadRecordedAnswers(text)).toThrow();
  });
});
