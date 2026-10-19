import { test, expect } from "@playwright/test";
test("unlock, inspect, create branch, empty commit, review reset and browse operations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("smoke-token");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page
    .getByRole("button", { name: "smoke-repository", exact: true })
    .click();
  await expect(page.getByText("Clean working tree")).toBeVisible();
  await page.getByRole("button", { name: "Branches", exact: true }).click();
  await page.getByLabel("Branch name", { exact: true }).fill("review");
  await page.getByRole("button", { name: "Create from commit" }).click();
  await expect(page.getByText("branch: success")).toBeVisible();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByLabel("Commit message").fill("manual empty");
  await page.getByLabel("Allow empty commit", { exact: false }).check();
  await page
    .getByRole("button", { name: "Create commit", exact: true })
    .click();
  await expect(page.getByText("commit: success")).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("manual empty", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Review reset", exact: true })
    .last()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Optional backup branch").fill("backup-smoke");
  await page.getByRole("button", { name: "Confirm reset" }).click();
  await expect(page.getByText("reset: success")).toBeVisible();
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Operation history" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText("backup-smoke");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Open repository", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Directory path")).toBeVisible();
});

test("clones a local repository and recovers from a stale access token", async ({
  page,
  request,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("gitui-token", "expired-token"),
  );
  await page.goto("/");
  await expect(page.getByLabel("Access token")).toBeVisible();
  await page.getByLabel("Access token").fill("smoke-token");
  await page.getByRole("button", { name: "Unlock" }).click();
  const response = await request.get("/api/repositories", {
    headers: { Authorization: "Bearer smoke-token" },
  });
  const [repo] = await response.json();
  await page
    .getByRole("button", { name: "Clone repository", exact: true })
    .click();
  await page.getByLabel("Git URL").fill(repo.path);
  await page.getByLabel("Absolute destination").fill(repo.path + "-clone");
  await page.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(page.getByText("clone: success")).toBeVisible();
  await page
    .getByRole("button", { name: "smoke-repository-clone", exact: true })
    .click();
  await expect(page.getByText("Clean working tree")).toBeVisible();
  await page.getByRole("button", { name: "Lock session", exact: true }).click();
  await expect(page.getByLabel("Access token")).toBeVisible();
});
