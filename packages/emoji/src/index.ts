import { BLUEMOJI, bluemojiProvider } from "./providers/bluemoji.js";
import { createEmojiRegistry } from "./registry.js";

export * from "./provider.js";
export { BLUEMOJI, bluemojiProvider } from "./providers/bluemoji.js";
export * from "./registry.js";

export const emojiRegistry = createEmojiRegistry([bluemojiProvider], BLUEMOJI.provider);
