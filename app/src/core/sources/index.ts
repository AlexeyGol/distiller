import type { SourcePlugin } from "../types.js";
import { rssSource } from "./rss.js";
import { youtubeChannelSource } from "./youtube-channel.js";
import { youtubeSearchSource } from "./youtube-search.js";

/**
 * The built-in source plugins, in the order the "add a source" catalog should
 * list them: cheapest and most general first, quota-metered last.
 */

export { rssSource, rssConfigSchema, type RssConfig } from "./rss.js";
export {
  youtubeChannelSource,
  youtubeChannelConfigSchema,
  type YoutubeChannelConfig,
} from "./youtube-channel.js";
export {
  youtubeSearchSource,
  youtubeSearchConfigSchema,
  type YoutubeSearchConfig,
} from "./youtube-search.js";

export const sourcePlugins: SourcePlugin<any>[] = [
  rssSource,
  youtubeChannelSource,
  youtubeSearchSource,
];
