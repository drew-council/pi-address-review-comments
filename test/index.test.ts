import { expect, test } from "bun:test";
import extension from "../src/index.js";

test("exports an extension factory", () => {
  expect(typeof extension).toBe("function");
});
