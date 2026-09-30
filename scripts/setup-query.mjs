// Read-only JSON queries used by the AI setup stage.
import { existsSync, readFileSync } from 'node:fs';

const [mode, ...args] = process.argv.slice(2);
if (mode === 'pi-source') {
  const file = process.env.HOME + '/.pi/agent/settings.json';
  const entries = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).packages ?? [] : [];
  for (const entry of entries) {
    const source = typeof entry === 'string' ? entry : entry.source;
    if (source === args[0] || source?.startsWith(args[0] + '@')) {
      console.log(source);
      break;
    }
  }
} else if (mode === 'json-has') {
  const [key, value, scope] = args;
  const items = JSON.parse(readFileSync(0, 'utf8'));
  process.exitCode = items.some(item => item[key] === value && (!scope || item.scope === scope)) ? 0 : 1;
} else {
  throw new Error(`Unknown query: ${mode}`);
}
