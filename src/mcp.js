'use strict';

const readline = require('readline');

function validate(args, schema) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  for (const key of required) {
    if (args == null || args[key] == null) return `missing required argument: ${key}`;
  }
  return null;
}

function makeServer(tools = [], config = {}) {
  const toolMap = new Map(tools.map(t => [t.name, t]));

  async function dispatch(msg) {
    const { id, method, params } = msg || {};
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'codex-ctx', version: '0.1.0' },
        },
      };
    }
    if (method === 'notifications/initialized' || method === 'initialized') return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } };
    }
    if (method === 'tools/call') {
      const tool = toolMap.get(params?.name);
      if (!tool) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: unknown tool ${params?.name || ''}` }], isError: true } };
      const args = params?.arguments || {};
      const err = validate(args, tool.inputSchema);
      if (err) return { jsonrpc: '2.0', id, error: { code: -32602, message: err } };
      try {
        const result = await tool.handler(args, { config });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } };
      }
    }
    if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
    if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }

  function listen(input = process.stdin, output = process.stdout) {
    const rl = readline.createInterface({ input });
    rl.on('line', async (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const res = await dispatch(msg);
      if (res) output.write(JSON.stringify(res) + '\n');
    });
  }

  return { dispatch, listen };
}

module.exports = {
  makeServer,
};
