#!/usr/bin/env node
/**
 * Content Generation CLI: the "GenAI Content Automation" n8n workflow as a terminal tool.
 *
 * Usage:
 *   li-generate --file "<input.xlsx>" --model openai|gemini|claude [--format "Markdown"] [--max-tokens N]
 *
 * Check a workbook and see the exact prompt first (nothing is sent, nothing is written):
 *   li-generate --file "<input.xlsx>" --model gemini --dry-run
 *
 * API keys are read from .env or the environment: OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY.
 * All options: li-generate --help
 */

// Run the generate CLI
require('../dist/cli/generate-cli.js');
