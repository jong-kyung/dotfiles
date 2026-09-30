// Render a candidate configuration. setup owns confirmation, backups and writes.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [mode, file] = process.argv.slice(2);
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
try {
  const config = existsSync(file) ? object(JSON.parse(readFileSync(file, 'utf8')), file) : {};
  if (mode === 'claude') {
    const hooks = object(config.hooks ?? {}, 'hooks');
    const owned = new Set(['notify.ts', 'readonly-gh-api.ts'].flatMap(name => [
      `bun "$HOME/.claude/hooks/${name}"`,
      `bun "${homedir()}/.claude/hooks/${name}"`,
      `bun ${homedir()}/.claude/hooks/${name}`,
    ]));
    // Remove only our exact legacy commands, never another app's hooks or matchers.
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
      hooks[event] = groups.map(group => {
        if (!Array.isArray(group.hooks)) throw new Error(`hooks.${event} entry must contain hooks`);
        return { ...group, hooks: group.hooks.filter(hook => !owned.has(hook.command)) };
      }).filter(group => group.hooks.length);
      if (!hooks[event].length) delete hooks[event];
    }
    (hooks.PreToolUse ??= []).push({ matcher: 'Bash', hooks: [
      { type: 'command', command: 'bun "$HOME/.claude/hooks/readonly-gh-api.ts"' },
    ] });
    config.hooks = hooks;
    config.statusLine = { type: 'command', command: 'ccstatusline', padding: 0 };
    config.attribution = { ...object(config.attribution ?? {}, 'attribution'), commit: '', pr: '', sessionUrl: false };
    config.remoteControlAtStartup = false;
  } else if (mode === 'pi') {
    if (config.extensions !== undefined) {
      if (!Array.isArray(config.extensions)) throw new Error('extensions must be an array');
      config.extensions = config.extensions.filter(value => value !== '-builtin:mcp');
    }
  } else if (mode === 'pi-mcp' || mode === 'claude-mcp') {
    const servers = object(config.mcpServers ?? {}, 'mcpServers');
    if (mode === 'pi-mcp') {
      for (const [name, server] of Object.entries(servers)) {
        object(server, 'MCP server');
        const legacySse = server.type === 'sse' || (typeof server.url === 'string' && new URL(server.url).pathname.replace(/\/$/, '').endsWith('/sse'));
        if (legacySse && (server.enabled !== false || server.type === 'sse')) {
          console.error(`Candidate change: normalize and disable legacy SSE server ${JSON.stringify(name)}; Pi native MCP needs streamable HTTP. Remaining configuration is preserved.`);
          if (server.type === 'sse') delete server.type;
          server.enabled = false;
        }
      }
    }
    servers.codegraph = { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] };
    if (mode === 'pi-mcp') servers.codegraph.exposure = 'direct';
    config.mcpServers = servers;
  } else {
    throw new Error(`Unknown configuration: ${mode}`);
  }
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
} catch (error) {
  // Do not echo parse errors, which can contain private settings values.
  console.error(`Cannot prepare ${mode} configuration at ${file}. Check its JSON structure; nothing was written.`);
  process.exitCode = 1;
}
