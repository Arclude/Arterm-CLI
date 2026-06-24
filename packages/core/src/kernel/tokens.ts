import type { ContextStrategy } from "../contextStrategy.js";
import type { EventBus } from "../eventBus.js";
import type { PermissionManager } from "../permissions.js";
import type { SessionStore } from "../sessionStore.js";
import type { PipelineRegistry } from "./pipeline.js";
import type { RunController } from "./runController.js";

/**
 * A typed dependency-injection token. The phantom `T` flows through `resolve<T>`
 * without any runtime cost (it is never assigned). Identity is the `symbol`.
 */
declare const TokenBrand: unique symbol;
export interface Token<T> {
  readonly symbol: symbol;
  readonly description: string;
  /** Phantom marker — never present at runtime; carries the bound type for inference. */
  readonly [TokenBrand]?: T;
}

/** Mint a fresh DI token. Two calls with the same description are distinct tokens. */
export function token<T>(description: string): Token<T> {
  return { symbol: Symbol(description), description };
}

/** Minimal structured logger the kernel can bind and decorate. */
export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

/** Counts tokens for a piece of text (wraps the tokenEstimate helpers). */
export interface TokenCounter {
  count(text: string): number;
}

/** Standard token table. New code resolves via these; old code keeps its direct refs. */
export const Tokens = {
  Logger: token<Logger>("Logger"),
  TokenCounter: token<TokenCounter>("TokenCounter"),
  SessionStore: token<SessionStore>("SessionStore"),
  PermissionPolicy: token<PermissionManager>("PermissionPolicy"),
  Compactor: token<ContextStrategy>("Compactor"),
  Bus: token<EventBus>("Bus"),
  Pipelines: token<PipelineRegistry>("Pipelines"),
  RunController: token<RunController>("RunController"),
} as const;
