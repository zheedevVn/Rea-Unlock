import { AnalysisCleanupLease } from "../../artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../../artifacts/ArtifactFileOperation.js";
import { SharedStartupAttempt } from "../../process/SharedStartupAttempt.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import {
  analysisProviderIdSchema,
  analysisProviderSelectorSchema,
  type AnalysisProviderSelector,
} from "../../contracts/providerSelection.js";
import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  ProviderSelectionError,
  type ProviderSelectionFailureReason,
  type ProviderSelectionRejection,
} from "../../domain/providerSelectionError.js";
import { jsonObjectSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  AnalysisProviderCandidate,
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderIdentity,
  ProviderTargetSupport,
} from "../AnalysisProvider.js";
import {
  evaluateAnalysisProviderCandidate,
  type AnalysisProviderCandidateEvaluation,
} from "./AnalysisProviderEvaluation.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import type { FileCloseResourceOwner } from "../AnalysisProvider.js";

/** Deterministic discovery truth for one configured deep provider. */
export interface AnalysisProviderCandidateStatus {
  readonly provider: ProviderIdentity;
  readonly availability: ProviderAvailability;
  readonly targetSupport:
    | ProviderTargetSupport
    | {
        /** No target has been parsed, so support has not been evaluated. */
        readonly status: "unknown";
        readonly code: null;
        readonly reason: string;
        readonly diagnostics: Readonly<Record<string, JsonValue>>;
      };
  readonly selected: boolean;
  readonly capabilities: readonly CapabilityDescriptor[];
}

/** One immutable deep-provider binding selected before client startup. */
export interface AnalysisProviderBinding {
  readonly provider: AnalysisProviderCandidate;
  readonly identity: ProviderIdentity & { readonly version: string };
  readonly selectionSource: "request" | "environment" | "auto-single-candidate";
  readonly profile: AnalysisProfileCommitment;
  /** The provider's capabilities, attributed to its resolved identity. */
  readonly capabilities: readonly CapabilityDescriptor[];
}

/** Complete result used for both a bound and intentionally unbound target. */
export interface AnalysisProviderSelection {
  readonly requestedProviderId: string;
  readonly binding: AnalysisProviderBinding | null;
  readonly candidates: readonly AnalysisProviderCandidateStatus[];
}

interface TargetSelectionContext {
  readonly target: BinaryTarget;
  readonly baseline: readonly AnalysisProviderCandidateStatus[];
  readonly signal: AbortSignal | undefined;
}

type SelectionResult = Result<AnalysisProviderSelection, AnalysisError>;

/**
 * Discover and select overlapping deep providers without starting their clients.
 * Registration order never affects selection or caller-visible output.
 */
export class AnalysisProviderRegistry {
  readonly #providers: readonly AnalysisProviderCandidate[];
  readonly #byId: ReadonlyMap<string, AnalysisProviderCandidate>;
  readonly #declaredOperations: readonly string[];
  readonly #defaultSelector: AnalysisProviderSelector;

  readonly #selections = new Set<SharedStartupAttempt<SelectionResult>>();
  readonly #selectionCleanup = new Set<AnalysisError>();
  readonly #profileFiles = new ArtifactResourceScope();
  readonly #profileFileOwner: FileCloseResourceOwner = {
    retain: (owner, resource) =>
      this.#profileFiles.retain({
        kind: "lease",
        resource,
        lease: new AnalysisCleanupLease(() => owner.close(), [resource]),
      }),
    run: (operation) => this.#profileFiles.run(operation),
  };
  #closing: Promise<Result<null, AnalysisError>> | undefined;

  constructor(
    providers: readonly AnalysisProviderCandidate[],
    defaultSelector: AnalysisProviderSelector = "auto",
    private readonly canInspectWithoutDeepProvider?: (
      target: BinaryTarget,
    ) => boolean,
  ) {
    this.#defaultSelector =
      analysisProviderSelectorSchema.parse(defaultSelector);
    const byId = new Map<string, AnalysisProviderCandidate>();
    const declaredOperations = new Set<string>();
    for (const provider of providers) {
      const identity = provider.identity();
      if (!analysisProviderIdSchema.safeParse(identity.id).success)
        throw new TypeError(`Invalid analysis provider ID: ${identity.id}`);
      if (byId.has(identity.id))
        throw new TypeError(`Duplicate analysis provider ID: ${identity.id}`);
      const providerOperations = new Set<string>();
      for (const capability of provider.capabilities()) {
        if (
          capability.provider.id !== identity.id ||
          capability.provider.name !== identity.name ||
          capability.provider.version !== identity.version
        )
          throw new TypeError(
            `Provider ${identity.id} published mismatched capability provenance for ${capability.operation}`,
          );
        if (providerOperations.has(capability.operation))
          throw new TypeError(
            `Provider ${identity.id} declares operation ${capability.operation} more than once`,
          );
        providerOperations.add(capability.operation);
        declaredOperations.add(capability.operation);
      }
      byId.set(identity.id, provider);
    }
    this.#providers = Object.freeze(
      [...providers].sort((left, right) =>
        compareUnicodeCodePoints(left.identity().id, right.identity().id),
      ),
    );
    this.#byId = byId;
    this.#declaredOperations = Object.freeze(
      [...declaredOperations].sort((left, right) =>
        compareUnicodeCodePoints(left, right),
      ),
    );
  }

  /** Return the configured default without interpreting it as priority. */
  defaultSelector(): AnalysisProviderSelector {
    return this.#defaultSelector;
  }

  /** List configured candidate identities in canonical provider-ID order. */
  identities(): readonly ProviderIdentity[] {
    return this.#providers.map((provider) =>
      structuredClone(provider.identity()),
    );
  }

  /** Report retained candidate resources without retrying cleanup. */
  hasPendingOwnedResources(): boolean {
    return (
      this.#selections.size > 0 ||
      this.#profileFiles.hasPending ||
      [...this.#selectionCleanup].some((error) => error.cleanupIncomplete) ||
      this.#providers.some(
        (provider) => provider.hasPendingOwnedResources?.() === true,
      )
    );
  }

  /** Close candidate-owned resources even when no target client was opened. */
  closeOwnedResources(): Promise<Result<null, AnalysisError>> {
    this.#closing ??= Promise.resolve()
      .then(() => this.#closeOwnedResources())
      .finally(() => {
        this.#closing = undefined;
      });
    return this.#closing;
  }

  async #closeOwnedResources(): Promise<Result<null, AnalysisError>> {
    const selections = [...this.#selections];
    for (const selection of selections) selection.close();
    await Promise.allSettled(selections.map((selection) => selection.promise));
    const failures: AnalysisError[] = [];
    try {
      await this.#profileFiles.retryCleanup();
    } catch (cause: unknown) {
      const cleanup = ArtifactReaderFailure.cleanupObservation(
        cause,
        "provider profile files",
      );
      const failure = new ProviderCleanupError(
        "rea",
        cleanup.resources,
        { reason: cleanup.reason },
        { cause },
      );
      bindArtifactFileCleanup(cause, failure);
      failures.push(failure);
    }
    for (const provider of this.#providers) {
      if (provider.closeOwnedResources === undefined) continue;
      const result = await provider.closeOwnedResources();
      if (!result.ok) failures.push(result.error);
    }
    for (const failure of this.#selectionCleanup) {
      if (failure.cleanupIncomplete) failures.push(failure);
      else this.#selectionCleanup.delete(failure);
    }
    const distinct = [...new Set(failures)];
    if (distinct.length === 0) return ok(null);
    if (distinct.length === 1) return err(distinct[0]!);
    return err(
      new ProviderCleanupError(
        "rea",
        [...new Set(distinct.flatMap((failure) => failure.cleanupResources))],
        { reason: distinct.map((failure) => failure.message).join("; ") },
        { cause: new AggregateError(distinct) },
      ).bindCleanupDependencies(
        distinct.filter((failure) => failure.cleanupIncomplete),
      ),
    );
  }

  /** List the unique deep-operation declarations without probing candidates. */
  declaredOperations(): readonly string[] {
    return [...this.#declaredOperations];
  }

  /** Discover candidates for status without resolving profiles or starting clients. */
  candidates(
    target?: BinaryTarget,
  ): readonly AnalysisProviderCandidateStatus[] {
    return this.#providers.map((provider) => candidateStatus(provider, target));
  }

  /** Select one whole deep-operation family for a parsed target. */
  async select(
    target: BinaryTarget,
    requestedSelector?: AnalysisProviderSelector,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SelectionResult> {
    if (signalIsAborted(options.signal))
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        }),
      );
    if (this.#closing !== undefined) {
      const closed = await this.#closing;
      if (!closed.ok) return closed;
    }
    for (const failure of this.#selectionCleanup)
      if (!failure.cleanupIncomplete) this.#selectionCleanup.delete(failure);
    if (
      [...this.#selectionCleanup].some((failure) => failure.cleanupIncomplete)
    ) {
      // A retry may release retained owners; never stop another live selection
      // merely because a new caller wants admission.
      if (this.#selections.size > 0)
        return err(
          [...this.#selectionCleanup].find(
            (failure) => failure.cleanupIncomplete,
          )!,
        );
      const closed = await this.closeOwnedResources();
      if (!closed.ok) return closed;
    }
    if (signalIsAborted(options.signal))
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        }),
      );
    const selection = new SharedStartupAttempt<SelectionResult>(
      (signal) =>
        Promise.resolve().then(() =>
          this.#selectTarget(target, requestedSelector, signal),
        ),
      options.signal,
    );
    this.#selections.add(selection);
    void selection.promise.then(
      (result) => {
        this.#selections.delete(selection);
        if (!result.ok && result.error.cleanupIncomplete)
          this.#selectionCleanup.add(result.error);
      },
      () => {
        this.#selections.delete(selection);
      },
    );
    const waited = await selection.wait(options.signal);
    if (waited.status !== "cancelled") {
      if (!waited.value.ok) return waited.value;
      if (!selection.signal.aborted) return waited.value;
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: selection.signal.reason,
        }),
      );
    }
    return err(
      new AnalysisCancelledError("open_binary", {
        cause: options.signal?.reason,
      }),
    );
  }

  async #selectTarget(
    target: BinaryTarget,
    requestedSelector: AnalysisProviderSelector | undefined,
    signal: AbortSignal,
  ): Promise<SelectionResult> {
    if (signalIsAborted(signal))
      return err(
        new AnalysisCancelledError("open_binary", { cause: signal.reason }),
      );
    const parsedRequest =
      requestedSelector === undefined
        ? undefined
        : analysisProviderSelectorSchema.safeParse(requestedSelector);
    if (parsedRequest !== undefined && !parsedRequest.success)
      return err(
        selectionError(
          "invalid_options",
          typeof requestedSelector === "string"
            ? requestedSelector
            : "<invalid>",
          this.candidates(target),
        ),
      );
    const request = parsedRequest?.data;
    const selector = request ?? this.#defaultSelector;
    const baseline = this.candidates(target);
    if (signalIsAborted(signal))
      return err(
        new AnalysisCancelledError("open_binary", { cause: signal.reason }),
      );
    if (selector === "auto" && this.canInspectWithoutDeepProvider?.(target))
      return ok({
        requestedProviderId: selector,
        binding: null,
        candidates: baseline,
      });
    if (
      request === undefined &&
      this.#byId.has(selector) &&
      baseline.length > 0 &&
      baseline.every(
        ({ targetSupport }) => targetSupport.status === "unsupported",
      )
    )
      return ok({
        requestedProviderId: selector,
        binding: null,
        candidates: baseline,
      });
    if (selector !== "auto")
      return this.#selectConcrete(
        {
          target,
          baseline,
          signal: signal,
        },
        selector,
        request === undefined ? "environment" : "request",
      );
    return this.#selectAutomatically({
      target,
      baseline,
      signal: signal,
    });
  }

  /** Explain why a deep operation is unavailable on an unbound target. */
  unboundOperationError(
    operation: string,
    selection: AnalysisProviderSelection,
  ): ProviderSelectionError {
    const reason: ProviderSelectionFailureReason =
      selection.candidates.length > 0 &&
      selection.candidates.every(
        ({ targetSupport }) => targetSupport.status === "unsupported",
      )
        ? "target_unsupported"
        : "provider_unavailable";
    return selectionError(
      reason,
      selection.requestedProviderId,
      selection.candidates,
      operation,
    );
  }

  async #selectConcrete(
    context: TargetSelectionContext,
    providerId: string,
    source: AnalysisProviderBinding["selectionSource"],
  ): Promise<Result<AnalysisProviderSelection, AnalysisError>> {
    const { baseline, signal, target } = context;
    const provider = this.#byId.get(providerId);
    if (provider === undefined)
      return err(selectionError("unknown_provider", providerId, baseline));
    const initial = baseline.find(
      ({ provider: identity }) => identity.id === providerId,
    );
    if (initial === undefined)
      throw new TypeError(
        "Registered provider is absent from discovery output",
      );
    if (initial.targetSupport.status !== "supported")
      return err(selectionError("target_unsupported", providerId, baseline));
    if (initial.availability.status === "unavailable")
      return err(selectionError("provider_unavailable", providerId, baseline));
    const evaluation = await evaluateAnalysisProviderCandidate(
      provider,
      initial,
      target,
      signal,
      this.#profileFileOwner,
    );
    if (!evaluation.ok) return evaluation;
    const evaluated = evaluation.value;
    if (evaluated.profileError !== undefined)
      return err(evaluated.profileError);
    const statuses = replaceCandidate(baseline, evaluated.status);
    if (evaluated.profile === undefined)
      return err(selectionError("provider_unavailable", providerId, statuses));
    return ok(
      selectedResult(
        providerId,
        source,
        {
          ...evaluated,
          profile: evaluated.profile,
        },
        statuses,
      ),
    );
  }

  async #selectAutomatically(
    context: TargetSelectionContext,
  ): Promise<Result<AnalysisProviderSelection, AnalysisError>> {
    const { baseline, signal, target } = context;
    const results = await Promise.all(
      this.#providers.map(
        async (
          provider,
        ): Promise<
          Result<AnalysisProviderCandidateEvaluation, AnalysisCancelledError>
        > => {
          const status = baseline.find(
            ({ provider: identity }) => identity.id === provider.identity().id,
          );
          if (status === undefined)
            throw new TypeError(
              "Registered provider is absent from discovery output",
            );
          return status.availability.status === "available" &&
            status.targetSupport.status === "supported"
            ? evaluateAnalysisProviderCandidate(
                provider,
                status,
                target,
                signal,
                this.#profileFileOwner,
              )
            : ok({
                candidate: provider,
                status,
              } satisfies AnalysisProviderCandidateEvaluation);
        },
      ),
    );
    const evaluations = results.flatMap((result) =>
      result.ok ? [result.value] : [],
    );
    const failures = results.flatMap((result, index) => {
      const error = result.ok ? result.value.profileError : result.error;
      return error === undefined
        ? []
        : [{ providerId: this.#providers[index]!.identity().id, error }];
    });
    if (
      results.some((result) => !result.ok) ||
      failures.some(({ error }) => error.cleanupIncomplete) ||
      signalIsAborted(signal)
    )
      return err(profileSelectionFailure(failures, signal));
    const statuses = evaluations.map(({ status }) => status);
    const usable = evaluations.filter(
      (
        evaluation,
      ): evaluation is AnalysisProviderCandidateEvaluation & {
        readonly profile: AnalysisProfileCommitment;
      } => evaluation.profile !== undefined,
    );
    if (usable.length === 0)
      return ok({
        requestedProviderId: "auto",
        binding: null,
        candidates: statuses,
      });
    if (usable.length > 1)
      return err(selectionError("ambiguous", "auto", statuses));
    const selected = usable[0];
    if (selected === undefined)
      throw new TypeError("Usable provider selection disappeared");
    return ok(
      selectedResult("auto", "auto-single-candidate", selected, statuses),
    );
  }
}

const candidateStatus = (
  provider: AnalysisProviderCandidate,
  target: BinaryTarget | undefined,
): AnalysisProviderCandidateStatus => {
  const readiness = provider.inspectReadinessSnapshot?.() ?? {
    availability: provider.inspectAvailability(),
    capabilities: provider.capabilities(),
  };
  return {
    provider: structuredClone(provider.identity()),
    availability: cloneAvailability(readiness.availability),
    targetSupport:
      target === undefined
        ? {
            status: "unknown",
            code: null,
            reason: "No target is open.",
            diagnostics: {},
          }
        : cloneTargetSupport(provider.inspectTargetSupport(target)),
    selected: false,
    capabilities: readiness.capabilities.map((capability) =>
      structuredClone(capability),
    ),
  };
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const selectedResult = (
  requestedProviderId: string,
  source: AnalysisProviderBinding["selectionSource"],
  evaluated: AnalysisProviderCandidateEvaluation & {
    readonly profile: AnalysisProfileCommitment;
  },
  statuses: readonly AnalysisProviderCandidateStatus[],
): AnalysisProviderSelection => {
  const identity = evaluated.profile.provider;
  const capabilities = evaluated.status.capabilities.map((capability) => ({
    ...capability,
    provider: structuredClone(identity),
  }));
  const selectedStatus = {
    ...evaluated.status,
    provider: structuredClone(identity),
    selected: true,
    capabilities,
  } satisfies AnalysisProviderCandidateStatus;
  return {
    requestedProviderId,
    binding: {
      provider: evaluated.candidate,
      identity: structuredClone(identity),
      selectionSource: source,
      profile: structuredClone(evaluated.profile),
      capabilities,
    },
    candidates: replaceCandidate(statuses, selectedStatus),
  };
};

const replaceCandidate = (
  statuses: readonly AnalysisProviderCandidateStatus[],
  replacement: AnalysisProviderCandidateStatus,
): readonly AnalysisProviderCandidateStatus[] =>
  statuses.map((status) =>
    status.provider.id === replacement.provider.id ? replacement : status,
  );

const selectionError = (
  reason: ProviderSelectionFailureReason,
  requestedProviderId: string,
  candidates: readonly AnalysisProviderCandidateStatus[],
  operation = "open_binary",
): ProviderSelectionError =>
  new ProviderSelectionError({
    operation,
    reason,
    requestedProviderId,
    candidateIds: candidates.map(({ provider }) => provider.id),
    rejections: candidateRejections(candidates),
  });

const candidateRejections = (
  candidates: readonly AnalysisProviderCandidateStatus[],
): readonly ProviderSelectionRejection[] =>
  candidates.flatMap((candidate) =>
    [
      ...(candidate.availability.status === "unavailable"
        ? [candidate.availability]
        : []),
      ...(candidate.targetSupport.status === "unsupported"
        ? [candidate.targetSupport]
        : []),
    ].map((rejection) => ({
      providerId: candidate.provider.id,
      code: rejection.code,
      reason: rejection.reason,
      diagnostics: structuredClone(rejection.diagnostics),
    })),
  );

const cloneAvailability = (
  availability: ProviderAvailability,
): ProviderAvailability => ({
  ...availability,
  diagnostics: jsonObjectSchema.parse(availability.diagnostics),
});

const cloneTargetSupport = (
  support: ProviderTargetSupport,
): ProviderTargetSupport => ({
  ...support,
  diagnostics: jsonObjectSchema.parse(support.diagnostics),
});

/** Every terminal child remains attributed; cleanup is conjunctive across owners. */
const profileSelectionFailure = (
  failures: readonly {
    readonly providerId: string;
    readonly error: AnalysisError;
  }[],
  signal?: AbortSignal,
): AnalysisError => {
  const primary =
    failures.find(({ error }) => !(error instanceof AnalysisCancelledError)) ??
    failures[0];
  if (primary === undefined)
    return new AnalysisCancelledError("open_binary", { cause: signal?.reason });
  if (failures.length === 1) return primary.error;
  const cleanupFailures = failures
    .filter(({ error }) => error.cleanupIncomplete)
    .map(({ error }) => error);
  const options = {
    diagnostics: {
      profile_errors: failures.map(({ providerId, error }) => ({
        provider_id: providerId,
        error: projectAnalysisError(error),
      })),
    },
    ...(primary.error.capturedOutput === undefined
      ? {}
      : { capturedOutput: primary.error.capturedOutput }),
    ...(primary.error.partialObservation === undefined
      ? {}
      : { partialObservation: primary.error.partialObservation }),
    ...(cleanupFailures.length === 0
      ? {}
      : {
          cleanup: {
            reason: cleanupFailures.map((error) => error.message).join("; "),
            resources: [
              ...new Set(
                cleanupFailures.flatMap((error) => error.cleanupResources),
              ),
            ],
          },
        }),
  };
  const failure =
    primary.error instanceof AnalysisCancelledError
      ? new AnalysisCancelledError("open_binary", {
          ...options,
          cause: primary.error.cause,
        })
      : new ProviderAdapterError("rea", "resolve_analysis_profile", {
          ...options,
          userMessage: projectAnalysisError(primary.error).message,
          cause: new AggregateError(
            failures.map(({ error }) => error),
            "Provider profile resolutions failed",
            { cause: primary.error },
          ),
        });
  return failure.bindCleanupDependencies(cleanupFailures);
};
