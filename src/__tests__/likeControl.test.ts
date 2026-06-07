import { describe, it, expect } from "vitest";
import { resolveLikeAction } from "../utils/likeControl";

describe("resolveLikeAction", () => {
  it("neutral → like fires 'like'", () => { expect(resolveLikeAction(0, 1)).toBe("like"); });
  it("disliked → like fires 'like'", () => { expect(resolveLikeAction(-1, 1)).toBe("like"); });
  it("already liked → like is no-op", () => { expect(resolveLikeAction(1, 1)).toBeNull(); });

  it("neutral → dislike fires 'dislike'", () => { expect(resolveLikeAction(0, -1)).toBe("dislike"); });
  it("liked → dislike fires 'dislike'", () => { expect(resolveLikeAction(1, -1)).toBe("dislike"); });
  it("already disliked → dislike is no-op", () => { expect(resolveLikeAction(-1, -1)).toBeNull(); });

  it("liked → neutral fires 'like' (re-toggle to 0)", () => { expect(resolveLikeAction(1, 0)).toBe("like"); });
  it("disliked → neutral fires 'dislike' (re-toggle to 0)", () => { expect(resolveLikeAction(-1, 0)).toBe("dislike"); });
  it("already neutral → neutral is no-op", () => { expect(resolveLikeAction(0, 0)).toBeNull(); });
});
