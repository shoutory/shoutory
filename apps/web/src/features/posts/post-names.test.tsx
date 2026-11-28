import { afterEach, describe, expect, it } from "vitest";
import { channelPage, channelRow, closeApp, openApp, settle, uuidWorkspaces } from "../../../test/support/app";
import {
  CHANNEL_ONE,
  CHANNEL_TWO,
  detailAnswer,
  detailTarget,
  POST_WS,
  postId,
  stubPostApi,
  variantId,
} from "../../../test/support/post-api";

afterEach(closeApp);

describe("the name of a channel on the post page", () => {
  it("is its nickname when it has one and its own name when it has none", async () => {
    stubPostApi({
      workspaces: uuidWorkspaces(),
      channelList: () =>
        channelPage(
          [
            channelRow({ id: CHANNEL_ONE, display_name: "Acme Page", nickname: "Shop front" }),
            channelRow({ id: CHANNEL_TWO, display_name: "Acme Shop", nickname: null }),
          ],
          null,
          [],
        ),
      postDetail: () =>
        detailAnswer([
          detailTarget({ variant_id: variantId(1) }),
          detailTarget({ variant_id: variantId(2), channel_id: CHANNEL_TWO }),
        ]),
    });
    const { host } = await openApp(`/w/${POST_WS}/posts/${postId(1)}`);
    await settle();
    const names = [...host.querySelectorAll('[data-testid="target-heading"]')].map((one) => one.textContent);
    expect(names).toEqual(["Shop front", "Acme Shop"]);
  });
});
