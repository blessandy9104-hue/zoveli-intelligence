# Examples

Run the library example after `npm run build`:

```bash
node examples/library.mjs /path/to/notes
```

The example uses the package's own name (`@zoveli/intelligence`) via Node's
self-referencing imports, so it exercises exactly what a consumer installs.

For an MCP host, use the configuration in the main README or
[`mcp-config.json`](mcp-config.json).
