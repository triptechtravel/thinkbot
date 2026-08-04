import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { githubTools } from './github';
import { datadogTools } from './datadog';
import { sentryTools, rollbarTools } from './errors';
import { clip, since, NotConfiguredError } from './shared';

// A tool's execute() is typed as `T | AsyncIterable<T>` because the SDK
// supports streaming tools. None of ours stream, so results are annotated
// `any` here rather than narrowed at every assertion.

const NOW = Date.now();
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_TOKEN: 'gh-token',
    GITHUB_OWNER: 'example-org',
    DD_API_KEY: 'dd-api',
    DD_APP_KEY: 'dd-app',
    SENTRY_TOKEN: 'sentry-token',
    SENTRY_ORG: 'example-org',
    ROLLBAR_TOKEN: 'rollbar-token',
    ...overrides,
  } as unknown as Env;
}

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('shared helpers', () => {
  it('clips long text so one message cannot dominate context', () => {
    expect(clip('x'.repeat(500), 50)).toHaveLength(50);
    expect(clip('short')).toBe('short');
    expect(clip(null)).toBe('');
  });

  it('builds a window relative to now', () => {
    const t = Date.parse(since(60));
    expect(Date.now() - t).toBeGreaterThan(59 * 60_000);
    expect(Date.now() - t).toBeLessThan(61 * 60_000);
  });
});

describe('github.recentDeploys', () => {
  it('returns only PRs merged inside the window', async () => {
    fetchMock.mockResolvedValue(
      respond([
        { number: 482, title: 'Change auth middleware', merged_at: minsAgo(10), user: { login: 'isaac' }, html_url: 'u1' },
        { number: 480, title: 'Old work', merged_at: minsAgo(600), user: { login: 'isaac' }, html_url: 'u2' },
        { number: 481, title: 'Closed but never merged', merged_at: null, user: null, html_url: 'u3' },
      ]),
    );

    const result: any = await githubTools(env()).recentDeploys.execute!(
      { repo: 'web', withinMinutes: 120 },
      {} as never,
    );

    // The unmerged PR and the one outside the window are both noise here.
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].number).toBe(482);
    expect(result.merged[0].author).toBe('isaac');
  });

  it('says plainly when nothing merged, rather than returning an empty list', async () => {
    fetchMock.mockResolvedValue(respond([]));
    const result: any = await githubTools(env()).recentDeploys.execute!(
      { repo: 'x' },
      {} as never,
    );
    expect(result.note).toContain('Nothing merged');
  });

  it('reports a missing token as configuration, not a crash', async () => {
    await expect(
      githubTools(env({ GITHUB_TOKEN: undefined })).recentDeploys.execute!(
        { repo: 'x' },
        {} as never,
      ),
    ).rejects.toThrow(NotConfiguredError);
  });

  it('reports a missing owner as configuration rather than requesting undefined/x', async () => {
    // There is no default owner: baking one organisation in is what makes a
    // general tool unusable elsewhere. An unset value must not reach a URL.
    await expect(
      githubTools(env({ GITHUB_OWNER: undefined })).recentDeploys.execute!(
        { repo: 'x' },
        {} as never,
      ),
    ).rejects.toThrow(NotConfiguredError);
  });

  it('can filter workflow runs to failures', async () => {
    fetchMock.mockResolvedValue(
      respond({
        workflow_runs: [
          { name: 'deploy', head_branch: 'main', status: 'completed', conclusion: 'failure', created_at: minsAgo(5), html_url: 'u' },
          { name: 'deploy', head_branch: 'main', status: 'completed', conclusion: 'success', created_at: minsAgo(6), html_url: 'u' },
        ],
      }),
    );
    const result: any = await githubTools(env()).recentWorkflowRuns.execute!(
      { repo: 'x', onlyFailures: true },
      {} as never,
    );
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].conclusion).toBe('failure');
  });
});

describe('datadog.datadogQuery', () => {
  function series(values: number[]) {
    return respond({
      series: [
        {
          metric: 'errors',
          scope: 'worker:images',
          pointlist: values.map((v, i) => [NOW - (values.length - i) * 60_000, v]),
        },
      ],
    });
  }

  it('summarises rather than returning every point', async () => {
    fetchMock.mockResolvedValue(series(Array.from({ length: 60 }, () => 10)));
    const result: any = await datadogTools(env()).datadogQuery.execute!(
      { query: 'sum:errors{*}' },
      {} as never,
    );
    // A model reasons better about a summary than 60 raw numbers.
    expect(result.series[0].points).toBe(60);
    expect(result.series[0].avg).toBe(10);
    expect(JSON.stringify(result).length).toBeLessThan(600);
  });

  it('surfaces a step change as a ratio — the number the decision rests on', async () => {
    // Flat, then 4x.
    fetchMock.mockResolvedValue(series([...Array(10).fill(5), ...Array(10).fill(20)]));
    const result: any = await datadogTools(env()).datadogQuery.execute!(
      { query: 'sum:errors{*}' },
      {} as never,
    );
    expect(result.series[0].changeRatio).toBe(4);
  });

  it('reports a ratio near 1 for normal variation', async () => {
    fetchMock.mockResolvedValue(series([10, 11, 9, 10, 11, 9, 10, 10]));
    const result: any = await datadogTools(env()).datadogQuery.execute!(
      { query: 'q' },
      {} as never,
    );
    expect(result.series[0].changeRatio).toBeGreaterThan(0.85);
    expect(result.series[0].changeRatio).toBeLessThan(1.15);
  });

  it('handles a query with no data', async () => {
    fetchMock.mockResolvedValue(respond({ series: [] }));
    const result: any = await datadogTools(env()).datadogQuery.execute!({ query: 'q' }, {} as never);
    expect(result.note).toContain('No data');
  });

  it('needs both keys', async () => {
    await expect(
      datadogTools(env({ DD_APP_KEY: undefined })).datadogQuery.execute!(
        { query: 'q' },
        {} as never,
      ),
    ).rejects.toThrow(NotConfiguredError);
  });
});

describe('sentry.sentryIssues', () => {
  const issue = (over: Record<string, unknown> = {}) => ({
    id: '1',
    title: 'NoMethodError in SessionsController',
    culprit: 'app/controllers/sessions_controller.rb',
    count: '214',
    userCount: 30,
    firstSeen: minsAgo(15),
    lastSeen: minsAgo(1),
    level: 'error',
    permalink: 'https://sentry.io/x',
    status: 'unresolved',
    ...over,
  });

  it('defaults to issues that FIRST appeared in the window', async () => {
    fetchMock.mockResolvedValue(
      respond([issue(), issue({ id: '2', title: 'Long-standing noise', firstSeen: minsAgo(5000) })]),
    );
    const result: any = await sentryTools(env()).sentryIssues.execute!(
      { project: 'web', withinMinutes: 120 },
      {} as never,
    );
    // An exception firing all week does not explain an outage from 20m ago.
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].title).toContain('NoMethodError');
    expect(result.issues[0].events).toBe(214);
  });

  it('can include pre-existing issues when asked', async () => {
    fetchMock.mockResolvedValue(
      respond([issue(), issue({ id: '2', firstSeen: minsAgo(5000) })]),
    );
    const result: any = await sentryTools(env()).sentryIssues.execute!(
      { project: 'p', onlyNew: false },
      {} as never,
    );
    expect(result.issues).toHaveLength(2);
  });

  it('says what a null result means rather than just being empty', async () => {
    fetchMock.mockResolvedValue(respond([]));
    const result: any = await sentryTools(env()).sentryIssues.execute!({ project: 'p' }, {} as never);
    expect(result.note).toContain('not a fresh exception');
  });
});

describe('rollbar.rollbarItems', () => {
  it('filters to items first seen in the window', async () => {
    const secs = (m: number) => Math.floor((NOW - m * 60_000) / 1000);
    fetchMock.mockResolvedValue(
      respond({
        result: {
          items: [
            { id: 1, counter: 1, title: 'New failure', level: 'error', environment: 'production', total_occurrences: 12, first_occurrence_timestamp: secs(10), last_occurrence_timestamp: secs(1), status: 'active' },
            { id: 2, counter: 2, title: 'Old', level: 'error', environment: 'production', total_occurrences: 900, first_occurrence_timestamp: secs(9000), last_occurrence_timestamp: secs(2), status: 'active' },
          ],
        },
      }),
    );
    const result: any = await rollbarTools(env()).rollbarItems.execute!(
      { withinMinutes: 120 },
      {} as never,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('New failure');
  });

  it('reports an API failure with its status', async () => {
    fetchMock.mockResolvedValue(respond({ message: 'nope' }, 403));
    await expect(
      rollbarTools(env()).rollbarItems.execute!({}, {} as never),
    ).rejects.toThrow(/403/);
  });
});
