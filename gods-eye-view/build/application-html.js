import { readFileSync } from 'node:fs';
import { loadIndonesianDictionary, translateHtml } from './i18n-html.js';
import { applyBrand, loadBrand } from './brand-html.js';

export const APPLICATION_TEMPLATES = Object.freeze([
  'scene-chrome',
  'cockpit',
  'display-controls',
  'command-dock',
  'layer-panels',
  'context',
  'welcome',
  'provider-settings',
  'hud-loading',
]);
const allowed = new Set(APPLICATION_TEMPLATES);

/** Expand only known component templates; markers cannot name filesystem paths. */
export function expandApplicationHtml(html) {
  return html.replace(
    /^[ \t]*<!-- gev:template ([^\s]+) -->\r?\n?/gm,
    (_, name) => {
      if (!allowed.has(name))
        throw new Error(`Unknown application template: ${name}`);
      return readFileSync(
        new URL(`../src/ui/templates/${name}.html`, import.meta.url),
        'utf8',
      );
    },
  );
}

/**
 * Expand the component templates, then translate the assembled markup into
 * Indonesian. Translation runs AFTER expansion so one dictionary covers
 * index.html and every template in a single pass.
 *
 * @param {string} html - index.html source.
 * @returns {string} Assembled, translated markup.
 */
export function buildApplicationHtml(html) {
  const expanded = expandApplicationHtml(html);
  const { html: translated } = translateHtml(
    expanded,
    loadIndonesianDictionary(),
  );
  // Merek berjalan PALING AKHIR: nama dan tagline yang dituliskan operator
  // adalah miliknya, dan tidak boleh diterjemahkan ulang oleh kamus.
  const { html: branded } = applyBrand(translated, loadBrand());
  return branded;
}

/** Assemble static application markup before Vite processes scripts and assets. */
export function applicationHtmlPlugin() {
  return {
    name: 'application-component-templates',
    transformIndexHtml: {
      order: 'pre',
      handler: buildApplicationHtml,
    },
  };
}
