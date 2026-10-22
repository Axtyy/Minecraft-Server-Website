/**
 * Every page that is not the store: vote, stats, rules, bans, the legal pages,
 * the order page and the 404.
 *
 * All of them are rendered by the server and work with scripts off - filters,
 * searches and paging are links and forms. This is the stylesheet, the skin
 * fallback and the header's switch, and that is all.
 *
 * No cart script on purpose: none of these pages sells anything.
 */
import '../styles/site.css';
import { initChrome } from '../lib/chrome.js';
import { watchSkins } from '../lib/skins.js';

watchSkins();
initChrome();
