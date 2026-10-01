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
  } else if (mode === 'skills') {
    const skills = JSON.parse(readFileSync(args[0], 'utf8'));
    process.stdout.write(skills.map(({ repo, skill }) => `${repo}\t${skill}\n`).join(''));
  } else {
    throw new Error(`Unknown query: ${mode}`);
  }
} catch {
  // Parse errors can contain private settings. Never treat a failed query as a missing installation.
  console.error(`Cannot run setup query ${mode}. Check JSON settings and marketplace sources.`);
  process.exitCode = 2;
}
