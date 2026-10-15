import { randomUUID } from "node:crypto";

import { z } from "zod";
import type { Page } from "playwright-core";

import { browserObservationEndpointSchema } from "../domain/browserObservation.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { CdpConnection } from "./CdpConnection.js";
import { withCdpDiscoveryDeadline } from "./CdpEndpoint.js";
import {
  attachCdpTargetSession,
  openCdpEndpoint,
  type CdpTargetSession,
} from "./CdpTargetSession.js";
import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";

const OPERATION = "capture_browser_scenario" as const;
const scriptResponse = z.object({ identifier: z.string() });
const attachedEvent = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ type: z.string() }),
});
const detachedEvent = z.object({ sessionId: z.string() });
type PolicyTarget = {
  readonly id: string;
  ready: Promise<void>;
  identifier?: string;
};

/** Owns only its frame scripts and registration wrappers, never caller-owned workers. */
export class PlaywrightScenarioServiceWorkers {
  private readonly marker = JSON.stringify(
    `rea-service-workers-${randomUUID()}`,
  );
  private readonly restoreKey = JSON.stringify(`rea-restore-${randomUUID()}`);
  private readonly secret = JSON.stringify(randomUUID());
  #initialization: Promise<void> | undefined;
  #restoration: Promise<void> | undefined;
  #session: CdpTargetSession | undefined;
  #targets = new Map<string, PolicyTarget>();
  #closed = false;
  #released = false;
  #detached = false;
  #removeListener: (() => void) | undefined;
  #setup = new AbortController();

  constructor(
    private readonly page: Page,
    private readonly endpoint: string,
    private readonly targetId: string,
  ) {}

  initialize(): Promise<void> {
    return (this.#initialization ??= this.install());
  }

  private async install(): Promise<void> {
    this.#session = await withCdpDiscoveryDeadline(
      OPERATION,
      this.#setup.signal,
      async (signal) => {
        await withPlaywrightExecutionBoundary(
          () => this.assertBlocked(),
          undefined,
          signal,
        );
        const opened = await openCdpEndpoint(
          browserObservationEndpointSchema.parse(this.endpoint),
          OPERATION,
          signal,
        );
        const target = opened.discovery.targets.find(
          ({ id }) => id === this.targetId,
        );
        if (target === undefined) {
          await opened.connection?.close();
          throw new BrowserObservationError(OPERATION, "target_not_found");
        }
        const connection =
          opened.connection ??
          (await CdpConnection.connect(
            opened.discovery.webSocket.url,
            OPERATION,
            signal,
          ));
        return await attachCdpTargetSession(
          connection,
          target,
          OPERATION,
          signal,
        );
      },
    );
    const connection = this.#session.connection;
    this.#removeListener = connection.onEvent((event) => {
      if (
        event.method === "Target.attachedToTarget" &&
        this.#targets.has(event.sessionId ?? "")
      ) {
        const { sessionId, targetInfo } = attachedEvent.parse(event.params);
        if (targetInfo.type === "iframe") this.addTarget(sessionId);
      } else if (event.method === "Target.detachedFromTarget") {
        const id = detachedEvent.parse(event.params).sessionId;
        this.#targets.delete(id);
        if (id === this.#session?.sessionId) this.#detached = true;
      }
    });
    const id = this.#session.sessionId;
    if (id === undefined)
      throw new BrowserObservationError(OPERATION, "protocol_error");
    this.addTarget(id);
    await this.settle();
    // CDP returns an identifier even when an init script throws in a realm.
    await withPlaywrightExecutionBoundary(
      () => this.assertBlocked(),
      undefined,
      this.#setup.signal,
    );
  }

  private addTarget(id: string): void {
    const target: PolicyTarget = { id, ready: Promise.resolve() };
    this.#targets.set(id, target);
    const ready = this.initializeTarget(target);
    target.ready = ready;
    void ready.catch(() => undefined);
  }

  private async initializeTarget(target: PolicyTarget): Promise<void> {
    try {
      if (this.#closed) return;
      await this.send(target.id, "Page.enable");
      if (this.#closed) return;
      const added = scriptResponse.parse(
        await this.send(target.id, "Page.addScriptToEvaluateOnNewDocument", {
          runImmediately: true,
          source: `(() => {
          if (!("serviceWorker" in navigator)) return;
          const prototype = ServiceWorkerContainer.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "register");
          if (typeof descriptor?.value === "function" && Object.hasOwn(descriptor.value, Symbol.for(${this.marker}))) return;
          const register = () => Promise.reject(new Error("service workers are blocked by scenario policy"));
          Object.defineProperty(register, Symbol.for(${this.marker}), { value: true });
          const secret = ${this.secret};
          Object.defineProperty(globalThis, ${this.restoreKey}, { configurable: true, value: (provided) => {
            if (provided !== secret) return false;
            if (Object.getOwnPropertyDescriptor(prototype, "register")?.value === register) {
              if (descriptor === undefined) delete prototype.register;
              else Object.defineProperty(prototype, "register", descriptor);
            }
            delete globalThis[${this.restoreKey}];
            return true;
          }});
          Object.defineProperty(prototype, "register", { ...descriptor, configurable: true, value: register });
        })()`,
        }),
      );
      target.identifier = added.identifier;
      if (!this.#closed)
        await this.send(target.id, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }, { exclude: true }],
        });
    } finally {
      // Only this page's iframe targets are attached; unrelated workers/popups
      // are not acquired. Resume a child even if installation or cleanup fails.
      if (
        this.#targets.has(target.id) &&
        target.id !== this.#session?.sessionId
      )
        await this.send(target.id, "Runtime.runIfWaitingForDebugger");
    }
  }

  private send(
    id: string,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    if (this.#session === undefined)
      throw new BrowserObservationError(OPERATION, "disconnected");
    return this.#session.connection.send(method, params, id);
  }

  private async settle(): Promise<void> {
    for (;;) {
      const targets = [...this.#targets.values()];
      await Promise.all(
        targets.map(async (target) => {
          try {
            await target.ready;
          } catch (cause: unknown) {
            if (this.#targets.get(target.id) === target) throw cause;
          }
        }),
      );
      if (
        targets.length === this.#targets.size &&
        targets.every((target) => this.#targets.get(target.id) === target)
      )
        return;
    }
  }

  async assertBlocked(): Promise<void> {
    if (this.#session !== undefined) await this.settle();
    for (const frame of this.page.frames()) {
      let failure: unknown;
      try {
        failure = await frame.evaluate(`(async () => {
          if (!("serviceWorker" in navigator)) return null;
          const serviceWorker = navigator.serviceWorker;
          if (${this.#session !== undefined} &&
              (!Object.hasOwn(serviceWorker.register, Symbol.for(${this.marker})) ||
               typeof globalThis[${this.restoreKey}] !== "function")) return "policy_unprotected";
          if (serviceWorker.controller !== null) return "service_worker_blocked";
          return (await serviceWorker.getRegistrations()).length > 0
            ? "service_worker_blocked"
            : null;
        })()`);
      } catch (cause: unknown) {
        if (frame.isDetached()) continue;
        throw cause;
      }
      if (failure === "policy_unprotected")
        throw new BrowserObservationError(OPERATION, "target_not_allowed");
      if (failure === "service_worker_blocked")
        throw new BrowserObservationError(OPERATION, "service_worker_blocked");
      if (failure !== null)
        throw new BrowserObservationError(OPERATION, "protocol_error");
    }
  }

  close(stopLoading = false): Promise<void> {
    this.#closed = true;
    // Abort discovery/handshakes and reads, never an already-sent page mutation.
    this.#setup.abort();
    const restoration = (this.#restoration ??= this.restore(stopLoading));
    void restoration.then(
      () => {
        if (this.#restoration === restoration) this.#restoration = undefined;
      },
      () => {
        if (this.#restoration === restoration) this.#restoration = undefined;
      },
    );
    return withPlaywrightExecutionBoundary(() => restoration, 1_000);
  }

  private async restore(stopLoading: boolean): Promise<void> {
    await this.#initialization?.catch(() => undefined);
    if (this.#released) return;
    const session = this.#session;
    if (session === undefined) return;
    if (!this.page.isClosed()) {
      // This owner exists even with empty storage seeds. Stopped navigation is
      // independent of storage and restoration never waits for a load event.
      if (stopLoading && !this.#detached && session.sessionId !== undefined)
        await this.send(session.sessionId, "Page.stopLoading");
      await Promise.all(
        [...this.#targets.values()].map(({ ready }) =>
          ready.catch(() => undefined),
        ),
      );
      for (const target of this.#targets.values()) {
        if (!this.#detached && target.identifier !== undefined) {
          try {
            await this.send(
              target.id,
              "Page.removeScriptToEvaluateOnNewDocument",
              { identifier: target.identifier },
            );
          } catch (cause: unknown) {
            if (this.#targets.get(target.id) === target) throw cause;
          }
          delete target.identifier;
        }
      }
      // Future documents cannot install our wrapper after the removals above.
      // A realm lost to navigation is not assumed restored: retain and retry.
      for (const frame of this.page.frames()) {
        if (frame.isDetached()) continue;
        try {
          await frame.evaluate(`(() => {
            const restore = globalThis[${this.restoreKey}];
            if (typeof restore === "function" && restore(${this.secret}) === true) return;
            const register = globalThis.ServiceWorkerContainer?.prototype.register;
            if (typeof register === "function" && Object.hasOwn(register, Symbol.for(${this.marker})))
              throw new Error("service-worker policy restoration could not be confirmed");
          })()`);
        } catch (cause: unknown) {
          if (!frame.isDetached()) throw cause;
        }
      }
    }
    // Detaching the exact owned session also releases its iframe auto-attach.
    if (
      !this.page.isClosed() &&
      !this.#detached &&
      session.sessionId !== undefined
    ) {
      await session.connection.send("Target.detachFromTarget", {
        sessionId: session.sessionId,
      });
      this.#detached = true;
    }
    this.#removeListener?.();
    await session.connection.close();
    this.#released = true;
  }
}
