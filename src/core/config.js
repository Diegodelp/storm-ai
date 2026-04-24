/**
 * project.config.json I/O and validation.
 *
 * The config file is the declarative source of truth for:
 *   - Project identity (name, description, stack)
 *   - Declared branches for the compact-context
 *   - Skills and agents
 *   - Tunables (auto_refresh_threshold, map_files_per_branch, ignored_paths)
 *
 * We validate on read so downstream code can assume the object is well-formed.
 * Unknown fields are preserved untouched — forward-compatible with newer
 * config files edited by a newer CLI version.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CONFIG_FILE = 'project.config.json';
const CURRENT_VERSION = 1;

/**
 * @typedef {Object} SkillConfig
 * @property {string} name
 * @property {boolean} [builtin]
 * @property {string} [description]
 */

/**
 * @typedef {Object} AgentConfig
 * @property {string} name
 * @property {string} slash
 * @property {string} [description]
 * @property {string[]} [tasks]
 */

/**
 * @typedef {Object} BranchConfig
 * @property {string} path
 * @property {string} [description]
 * @property {string[]} [pinned]
 */

/**
 * @typedef {Object} ProjectConfig
 * @property {number} version
 * @property {string} name
 * @property {string} [description]
 * @property {string} [stack]
 * @property {string} [database]
 * @property {{provider: string, name: string|null}} [model]
 * @property {SkillConfig[]} skills
 * @property {AgentConfig[]} agents
 * @property {{
 *   enabled: boolean,
 *   auto_refresh_threshold: number,
 *   map_files_per_branch: number,
 *   branches: BranchConfig[],
 *   watcher: {enabled: boolean, comment?: string},
 *   ignored_paths: string[]
 * }} compact_context
 */

/**
 * @param {string} projectRoot
 * @returns {Promise<ProjectConfig>}
 */
export async function readConfig(projectRoot) {
  const p = path.join(projectRoot, CONFIG_FILE);
  let raw;
  try {
    raw = await readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError(
        `No ${CONFIG_FILE} in ${projectRoot}. Run 'storm new' to create a project.`,
      );
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }

  return validateAndNormalize(parsed);
}

/**
 * @param {string} projectRoot
 * @param {ProjectConfig} config
 */
export async function writeConfig(projectRoot, config) {
  const p = path.join(projectRoot, CONFIG_FILE);
  await mkdir(path.dirname(p), { recursive: true });
  // No BOM. Pretty-printed for human editing.
  await writeFile(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Build a fresh ProjectConfig from wizard answers.
 *
 * @param {Object} input
 * @param {string} input.name
 * @param {string} [input.description]
 * @param {string} [input.stack]
 * @param {string} [input.database]
 * @param {{provider:string,name:string|null}} [input.model]
 * @param {SkillConfig[]} [input.skills]
 * @param {AgentConfig[]} [input.agents]
 * @param {BranchConfig[]} [input.branches]
 * @returns {ProjectConfig}
 */
export function createConfig(input) {
  if (!input.name?.trim()) {
    throw new ConfigError('Project name is required.');
  }
  return validateAndNormalize({
    version: CURRENT_VERSION,
    name: input.name.trim(),
    description: input.description ?? '',
    stack: input.stack ?? '',
    database: input.database ?? '',
    model: input.model ?? { provider: 'claude', name: null },
    skills: input.skills ?? [],
    agents: input.agents ?? [],
    compact_context: {
      enabled: true,
      auto_refresh_threshold: 5,
      map_files_per_branch: 10,
      branches: input.branches ?? [],
      watcher: {
        enabled: false,
        comment:
          'v0.2 roadmap: proactive file watcher. When implemented, set to true to enable.',
      },
      ignored_paths: ['.git', 'node_modules', 'dist', '.next', 'build'],
    },
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Normalize and validate a config object. Fills in defaults, rejects
 * incoherent values, leaves unknown top-level fields alone.
 *
 * @param {any} raw
 * @returns {ProjectConfig}
 */
function validateAndNormalize(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('Config must be a JSON object.');
  }

  const config = { ...raw };
  config.version ??= CURRENT_VERSION;
  if (config.version > CURRENT_VERSION) {
    throw new ConfigError(
      `Config version ${config.version} is newer than this CLI (${CURRENT_VERSION}). Upgrade storm-ai.`,
    );
  }

  if (!config.name || typeof config.name !== 'string') {
    throw new ConfigError('Missing required field: name');
  }
  config.description ??= '';
  config.stack ??= '';
  config.database ??= '';

  config.model ??= { provider: 'claude-code', name: null };
  if (typeof config.model !== 'object') {
    throw new ConfigError('`model` must be an object.');
  }

  config.skills = normalizeSkills(config.skills);
  config.agents = normalizeAgents(config.agents);
  config.compact_context = normalizeCompactContext(config.compact_context);

  return config;
}

function normalizeSkills(skills) {
  if (!skills) return [];
  if (!Array.isArray(skills)) {
    throw new ConfigError('`skills` must be an array.');
  }
  const seen = new Set();
  return skills.map((s, i) => {
    if (!s.name || typeof s.name !== 'string') {
      throw new ConfigError(`skills[${i}] is missing name`);
    }
    if (seen.has(s.name)) {
      throw new ConfigError(`Duplicate skill: ${s.name}`);
    }
    seen.add(s.name);
    return {
      name: s.name,
      builtin: !!s.builtin,
      description: s.description ?? '',
    };
  });
}

function normalizeAgents(agents) {
  if (!agents) return [];
  if (!Array.isArray(agents)) {
    throw new ConfigError('`agents` must be an array.');
  }
  const seen = new Set();
  return agents.map((a, i) => {
    if (!a.name || typeof a.name !== 'string') {
      throw new ConfigError(`agents[${i}] is missing name`);
    }
    if (!a.slash || typeof a.slash !== 'string') {
      throw new ConfigError(`agents[${i}] is missing slash`);
    }
    if (seen.has(a.name)) {
      throw new ConfigError(`Duplicate agent: ${a.name}`);
    }
    seen.add(a.name);
    return {
      name: a.name,
      slash: a.slash,
      description: a.description ?? '',
      tasks: Array.isArray(a.tasks) ? a.tasks : [],
    };
  });
}

function normalizeCompactContext(cc) {
  cc ??= {};
  cc.enabled ??= true;
  cc.auto_refresh_threshold ??= 5;
  cc.map_files_per_branch ??= 10;
  cc.branches ??= [];
  cc.watcher ??= { enabled: false };
  cc.ignored_paths ??= ['.git', 'node_modules', 'dist', '.next', 'build'];

  if (typeof cc.auto_refresh_threshold !== 'number' || cc.auto_refresh_threshold < 1) {
    throw new ConfigError('compact_context.auto_refresh_threshold must be a positive integer.');
  }
  if (typeof cc.map_files_per_branch !== 'number' || cc.map_files_per_branch < 1) {
    throw new ConfigError('compact_context.map_files_per_branch must be a positive integer.');
  }
  if (!Array.isArray(cc.branches)) {
    throw new ConfigError('compact_context.branches must be an array.');
  }

  const seen = new Set();
  cc.branches = cc.branches.map((b, i) => {
    if (!b.path || typeof b.path !== 'string') {
      throw new ConfigError(`compact_context.branches[${i}] is missing path`);
    }
    const normalized = b.path.replaceAll('\\', '/').replace(/\/+$/, '');
    if (seen.has(normalized)) {
      throw new ConfigError(`Duplicate branch path: ${normalized}`);
    }
    seen.add(normalized);
    return {
      path: normalized,
      description: b.description ?? '',
      pinned: Array.isArray(b.pinned) ? b.pinned : [],
    };
  });

  return cc;
}
