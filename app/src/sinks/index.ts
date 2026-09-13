import type { SinkPlugin } from "../core/types.js";
import { telegramSink } from "./telegram.js";

export * from "./telegram.js";

export const sinkPlugins: SinkPlugin<any>[] = [telegramSink];
