// Read-only JSON queries used by the AI setup stage. Exit 1 means no match, and 2 means an invalid query or configuration.
import { existsSync, readFileSync } from 'node:fs';

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === 'pi-has-package') {
    const file = process.env.HOME + '/.pi/agent/settings.json';
    const entries = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).packages ?? [] : [];
    process.exitCode = entries.some(entry => {
      const source = typeof entry === 'string' ? entry : entry.source;
      return source === args[0] || source?.startsWith(args[0] + '@');
    }) ? 0 : 1;
  } else if (mode === 'json-has') {
    const [key, value, scope] = args;
    const items = JSON.parse(readFileSync(0, 'utf8'));
    process.exitCode = items.some(item => item[key] === value && (!scope || item.scope === scope)) ? 0 : 1;
  } else if (mode === 'claude-marketplace') {
    const [name, repo] = args;
    const marketplace = JSON.parse(readFileSync(0, 'utf8')).find(item => item.name === name);
    if (marketplace && (marketplace.source !== 'github' || marketplace.repo !== repo)) {
      throw new Error(`Marketplace ${name} must use GitHub repository ${repo}`);
    }
    console.log(marketplace ? 'present' : 'missing');
  } else if (['pi-packages', 'claude-plugins', 'skills'].includes(mode)) {
    const entries = JSON.parse(readFileSync(args[0], 'utf8'));
    const name = '[A-Za-z0-9][A-Za-z0-9._-]*';
    const fields = mode === 'pi-packages' ? ['source'] : mode === 'skills' ? ['repo', 'skill'] : ['repo', 'marketplace', 'plugin'];
    const marketplaces = new Map();
    const rows = entries.map(entry => {
      if (fields.some(key => typeof entry[key] !== 'string' || /[\s\x00-\x1f\x7f]/.test(entry[key]))) throw new Error('Invalid entry');
      if (mode === 'pi-packages') {
        const npm = new RegExp(`^npm:((?:@${name}/)?${name})(?:@${name})?$`).exec(entry.source);
        const git = new RegExp(`^git:(github\\.com/${name}/${name})(?:@[A-Za-z0-9][A-Za-z0-9._/-]*)?$`).exec(entry.source);
        if (!npm && !git) throw new Error('Unsupported Pi source');
        return [entry.source, npm ? `npm/node_modules/${npm[1]}` : `git/${git[1].replace(/\.git$/, '')}`];
      }
      if (!new RegExp(`^${name}/${name}$`).test(entry.repo) || !new RegExp(`^${name}$`).test(entry[fields[1]])) throw new Error('Invalid repository or name');
      if (mode === 'claude-plugins') {
        if (!new RegExp(`^${name}@${name}$`).test(entry.plugin) || entry.plugin.split('@')[1] !== entry.marketplace) throw new Error('Invalid plugin');
        if (marketplaces.has(entry.marketplace) && marketplaces.get(entry.marketplace) !== entry.repo) throw new Error('Conflicting marketplace repositories');
        marketplaces.set(entry.marketplace, entry.repo);
      }
      return fields.map(key => entry[key]);
    });
    const targets = rows.map(row => row[row.length - 1]);
    if (new Set(targets).size !== targets.length) throw new Error('Duplicate installation target');
    process.stdout.write(rows.map(row => row.join('\t') + '\n').join(''));
  } else {
    throw new Error(`Unknown query: ${mode}`);
  }
} catch {
  // Parse errors can contain private settings. Never treat a failed query as a missing installation.
  console.error(`Cannot run setup query ${mode}. Check JSON settings and marketplace sources.`);
  process.exitCode = 2;
}
