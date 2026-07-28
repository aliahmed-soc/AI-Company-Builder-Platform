// @acbp/adapters — in-memory research fetcher (ACBP-P5-006; CDR-061 §3). The FakeModelProvider pattern again.
//
// `web_research` is a read-only, informational-class tool, and a CONCRETE implementation reaches the public internet
// — a live external resource, and therefore an owner gate. What ships is the port plus this, which is what makes the
// citation rules and the injection boundary provable today.
//
// IT CAN SERVE HOSTILE CONTENT ON PURPOSE. `seedHostile` stores a page whose text contains instructions addressed to
// the model, because a test that only ever fetches well-behaved pages cannot tell whether the untrusted-content
// handling exists. NOT FOR PRODUCTION USE.
import type { FetchedSource, ResearchFetcher } from '@acbp/contracts';

export class InMemoryResearchFetcher implements ResearchFetcher {
  readonly #byQuery = new Map<string, FetchedSource[]>();
  #failNext: string | undefined;
  #calls = 0;

  /** Seed the sources a query returns. Later seeds for the same query replace earlier ones. */
  seed(query: string, sources: readonly FetchedSource[]): void {
    this.#byQuery.set(query, [...sources]);
  }

  /**
   * Seed a page whose CONTENT carries instructions aimed at the model — the NFR-021 case.
   *
   * The page is otherwise ordinary: a real-looking title, a plausible URL. That is the point. Injection does not
   * arrive labelled, and a corpus of obviously-malicious pages proves much less than one that looks like research.
   */
  seedHostile(query: string, source: Omit<FetchedSource, 'content'>, hostileText: string): void {
    const existing = this.#byQuery.get(query) ?? [];
    existing.push({ ...source, content: hostileText });
    this.#byQuery.set(query, existing);
  }

  /** Arm exactly ONE failing fetch — the "source unavailable" branch of the backlog's failure clause. */
  failNextFetch(message: string): void {
    this.#failNext = message;
  }

  /** How many fetches happened. Lets a test assert the worker did not fetch when it was refused earlier. */
  callCount(): number {
    return this.#calls;
  }

  fetch(query: string, options?: { readonly limit?: number }): Promise<readonly FetchedSource[]> {
    this.#calls += 1;
    const failure = this.#failNext;
    this.#failNext = undefined;
    if (failure !== undefined) return Promise.reject(new Error(failure));
    const found = this.#byQuery.get(query) ?? [];
    const limit = options?.limit;
    return Promise.resolve(typeof limit === 'number' && limit >= 0 ? found.slice(0, limit) : [...found]);
  }
}
