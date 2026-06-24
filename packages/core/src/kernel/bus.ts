import { Tokens } from "./tokens.js";

/**
 * The kernel token for the shared EventBus. The container binds it to the SAME
 * EventBus instance the session already creates, so existing subscribers
 * (`session.bus`, MemoryRecorder, the TUI) keep working with zero changes — the bus
 * is folded into the kernel namespace by token, not by reimplementation.
 */
export const Bus = Tokens.Bus;
