import type { Locator, Page } from "@playwright/test";

/** Where the founder's top bar shows names the run made up. */
const TOP_BAR = ['[data-testid="switcher-organization"]', '[data-testid="switcher-workspace"]'];
const HEADING = '[data-testid="workspace-name"]';

/**
 * What differs from one run to the next on a screen, by selector: names with a random tag, people's addresses, times,
 * counts and a date that moves with the day. Only these are masked; everything else is compared.
 */
const cells = (table: string, ...columns: number[]): string[] =>
  columns.map((column) => `[data-testid="${table}"] tbody td:nth-child(${column})`);

// A table's headers, other columns, buttons and alignment stay in the picture: only the cells that hold a name, an
// address, a time or a measure are covered.
const VOLATILE: Readonly<Record<string, readonly string[]>> = {
  start: [HEADING],
  workspace: [HEADING],
  profile: ['main input[name="name"]', 'main input[type="email"]'],
  security: cells("sessions-scroll", 1, 2),
  general: ['main input[name="name"]', 'main input[name="slug"]'],
  members: [...cells("members-scroll", 1), ...cells("invitations-scroll", 1, 3)],
  clients: cells("clients-scroll", 1, 2),
  flags: ['[data-testid="flag-remove-by"]'],
  queue: [...cells("queue-scroll", 1, 3), "main dl > div:nth-child(-n+2) dd"],
  releases: ['[data-testid="release-migrations"]'],
};

// The server's own values that change from run to run, in the same shape every run: a time is shown at its length,
// and a worker's id is as long and made of the same marks. The values are fixed in the answers the page reads.
const FIXED_PAST = "2026-01-01T10:00:00.000Z";
const FIXED_FUTURE = "2099-01-01T10:00:00.000Z";

type Json = Record<string, unknown>;
const rowsOf = (body: unknown): Json[] => {
  const inner = (body as { data?: unknown }).data ?? body;
  return Array.isArray(inner) ? (inner as Json[]) : [];
};

/** Answers of the pages' lists with their times and worker ids replaced by fixed ones (call before opening a screen). */
export async function freezeVolatileValues(page: Page): Promise<void> {
  const rewrite = async (pattern: RegExp, change: (body: Json, rows: Json[]) => void) => {
    await page.route(pattern, async (route) => {
      const answer = await route.fetch();
      if (!answer.ok()) return route.fulfill({ response: answer });
      const body = (await answer.json()) as Json;
      change(body, rowsOf(body));
      return route.fulfill({ response: answer, json: body });
    });
  };
  await rewrite(/\/invitations\?/, (_, rows) => {
    for (const row of rows) row.expires_at = FIXED_FUTURE;
  });
  await rewrite(/\/api\/auth\/sessions$/, (_, rows) => {
    for (const row of rows) row.createdAt = FIXED_PAST;
  });
  await rewrite(/\/api\/v1\/admin\/queue$/, (body) => {
    const workers = ((body.data as Json | undefined)?.workers ?? body.workers) as Json[] | undefined;
    for (const [index, worker] of (workers ?? []).entries()) {
      worker.worker_id = `00000000-0000-4000-8000-00000000000${index}`;
      worker.seen_at = FIXED_PAST;
      worker.stale = false;
    }
  });
}

/** The regions of a screen to cover in its screenshot. */
export function masksFor(page: Page, screenId: string, signedIn: boolean): Locator[] {
  const selectors = [...(signedIn ? TOP_BAR : []), ...(VOLATILE[screenId] ?? [])];
  return selectors.map((selector) => page.locator(selector));
}
