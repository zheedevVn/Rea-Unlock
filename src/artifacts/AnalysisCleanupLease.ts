import type { AnalysisError } from "../domain/analysisErrorBase.js";

/** Link one resource's confirmed release to its originating analysis error. */
export class AnalysisCleanupLease {
  #released = false;
  #errors: WeakRef<AnalysisError>[] = [];
  readonly #groups = new Set<AnalysisCleanupLeaseGroup>();

  readonly cleanupResources: readonly string[] | undefined;

  constructor(
    private readonly cleanup: () => Promise<void>,
    resources?: readonly string[],
  ) {
    this.cleanupResources =
      resources === undefined ? undefined : [...resources];
  }

  async release(): Promise<void> {
    if (this.#released) return;
    await this.cleanup();
    this.#released = true;
    this.#resolveBoundErrors();
    for (const group of this.#groups) group.ownerReleased(this);
    this.#groups.clear();
  }

  /** Binding can follow a concurrent retry that already confirmed release. */
  bindCleanupError(error: AnalysisError): void {
    if (this.#released) {
      error.resolveCleanup();
      return;
    }
    this.#errors = [
      ...this.#errors.filter((reference) => reference.deref() !== undefined),
      new WeakRef(error),
    ];
  }

  /** Bind one aggregate error to every exact lease in a failed retry set. */
  bindCleanupGroup(group: AnalysisCleanupLeaseGroup): void {
    if (this.#released) {
      group.ownerReleased(this);
      return;
    }
    for (const retained of this.#groups)
      if (!retained.hasLiveError) this.#groups.delete(retained);
    this.#groups.add(group);
  }

  #resolveBoundErrors(): void {
    for (const reference of this.#errors) reference.deref()?.resolveCleanup();
    this.#errors = [];
  }
}

/** Conjunctive cleanup binding for an error covering multiple exact owners. */
export class AnalysisCleanupLeaseGroup {
  readonly #error: WeakRef<AnalysisError>;
  readonly #pending: Set<AnalysisCleanupLease>;

  constructor(error: AnalysisError, owners: readonly AnalysisCleanupLease[]) {
    this.#error = new WeakRef(error);
    this.#pending = new Set(owners);
    if (this.#pending.size === 0) return;
    error.bindCleanupResourceOwner(this);
    for (const owner of this.#pending) owner.bindCleanupGroup(this);
  }

  /** Unlabelled owners keep attribution unknown; never match resources by text. */
  get cleanupResources(): readonly string[] | undefined {
    if (
      [...this.#pending].some((owner) => owner.cleanupResources === undefined)
    )
      return undefined;
    return [
      ...new Set(
        [...this.#pending].flatMap((owner) => owner.cleanupResources ?? []),
      ),
    ];
  }

  get hasLiveError(): boolean {
    return this.#error.deref() !== undefined;
  }

  ownerReleased(owner: AnalysisCleanupLease): void {
    if (!this.#pending.delete(owner) || this.#pending.size > 0) return;
    this.#error.deref()?.resolveCleanup();
    this.#pending.clear();
  }
}
