#!/bin/bash
# Build Lambda layer with heavy deps (Anthropic SDK + MCP SDK)
set -e

LAYER_DIR="dist/layer/nodejs"
rm -rf dist/layer && mkdir -p "$LAYER_DIR"
cd "$LAYER_DIR"
npm init -y --silent > /dev/null 2>&1
npm install @anthropic-ai/sdk @modelcontextprotocol/sdk --silent
rm -f package.json package-lock.json
cd ../../..
echo "✓ Lambda layer built at dist/layer/"
