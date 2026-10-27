export const MAX_TITLE_LENGTH = 32;
export const MAX_TITLE_WORDS = 3;
export const DEFAULT_CHAT_ICON = 'chat_bubble';

/** Material Symbols the name model may pick a chat's activity rail icon from. */
export const CHAT_ICONS = [
  'bug_report', 'build', 'construction', 'code', 'terminal', 'data_object', 'integration_instructions', 'api', 'webhook', 'database',
  'storage', 'dns', 'cloud', 'cloud_upload', 'download', 'upload', 'sync', 'refresh', 'merge', 'call_split', 'account_tree',
  'schema', 'hub', 'lan', 'router', 'wifi', 'security', 'lock', 'key', 'shield', 'verified_user', 'person', 'group', 'manage_accounts',
  'login', 'settings', 'tune', 'palette', 'brush', 'format_paint', 'design_services', 'dashboard', 'view_quilt', 'web', 'tab',
  'view_sidebar', 'menu', 'widgets', 'extension', 'smart_toy', 'psychology', 'auto_awesome', 'bolt', 'speed', 'timer', 'schedule',
  'calendar_month', 'notifications', 'mail', 'chat', 'forum', 'translate', 'description', 'article', 'edit_note', 'history_edu',
  'menu_book', 'school', 'science', 'calculate', 'functions', 'analytics', 'bar_chart', 'monitoring', 'query_stats', 'search',
  'travel_explore', 'image', 'photo_camera', 'movie', 'music_note', 'volume_up', 'mic', 'videocam', 'animation', 'view_in_ar',
  'deployed_code', 'sports_esports', 'stadia_controller', 'joystick', 'casino', 'park', 'agriculture', 'eco', 'pets', 'map',
  'public', 'location_on', 'shopping_cart', 'payments', 'savings', 'inventory_2', 'package_2', 'local_shipping', 'rocket_launch',
  'flag', 'emoji_events', 'star', 'favorite', 'lightbulb', 'help', 'quiz', 'fact_check', 'checklist', 'task_alt', 'rule',
  'gavel', 'folder', 'folder_open', 'file_copy', 'content_cut', 'delete', 'cleaning_services', 'archive', 'difference', 'compare',
  'swap_horiz', 'link', 'share', 'print', 'keyboard', 'mouse', 'devices', 'phone_iphone', 'desktop_windows', 'memory', 'developer_board',
  'electric_bolt', 'battery_charging_full', 'thermostat', 'restaurant', 'home', 'apartment', 'handyman', 'biotech',
];
const ICONS = new Set(CHAT_ICONS);

/** Icons the activity rail falls back on when two chats would show the same one: chat-like icons first, then the topical ones. */
export const RAIL_FALLBACK_ICONS = [
  ...['chat_bubble', 'chat', 'forum', 'sms', 'comment', 'question_answer', 'textsms', 'mode_comment', 'add_comment', 'mark_chat_unread'],
  ...CHAT_ICONS.filter(icon => !['chat', 'forum'].includes(icon)),
];

/**
 * `icon` when no other chat uses it, else a free icon chosen by `seed` so a chat keeps getting the same one.
 * Once every icon is taken, `icon` is returned as is.
 */
export function uniqueChatIcon(icon: string | undefined, taken: Iterable<string>, seed: string): string | undefined {
  const used = new Set(taken);
  if (icon && !used.has(icon)) return icon;
  const free = CHAT_ICONS.filter(item => !used.has(item));
  if (!free.length) return icon;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return free[hash % free.length];
}

/** Provisional title shown until (or instead of) a name model reply. */
export function firstMessageTitle(prompt: string): string {
  return (prompt.trim().replace(/\s+/g, ' ') || 'Image').slice(0, 48);
}

/** `taken` lists icons other chats already use; they are left out of the choices while any others remain. */
export function chatTitlePrompt(request: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const free = CHAT_ICONS.filter(icon => !used.has(icon));
  return 'Name a coding chat that starts with the request below. Reply with ONLY one line in the form "icon | Title".\n'
    + 'Title: as short as possible. ONE word is best, two words are fine, three words is the hard maximum. Never write four or more words. '
    + 'Sentence case, no quotes, no trailing punctuation. Name the concrete subject, for example "Tabs", "Rail icons", "Login bug" or "Diff viewer". '
    + 'When the request covers several things, name the main one or what they share.\n'
    + `Icon: the one name from this list that best fits the subject: ${(free.length ? free : CHAT_ICONS).join(', ')}.\n`
    + 'Example reply: bug_report | Login bug\n'
    + `Do not use any tools.\n\nRequest:\n${request.trim().slice(0, 4000)}`;
}

/** Extracts a clean title of at most three words from a model reply, or returns undefined when nothing usable came back. */
export function cleanChatTitle(reply: string): string | undefined {
  return parseChatName(reply)?.title;
}

/** Extracts the title and rail icon from a model reply. The icon is undefined unless it is one of CHAT_ICONS. */
export function parseChatName(reply: string): { title: string; icon?: string } | undefined {
  const line = reply.split(/\r?\n/).map(item => item.trim()).find(Boolean);
  if (!line) return undefined;
  const split = line.match(/^[`*_"']*([a-z0-9_]+)[`*_"']*\s*\|\s*(.+)$/i);
  const icon = split && ICONS.has(split[1].toLowerCase()) ? split[1].toLowerCase() : undefined;
  const raw = split ? split[2] : line;
  const title = raw
    .replace(/^(?:#+\s*|[-*]\s+)/, '')
    .replace(/^\**\s*title\s*:\s*/i, '')
    .replace(/^[*_`"'“‘]+|[*_`"'”’]+$/g, '')
    .replace(/[.!?:;,\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').slice(0, MAX_TITLE_WORDS).join(' ')
    .replace(/[.!?:;,\-–—|]+$/, '');
  if (!title) return undefined;
  return { title: title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : title, icon };
}
