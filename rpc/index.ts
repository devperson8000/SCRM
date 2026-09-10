type Serverbound = {
  method1: [{ paramA: string; paramB: number }, boolean];
  method2: [string, number];
};

type Clientbound = {
  method1: [number];
  method2: [boolean, string];
};

export type RpcDescription = {
  [method: string]: [args: any, returnType: any] | [args: any] | [];
};

export type MethodsDefinition<Description extends RpcDescription> = {
  [Method in keyof Description]: (
    ...args: Description[Method] extends [infer A, ...any[]] ? [A] : []
  ) => Description[Method] extends [any, infer R]
    ? Promise<[R, Transferable[]]>
    : Promise<void>;
};

export class RpcHelper<
  Local extends RpcDescription,
  Remote extends RpcDescription,
> {
  counter: number = 0;
  promiseCallbacks: Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (reason?: any) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  /**
   * Default per-call deadline. Off unless set: some calls legitimately span a
   * whole streamed response, and a blanket deadline would cancel them.
   */
  timeoutMs: number;

  constructor(
    private methods: MethodsDefinition<Local>,
    private id: string,
    private sendRaw: (data: any, transfer: Transferable[]) => void,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  private settle(token: number, error: unknown, value?: any) {
    const cb = this.promiseCallbacks.get(token);
    if (!cb) return;
    this.promiseCallbacks.delete(token);
    if (cb.timer !== undefined) clearTimeout(cb.timer);
    if (error) cb.reject(error);
    else cb.resolve(value);
  }

  private respond(token: unknown, data: any, transfer: Transferable[]) {
    try {
      this.sendRaw(
        { [this.id]: { $type: "response", $token: token, ...data } },
        transfer,
      );
    } catch (err) {
      // A failed response (dead port, unclonable payload) must not escape as
      // an unhandled rejection — the caller's own timeout is what recovers.
      console.error("rpc: failed to send response", err);
    }
  }

  recieve(data: any) {
    if (data === undefined || data === null || typeof data !== "object") return;
    const dt = data[this.id];
    if (dt === undefined || dt === null || typeof dt !== "object") return;

    const type = dt.$type;

    if (type === "response") {
      const token = dt.$token;
      if (typeof token !== "number") return;
      const error = dt.$error;
      this.settle(
        token,
        error !== undefined ? new Error(error) : null,
        dt.$data,
      );
    } else if (type === "request") {
      const method = dt.$method as keyof Local;
      // `this.methods[method]` walks the prototype chain, so a peer asking
      // for "constructor" or "toString" used to resolve an Object.prototype
      // member and throw a TypeError right here — killing the message
      // handler and leaving the caller hanging forever.
      const handler =
        typeof method === "string" &&
        Object.prototype.hasOwnProperty.call(this.methods, method)
          ? (this.methods[method] as unknown)
          : undefined;
      if (typeof handler !== "function") {
        this.respond(
          dt.$token,
          { $error: `Unknown method: ${String(method)}` },
          [],
        );

        return;
      }

      const args = dt.$args as Local[typeof method][0];
      // The handler itself may throw synchronously, which Promise.resolve
      // alone wouldn't catch.
      let result: Promise<any>;
      try {
        result = Promise.resolve((handler as (a: any) => any)(args));
      } catch (err) {
        this.respond(dt.$token, { $error: String(err) }, []);

        return;
      }

      result
        .then((r: any) => {
          this.respond(dt.$token, { $data: r?.[0] }, r?.[1] ?? []);
        })
        .catch((err: any) => {
          console.error(err);
          this.respond(
            dt.$token,
            { $error: err?.toString() || "Unknown error" },
            [],
          );
        });
    }
  }

  call<Method extends keyof Remote>(
    method: Method,
    args: Remote[Method][0],
    transfer: Transferable[] = [],
    options: { timeoutMs?: number } = {},
  ): Promise<Remote[Method][1]> {
    const token = this.counter++;

    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const timer =
        timeoutMs > 0
          ? setTimeout(
              () =>
                this.settle(
                  token,
                  new Error(`rpc call timed out: ${String(method)}`),
                ),
              timeoutMs,
            )
          : undefined;
      this.promiseCallbacks.set(token, { resolve, reject, timer });

      try {
        this.sendRaw(
          {
            [this.id]: {
              $type: "request",
              $method: method,
              $args: args,
              $token: token,
            },
          },
          transfer,
        );
      } catch (err) {
        // Without this the entry stayed in promiseCallbacks forever and the
        // caller awaited a promise that could never settle.
        this.settle(token, err);
      }
    });
  }

  /**
   * Rejects every in-flight call. Call this when the peer goes away
   * (worker terminated, port closed) — otherwise those callbacks are retained
   * for the lifetime of the page along with everything they close over.
   */
  dispose(reason: string = "rpc disposed") {
    for (const token of [...this.promiseCallbacks.keys()]) {
      this.settle(token, new Error(reason));
    }
  }
}
