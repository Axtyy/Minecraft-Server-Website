/* Applies the visitor's stored look before the page is drawn.
 *
 * bb-look  'sky' for the day look; anything else is night, the default.
 *
 * Kept in a cookie on the parent domain, because the site is three hostnames
 * (the main site, the store and the stats) and browser storage belongs to one
 * hostname at a time: stored there, the look chosen on the store was forgotten
 * the moment a visitor clicked through to the stats. A cookie set for
 * .example.com is the one thing all three can read. Browser storage is still
 * read as a fallback, so a choice made before this change is not lost.
 *
 * The cookie holds the one word and nothing about the visitor. Either read can
 * fail - private windows, blocked site data - and the page must still draw. */
(function () {
  var look = null;
  try {
    var hit = /(?:^|;\s*)bb-look=(sky|night)(?:;|$)/.exec(document.cookie);
    if (hit) look = hit[1];
  } catch (e) { /* no cookies */ }
  if (!look) {
    try { look = localStorage.getItem('bb-look'); } catch (e) { /* default look */ }
  }
  if (look === 'sky') document.documentElement.setAttribute('data-look', 'sky');
})();
