import type { Token } from "./tokens.js";

type Factory<T> = (c: Container) => T;
type Decorator<T> = (inner: T, c: Container) => T;

/**
 * A tiny typed DI container with lazy singletons. Services are registered as
 * factories and instantiated on first `resolve`, then memoized. `createScope`
 * yields a child that inherits parent bindings but keeps its own singleton cache,
 * so a run can `override` a service without polluting the root.
 */
export class Container {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly singletons = new Map<symbol, unknown>();
  private readonly decorators = new Map<symbol, Decorator<unknown>[]>();

  constructor(private readonly parent?: Container) {}

  /** Register a factory. Throws if the token is already bound in this container. */
  bind<T>(tok: Token<T>, factory: Factory<T>): this {
    if (this.factories.has(tok.symbol)) {
      throw new Error(`token already bound: ${tok.description}`);
    }
    this.factories.set(tok.symbol, factory as Factory<unknown>);
    return this;
  }

  /** Replace a binding (and drop any cached singleton). Used by tests and /login swaps. */
  override<T>(tok: Token<T>, factory: Factory<T>): this {
    this.factories.set(tok.symbol, factory as Factory<unknown>);
    this.singletons.delete(tok.symbol);
    return this;
  }

  /** Wrap the resolved value, e.g. to meter or trace it. Drops any cached singleton. */
  decorate<T>(tok: Token<T>, wrap: Decorator<T>): this {
    const list = this.decorators.get(tok.symbol) ?? [];
    list.push(wrap as Decorator<unknown>);
    this.decorators.set(tok.symbol, list);
    this.singletons.delete(tok.symbol);
    return this;
  }

  /** Resolve a token to its memoized singleton, applying decorators on first build. */
  resolve<T>(tok: Token<T>): T {
    if (this.singletons.has(tok.symbol)) return this.singletons.get(tok.symbol) as T;
    const factory = this.factories.get(tok.symbol);
    if (!factory) {
      if (this.parent) return this.parent.resolve(tok);
      throw new Error(`unbound token: ${tok.description}`);
    }
    let value = factory(this) as T;
    for (const wrap of this.decorators.get(tok.symbol) ?? []) {
      value = (wrap as Decorator<T>)(value, this);
    }
    this.singletons.set(tok.symbol, value);
    return value;
  }

  /** Whether the token is bound here or in any ancestor. */
  has(tok: Token<unknown>): boolean {
    return this.factories.has(tok.symbol) || (this.parent?.has(tok) ?? false);
  }

  /** A child container: inherits bindings, own singleton cache. */
  createScope(): Container {
    return new Container(this);
  }
}
