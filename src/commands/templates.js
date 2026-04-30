/**
 * `storm templates` — list and inspect available templates.
 *
 * Subcommands:
 *   storm templates list      → fetch registry, print available templates
 *   storm templates info <id> → fetch metadata of a specific template
 *
 * The actual project creation from a template is wired into the
 * existing `storm new --template <id>` flow (see commands/new.js
 * and ui/wizard-new.js).
 */

import { fetchTemplateRegistry } from '../core/templates.js';

/**
 * @returns {Promise<import('../core/templates.js').TemplateRegistryEntry[]>}
 */
export async function listTemplates() {
  return await fetchTemplateRegistry();
}

/**
 * @param {string} id
 * @returns {Promise<import('../core/templates.js').TemplateRegistryEntry|null>}
 */
export async function getTemplate(id) {
  const all = await fetchTemplateRegistry();
  return all.find((t) => t.id === id) ?? null;
}
