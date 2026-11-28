import { afterEach, describe, expect, it } from "vitest";
import { closeApp, openApp, settle, uuidWorkspaces } from "../../../test/support/app";
import {
  CHANNEL_THREE,
  detailAnswer,
  detailTarget,
  operation,
  POST_WS,
  postId,
  stubPostApi,
} from "../../../test/support/post-api";

afterEach(closeApp);

async function visit(change: Record<string, unknown>, locale: "en" | "ar" = "en") {
  stubPostApi({
    workspaces: uuidWorkspaces(),
    postDetail: () => detailAnswer([detailTarget(change)]),
  });
  const { host } = await openApp(`/w/${POST_WS}/posts/${postId(1)}`, locale);
  await settle();
  return host;
}
const text = (host: ParentNode, id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.textContent;
const waiting = {
  published_at: null,
  schedule_state: "scheduled",
  due_at: "2026-12-01T09:00:00.000Z",
  due_tz: "UTC",
  operation: operation({ state: "pending", effect: "none" }),
};
const inState = (state: string, change: Record<string, unknown> = {}, effect = "none") => ({
  published_at: null,
  operation: operation({ state, effect, ...change }),
});

// [case, the target, its word in English, its word in Arabic, a phrase of the line under it]: the one table of what a
// target says for each state, the list rows and the post page alike.
const WORDS: [string, Record<string, unknown>, string, string, string][] = [
  [
    "a draft",
    { published_at: null, schedule_state: "draft", operation: null },
    "Draft",
    "مسودة",
    "Not scheduled yet",
  ],
  ["pending", waiting, "Waiting for its time", "بانتظار موعده", "Goes out"],
  ["claimed", inState("claimed"), "Getting ready", "جارٍ التحضير", "Preparing to send"],
  [
    "processing",
    inState("processing"),
    "Fixture Network is preparing the media",
    "Fixture Network تجهّز الوسائط",
    "this usually takes a few minutes",
  ],
  ["dispatching", inState("dispatching"), "Sending", "جارٍ الإرسال", "Being sent to Fixture Network"],
  [
    "provider_accepted",
    inState("provider_accepted"),
    "Accepted by Fixture Network, finishing",
    "قبلته Fixture Network وتُنهيه الآن",
    "we are confirming",
  ],
  ["retry_wait", inState("retry_wait"), "Will retry", "ستُعاد المحاولة", "Nothing was posted yet."],
  [
    "paused",
    inState("paused", { reason_code: "quota" }),
    "Paused: quota reached",
    "متوقف مؤقتًا: بلوغ الحصة",
    "We will continue",
  ],
  [
    "blocked_reconnect",
    { ...inState("blocked_reconnect"), channel_id: CHANNEL_THREE },
    "Held: reconnect Acme Blog",
    "محجوز: أعد ربط Acme Blog",
    "Reconnect by",
  ],
  [
    "unknown_external_state",
    inState("unknown_external_state", {}, "possible"),
    "Checking whether it was posted",
    "نتحقق مما إذا كان قد نُشر",
    "we have not posted again",
  ],
  [
    "reconciling",
    inState("reconciling", {}, "possible"),
    "Checking Fixture Network now",
    "نراجع Fixture Network الآن",
    "We are reading the channel to confirm",
  ],
  [
    "needs_human",
    inState("needs_human", {}, "possible"),
    "Needs your check",
    "يحتاج إلى تحققك",
    "could not confirm this",
  ],
  [
    "needs_human past due",
    inState("needs_human", { reason_code: "past_due_after_reconnect" }),
    "Nothing was posted; its time passed",
    "لم يُنشر شيء؛ فات موعده",
    "Posting now would be late",
  ],
  [
    "unverified",
    inState("unverified", {}, "possible"),
    "Could not be confirmed",
    "تعذّر التأكد",
    "still blocks new posts",
  ],
  ["published", { operation: operation({ state: "published" }) }, "Published", "نُشر", ""],
  ["failed, nothing sent", inState("failed"), "Failed", "فشل", "Nothing was posted to Acme Page"],
  [
    "failed, a thread part",
    inState("failed", { part_index: 3 }),
    "Failed",
    "فشل",
    "Parts 1 to 3 are live; part 4 was not posted",
  ],
  ["missed", inState("missed"), "Missed", "فات موعده", "we never send late"],
  ["cancelled", inState("cancelled"), "Cancelled", "أُلغي", "cancelled before anything was sent"],
  [
    "replaced",
    inState("superseded_after_unknown_outcome", {}, "possible"),
    "Replaced after an unclear result",
    "استُبدل بعد نتيجة غير واضحة",
    "we are still watching for the old one",
  ],
  [
    "an edit being sent",
    { operation: operation({ kind: "edit", state: "dispatching" }) },
    "Applying your edit",
    "جارٍ تطبيق تعديلك",
    "still show the old text",
  ],
  [
    "an edit that failed",
    { operation: operation({ kind: "edit", state: "failed" }) },
    "Edit not applied",
    "لم يُطبَّق التعديل",
    "earlier text",
  ],
  [
    "a removal under way",
    { presence: "removal_pending", operation: operation({ kind: "delete", state: "dispatching" }) },
    "Removing from Fixture Network",
    "جارٍ الحذف من Fixture Network",
    "We are confirming",
  ],
  [
    "a removal not confirmed",
    { presence: "removal_unknown", operation: operation({ kind: "delete", state: "needs_human" }) },
    "We could not confirm it was removed",
    "لم نتأكد من الحذف",
    "Open Fixture Network",
  ],
];

describe("the word and meaning of each target", () => {
  it.each(WORDS)("%s", async (_name, change, en, ar, meaning) => {
    const english = await visit(change);
    expect(text(english, "target-word")).toContain(en);
    expect(text(english, "target-meaning")).toContain(meaning);
    closeApp();
    const arabic = await visit(change, "ar");
    expect(text(arabic, "target-word")).toContain(ar);
  });
});
