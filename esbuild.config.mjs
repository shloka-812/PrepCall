import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: [
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/lib-dynamodb',
    '@aws-sdk/client-sqs',
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/*',
  ],
  sourcemap: true,
};

// Receiver Lambda — handles HTTP + enqueues to SQS
await build({
  ...shared,
  entryPoints: ['src/handlers/receiver.ts'],
  outfile: 'dist/handlers/receiver.js',
});

// Processor Lambda — Claude + Granola MCP processing
await build({
  ...shared,
  entryPoints: ['src/handlers/processor.ts'],
  outfile: 'dist/handlers/processor.js',
});

console.log('✓ Lambda handlers built');
