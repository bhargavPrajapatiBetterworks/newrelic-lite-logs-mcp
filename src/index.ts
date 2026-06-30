#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildZeroResultDiagnostics, getAccountContext } from "./log-discovery.js";
import { buildMemoryBank, readMemoryBank } from "./memory-bank.js";
import { searchEntities } from "./nerdgraph.js";
import { buildClientFromEnv } from "./newrelic.js";
import {
  getServiceHealthSummary,
  getTopErrors,
  getSlowTransactions,
  summarizeLogErrors,
  listActiveIncidents,
  investigateServiceIssue,
} from "./observability.js";
import {
  decodePageToken,
  encodePageToken,
  enforceReadOnlyQuery,
  ensureTimeBound,
  injectWindowAndLimit,
  normalizeQuery,
  redactObject,
  withOffset,
} from "./security.js";
import { DryRunResult, QueryResult } from "./types.js";

const MAX_LIMIT = 5000;

const searchLogsSchema = z.object({
  query: z.string().min(1),
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  pageToken: z.string().optional(),
});

const dryRunSchema = z.object({
  query: z.string().min(1),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
});

const runNrqlQuerySchema = z.object({
  nrql: z.string().min(1),
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
});

const searchEntitiesSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.string().min(1).max(50).optional(),
  domain: z.string().min(1).max(50).optional(),
  accountId: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const serviceHealthSchema = z.object({
  entityName: z.string().min(1).max(200),
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
});

const activeIncidentsSchema = z.object({
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const logErrorsSchema = z.object({
  entityName: z.string().min(1).max(200).optional(),
  logTable: z.string().min(1).max(100).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  accountId: z.number().int().positive().optional(),
});

const topErrorsSchema = z.object({
  entityName: z.string().min(1).max(200),
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const slowTransactionsSchema = z.object({
  entityName: z.string().min(1).max(200),
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const investigateSchema = z.object({
  entityName: z.string().min(1).max(200),
  accountId: z.number().int().positive().optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const buildMemoryBankSchema = z.object({
  accountId: z.number().int().positive().optional(),
  localRepositoryName: z.string().min(1).optional(),
  environments: z.array(z.string().min(1)).max(30).optional(),
  serviceMappings: z.array(
    z.object({
      localService: z.string().min(1),
      infraService: z.string().min(1).optional(),
      pods: z.array(z.string().min(1)).max(50).optional(),
      containers: z.array(z.string().min(1)).max(50).optional(),
      notes: z.string().optional(),
    }),
  ).max(300).optional(),
  clarifications: z.array(z.string().min(1)).max(100).optional(),
});

const client = buildClientFromEnv();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function routeQueryWithMemoryBank(rawQuery: string): Promise<{ query: string; note?: string }> {
  const bank = await readMemoryBank();
  if (!bank || !bank.primaryTable || bank.primaryTable === "Log") {
    return { query: rawQuery };
  }

  if (!/\bFROM\s+Log\b/i.test(rawQuery)) {
    return { query: rawQuery };
  }

  return {
    query: rawQuery.replace(/\bFROM\s+Log\b/i, `FROM ${bank.primaryTable}`),
    note: `Auto-routed FROM Log to FROM ${bank.primaryTable} using local memory bank.`,
  };
}

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}

function compactUnique(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function classifyError(error: unknown): { type: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/Missing NEW_RELIC_API_KEY|Missing NEW_RELIC_COOKIE|Invalid env configuration/i.test(message)) {
    return { type: "auth_error", message };
  }

  if (/only read-only NRQL|provide at least one of since\/until|Invalid date\/time string|Unknown function|rejected/i.test(message)) {
    return { type: "query_validation_error", message };
  }

  if (/request failed \(429\)/i.test(message)) {
    return { type: "rate_limited", message };
  }

  if (/request failed \(5\d\d\)/i.test(message)) {
    return { type: "upstream_rejected", message };
  }

  if (/fetch failed|network/i.test(message)) {
    return { type: "upstream_timeout", message };
  }

  return { type: "internal_error", message };
}

async function executeQuery(rawQuery: string, options: { accountId?: number; since?: string; until?: string; limit?: number; pageToken?: string }): Promise<QueryResult> {
  const routed = await routeQueryWithMemoryBank(rawQuery);

  enforceReadOnlyQuery(routed.query);
  ensureTimeBound(routed.query, options.since, options.until);

  const limit = Math.min(options.limit ?? 200, MAX_LIMIT);
  const offset = decodePageToken(options.pageToken);
  const query = withOffset(injectWindowAndLimit(routed.query, options.since, options.until, limit), offset);

  const startedAt = Date.now();
  const rows = await client.runNrql(query, options.accountId);
  const durationMs = Date.now() - startedAt;
  const accountContext = await getAccountContext(client, {
    accountId: options.accountId,
    since: options.since,
    until: options.until,
  });

  const { redacted, redactionCount } = redactObject(rows);
  const nextPageToken = rows.length >= limit ? encodePageToken(offset + limit) : undefined;
  const diagnostics = rows.length === 0 ? await buildZeroResultDiagnostics(client, query, {
    accountId: options.accountId,
    since: options.since,
    until: options.until,
  }) : undefined;

  return {
    summary: `Fetched ${rows.length} rows in ${durationMs}ms using ${client.authMode}.${routed.note ? ` ${routed.note}` : ""}`,
    query,
    rows: redacted,
    accountContext,
    diagnostics,
    meta: {
      durationMs,
      rowsReturned: rows.length,
      capped: rows.length >= limit,
      redactionCount,
      nextPageToken,
      accountId: options.accountId ?? client.accountId,
      authMode: client.authMode,
    },
  };
}

async function makeDryRun(rawQuery: string, options: { since?: string; until?: string; limit?: number }): Promise<DryRunResult> {
  const routed = await routeQueryWithMemoryBank(rawQuery);

  enforceReadOnlyQuery(routed.query);
  ensureTimeBound(routed.query, options.since, options.until);

  const normalizedQuery = injectWindowAndLimit(routed.query, options.since, options.until, Math.min(options.limit ?? 200, MAX_LIMIT));
  const warnings: string[] = [];

  const memoryBank = await readMemoryBank();
  if (routed.note) {
    warnings.push(routed.note);
  }

  if (memoryBank && memoryBank.logTables.length > 0) {
    const queryTargetsStandardLog = /\bFROM\s+Log\b/i.test(normalizedQuery);
    const hasCustomTables = memoryBank.logTables.some((t) => t !== "Log");

    if (queryTargetsStandardLog && hasCustomTables) {
      warnings.push(
        `Memory bank shows custom log tables: ${memoryBank.logTables.join(", ")}. ` +
        `Consider querying FROM ${memoryBank.primaryTable} instead of the standard Log table.`,
      );
    }

    const targetsKnownTable = memoryBank.logTables.some((tableName) => {
      const re = new RegExp(`\\bFROM\\s+${escapeRegExp(tableName)}\\b`, "i");
      return re.test(normalizedQuery);
    });

    if (!targetsKnownTable && !queryTargetsStandardLog) {
      warnings.push("Query does not target any known log table. Rebuild or inspect ./.newrelic/memory-bank.json.");
    }
  } else if (!/\bFROM\s+Log\b/i.test(normalizedQuery)) {
    warnings.push("Query does not explicitly target Log events.");
  }

  return {
    valid: true,
    normalizedQuery: normalizeQuery(normalizedQuery),
    warnings,
    accountContext: {
      accountId: client.accountId,
      authMode: client.authMode,
    },
  };
}

const server = new Server(
  {
    name: "newrelic-lite-logs-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_logs",
      description: "Run a read-only NRQL query for logs with time bounds and pagination.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          accountId: { type: "number" },
          since: { type: "string" },
          until: { type: "string" },
          limit: { type: "number", maximum: MAX_LIMIT },
          pageToken: { type: "string" },
        },
        required: ["query"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "build_memory_bank",
      description:
        "Build a one-time, repo-committable New Relic memory bank with infra context, log tables, log schemas, custom fields, and field samples. " +
        "Before calling this tool, ask the user clarifying questions and pass them via localRepositoryName, environments, serviceMappings, and clarifications. " +
        "The output must remain concise, deterministic, and machine-readable for efficient context-window usage. " +
        "The file is stored at NR_MEMORY_BANK_PATH or ./.newrelic/memory-bank.json.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "number", description: "Override the default account ID." },
          localRepositoryName: {
            type: "string",
            description: "Local repository or service group name (for example: engage-api).",
          },
          environments: {
            type: "array",
            items: { type: "string" },
            description: "Environment names relevant to this repo (for example: prod-us, prod-eu, stage).",
          },
          serviceMappings: {
            type: "array",
            description: "Mapping between local repo services and infra service/pod/container identities.",
            items: {
              type: "object",
              properties: {
                localService: { type: "string" },
                infraService: { type: "string" },
                pods: { type: "array", items: { type: "string" } },
                containers: { type: "array", items: { type: "string" } },
                notes: { type: "string" },
              },
              required: ["localService"],
            },
          },
          clarifications: {
            type: "array",
            items: { type: "string" },
            description: "Any additional human clarifications that should be persisted in short bullet form.",
          },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "dry_run_query",
      description: "Validate and normalize a read-only NRQL query without execution.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          since: { type: "string" },
          until: { type: "string" },
          limit: { type: "number", maximum: MAX_LIMIT },
        },
        required: ["query"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "run_nrql_query",
      description:
        "Execute a read-only NRQL query for any New Relic event type (Transaction, TransactionError, Log, Metric, etc.). " +
        "Unlike search_logs, this does not enforce time bounds or route through the memory bank. " +
        "Use for custom aggregations, metric comparisons, and event types beyond logs.",
      inputSchema: {
        type: "object",
        properties: {
          nrql: { type: "string", description: "Complete NRQL query. Include SINCE/UNTIL or pass since/until params." },
          accountId: { type: "number", description: "Override the default account ID." },
          since: { type: "string", description: "Injected as SINCE clause if not already in NRQL." },
          until: { type: "string", description: "Injected as UNTIL clause if not already in NRQL." },
          limit: { type: "number", maximum: MAX_LIMIT, description: "Override LIMIT in NRQL." },
        },
        required: ["nrql"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "search_entities",
      description:
        "Search for New Relic entities (APM services, browser apps, infrastructure hosts, dashboards, etc.) by name, type, domain, or account. " +
        "Returns entity GUID, name, type, domain, accountId, and permalink. " +
        "Use entity GUIDs with other tools. Domain values: APM, BROWSER, INFRA, SYNTH, NR1. Type values: APPLICATION, SERVICE, HOST, DASHBOARD.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Partial name match (case-insensitive LIKE search)." },
          type: { type: "string", description: "Entity type: APPLICATION, SERVICE, HOST, DASHBOARD, etc." },
          domain: { type: "string", description: "Entity domain: APM, BROWSER, INFRA, SYNTH, NR1." },
          accountId: { type: "number", description: "Filter to a specific account ID." },
          limit: { type: "number", maximum: 200, description: "Max entities to return (default 25)." },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "get_service_health_summary",
      description:
        "Summarize current health for an APM service: error rate, throughput, P95 latency, and apdex score. " +
        "entityName must match the APM application name in New Relic. " +
        "Returns structured findings with severity (critical/warning) and recommendations.",
      inputSchema: {
        type: "object",
        properties: {
          entityName: { type: "string", description: "APM application name (must match New Relic app name exactly)." },
          accountId: { type: "number", description: "Override the default account ID." },
          since: { type: "string", description: "Time window (default: 1 hour ago)." },
        },
        required: ["entityName"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: "list_active_incidents",
      description:
        "List currently active New Relic AIOps incidents/issues (requires AIOps/Applied Intelligence). " +
        "Returns incident ID, priority, title, state, and creation time. " +
        "Returns empty if AIOps is not enabled for the account.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "number", description: "Override the default account ID." },
          since: { type: "string", description: "How far back to look (default: 24 hours ago)." },
          limit: { type: "number", maximum: 200, description: "Max incidents to return (default 50)." },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: "summarize_log_errors",
      description:
        "Group and summarize error-level log entries by message pattern. " +
        "Filters on level/severity IN ('ERROR', 'FATAL'). " +
        "Optionally filter by entity/service name. " +
        "Use logTable to target a custom log event type (from memory bank).",
      inputSchema: {
        type: "object",
        properties: {
          entityName: { type: "string", description: "Filter by entity.name or service.name." },
          logTable: { type: "string", description: "Log event type name (default: Log). Use memory bank primaryTable for custom tables." },
          since: { type: "string", description: "Start time (default: 1 hour ago)." },
          until: { type: "string", description: "End time (optional)." },
          limit: { type: "number", maximum: 200, description: "Max error groups to return (default 20)." },
          accountId: { type: "number", description: "Override the default account ID." },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "get_top_errors",
      description:
        "List the most frequent error classes for an APM service from TransactionError events. " +
        "Returns error class, count, sample message, first/last seen timestamps. " +
        "entityName must match the APM application name.",
      inputSchema: {
        type: "object",
        properties: {
          entityName: { type: "string", description: "APM application name." },
          accountId: { type: "number", description: "Override the default account ID." },
          since: { type: "string", description: "Time window (default: 1 hour ago)." },
          limit: { type: "number", maximum: 100, description: "Max error classes to return (default 20)." },
        },
        required: ["entityName"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: "get_slow_transactions",
      description:
        "List the slowest transactions for an APM service ranked by P95 latency. " +
        "Returns transaction name, P95ms, P99ms, request count, and error percentage. " +
        "entityName must match the APM application name.",
      inputSchema: {
        type: "object",
        properties: {
          entityName: { type: "string", description: "APM application name." },
          accountId: { type: "number", description: "Override the default account ID." },
          since: { type: "string", description: "Time window (default: 1 hour ago)." },
          limit: { type: "number", maximum: 100, description: "Max transactions to return (default 20)." },
        },
        required: ["entityName"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: "investigate_service_issue",
      description:
        "Comprehensive service investigation: runs get_service_health_summary, get_top_errors, get_slow_transactions, summarize_log_errors, and list_active_incidents in parallel. " +
        "Returns a structured report with findings, data, and recommendations. " +
        "Facts are clearly separated from correlations. No root causes are inferred beyond what the data shows. " +
        "entityName must match the APM application name.",
      inputSchema: {
        type: "object",
        properties: {
          entityName: { type: "string", description: "APM application name to investigate." },
          accountId: { type: "number", description: "Override the default account ID." },
          since: { type: "string", description: "Time window for APM data (default: 1 hour ago)." },
          limit: { type: "number", maximum: 50, description: "Max entries per data section (default 10)." },
        },
        required: ["entityName"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === "search_logs") {
      const parsed = searchLogsSchema.parse(args ?? {});
      const result = await executeQuery(parsed.query, parsed);
      return textResult(result);
    }

    if (name === "build_memory_bank") {
      const parsed = buildMemoryBankSchema.parse(args ?? {});
      const { bank, filePath } = await buildMemoryBank(client, {
        accountId: parsed.accountId,
        localRepositoryName: parsed.localRepositoryName,
        environments: compactUnique(parsed.environments),
        serviceMappings: (parsed.serviceMappings ?? []).map((mapping) => ({
          localService: mapping.localService.trim(),
          infraService: mapping.infraService?.trim(),
          pods: compactUnique(mapping.pods),
          containers: compactUnique(mapping.containers),
          notes: mapping.notes?.trim(),
        })),
        clarifications: compactUnique(parsed.clarifications),
      });
      return textResult({
        summary:
          `Memory bank built for account ${bank.accountId}. Found ${bank.logTables.length} log table(s): ${bank.logTables.join(", ")}. ` +
          "Use this repo file as the single source of truth for table, field, and service mapping context.",
        filePath,
        primaryTable: bank.primaryTable,
        logTables: bank.logTables,
        localRepositoryName: bank.repositoryContext.localRepositoryName,
        environments: bank.repositoryContext.environments,
        serviceMappings: bank.repositoryContext.serviceMappings,
        globalCustomFields: bank.globalCustomFields,
        agentHint: bank.agentHint,
        tableSchemas: Object.fromEntries(
          Object.entries(bank.tables).map(([name, t]) => [
            name,
            {
              estimatedRows: t.estimatedRows,
              windowUsed: t.windowUsed,
              customFields: t.customFields,
              fieldSamples: t.fieldSamples,
              totalFields: t.fields.length,
            },
          ]),
        ),
      });
    }

    if (name === "dry_run_query") {
      const parsed = dryRunSchema.parse(args ?? {});
      return textResult(await makeDryRun(parsed.query, parsed));
    }

    if (name === "run_nrql_query") {
      const parsed = runNrqlQuerySchema.parse(args ?? {});
      enforceReadOnlyQuery(parsed.nrql);
      const nrql = injectWindowAndLimit(parsed.nrql, parsed.since, parsed.until, parsed.limit ? Math.min(parsed.limit, MAX_LIMIT) : undefined);
      const startedAt = Date.now();
      const rows = await client.runNrql(nrql, parsed.accountId);
      const durationMs = Date.now() - startedAt;
      const { redacted, redactionCount } = redactObject(rows);
      return textResult({
        summary: `Returned ${rows.length} row(s) in ${durationMs}ms.`,
        query: nrql,
        rows: redacted,
        meta: { durationMs, rowsReturned: rows.length, redactionCount, accountId: parsed.accountId ?? client.accountId },
      });
    }

    if (name === "search_entities") {
      const parsed = searchEntitiesSchema.parse(args ?? {});
      const entities = await searchEntities(client, parsed);
      return textResult({
        summary: entities.length === 0
          ? "No entities found matching the search criteria."
          : `Found ${entities.length} entity/entities.`,
        entities,
      });
    }

    if (name === "get_service_health_summary") {
      const parsed = serviceHealthSchema.parse(args ?? {});
      return textResult(await getServiceHealthSummary(client, parsed));
    }

    if (name === "list_active_incidents") {
      const parsed = activeIncidentsSchema.parse(args ?? {});
      return textResult(await listActiveIncidents(client, parsed));
    }

    if (name === "summarize_log_errors") {
      const parsed = logErrorsSchema.parse(args ?? {});
      return textResult(await summarizeLogErrors(client, parsed));
    }

    if (name === "get_top_errors") {
      const parsed = topErrorsSchema.parse(args ?? {});
      return textResult(await getTopErrors(client, parsed));
    }

    if (name === "get_slow_transactions") {
      const parsed = slowTransactionsSchema.parse(args ?? {});
      return textResult(await getSlowTransactions(client, parsed));
    }

    if (name === "investigate_service_issue") {
      const parsed = investigateSchema.parse(args ?? {});
      return textResult(await investigateServiceIssue(client, parsed));
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const classified = classifyError(error);
    return textResult({
      error: {
        type: classified.type,
        message: classified.message,
      },
    });
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // Avoid leaking details to stdout because MCP requires structured responses.
  process.stderr.write(`Fatal startup error: ${message}\n`);
  process.exit(1);
});
