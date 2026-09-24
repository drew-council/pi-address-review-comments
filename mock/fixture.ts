import type { FetchResponse } from "../src/types.js";

export const BASE_FILES: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify(
    {
      name: "mock-review-checkpoint-preview",
      private: true,
      type: "module",
      scripts: { test: "bun test" },
    },
    null,
    2,
  )}\n`,
  "src/cart.ts": `export function calculateTotal(subtotalCents: number): number {
  return subtotalCents;
}
`,
  "test/cart.test.ts": `import { expect, test } from "bun:test";
import { calculateTotal } from "../src/cart.js";

test("returns an undiscounted total", () => {
  expect(calculateTotal(1250)).toBe(1250);
});
`,
};

export const PULL_REQUEST_FILES: Readonly<Record<string, string>> = {
  ...BASE_FILES,
  "src/cart.ts": `export function calculateTotal(
  subtotalCents: number,
  discountPercent = 0,
): number {
  const discountCents = subtotalCents * discountPercent;
  return subtotalCents - discountCents;
}

export function formatPrice(cents: number): string {
  return \`$\${cents / 100}\`;
}
`,
  "test/cart.test.ts": `import { expect, test } from "bun:test";
import { calculateTotal, formatPrice } from "../src/cart.js";

test("returns an undiscounted total", () => {
  expect(calculateTotal(1250)).toBe(1250);
});

test("applies a percentage discount", () => {
  expect(calculateTotal(10_000, 20)).toBe(8_000);
});

test("formats cents as currency", () => {
  expect(formatPrice(10)).toBe("$0.10");
  expect(formatPrice(1234)).toBe("$12.34");
});
`,
};

export function createMockFetchResponse(diffPath: string): FetchResponse {
  return {
    repository: "example/mock-shop",
    github_username: "preview-user",
    pull_request: {
      number: 4242,
      title: "Add cart discounts and price formatting",
      body: "Adds percentage discounts and display-price formatting to the cart module.",
      author: "mock-author",
      base_branch: "main",
      head_branch: "feature/cart-discounts",
      head_sha: "mocked-by-launcher",
    },
    authored_diff_path: diffPath,
    review_threads: [
      {
        id: "MOCK_THREAD_discount_math",
        is_resolved: false,
        is_outdated: false,
        path: "src/cart.ts",
        diff_hunk: `@@ -1,3 +1,11 @@
-export function calculateTotal(subtotalCents: number): number {
+export function calculateTotal(
+  subtotalCents: number,
+  discountPercent = 0,
+): number {
+  const discountCents = subtotalCents * discountPercent;
+  return subtotalCents - discountCents;
+}
`,
        current_start_line: 5,
        current_end_line: 5,
        comments: [
          {
            body: "discountPercent is a whole percentage (20 means 20%), so this needs to divide by 100 before subtracting it.",
            author: "reviewer-one",
            author_is_bot: false,
            reactions: [{ content: "THUMBS_UP", author: "mock-author" }],
          },
        ],
      },
      {
        id: "MOCK_THREAD_currency_precision",
        is_resolved: false,
        is_outdated: false,
        path: "src/cart.ts",
        diff_hunk: `@@ -1,3 +1,11 @@
+export function formatPrice(cents: number): string {
+  return \`$\${cents / 100}\`;
+}
`,
        current_start_line: 10,
        current_end_line: 10,
        comments: [
          {
            body: "Please always render two fractional digits. For example, 10 cents should be `$0.10`, not `$0.1`.",
            author: "reviewer-two",
            author_is_bot: false,
          },
        ],
      },
    ],
    review_summaries: [
      {
        body: "Please keep the public function names stable and make sure the new examples are covered by tests.",
        author: "reviewer-one",
        author_is_bot: false,
        reactions: [
          { content: "EYES", author: "reviewer-two" },
          { content: "HOORAY", author: "mock-author" },
        ],
      },
    ],
    stack: null,
  };
}
