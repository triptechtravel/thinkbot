import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { clawdwatchTools } from "./tools/clawdwatch";
import { githubTools } from "./tools/github";
import { datadogTools } from "./tools/datadog";
import { rollbarTools, sentryTools } from "./tools/errors";
import { opsSystemPrompt } from "./agent-ops";
import {
  handleMonitoringAlert,
  handleSlack,
  handleTelegram,
  triageAlert
} from "./routes";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { AlertEvent } from "clawdwatch";
import { DEFAULT_MODEL } from "./config";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai(this.env.MODEL ?? DEFAULT_MODEL, {
        sessionAffinity: this.sessionAffinity
      }),
      system: `${opsSystemPrompt(this.env)}

${getSchedulePrompt({ date: new Date() })}

If the user asks to be reminded or wants something done later, use the schedule tool.`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        // The same tools the alert inbox uses, so the chat UI and an
        // incident triage share exactly one implementation.
        ...clawdwatchTools(this.env),
        ...githubTools(this.env),
        ...datadogTools(this.env),
        ...sentryTools(this.env),
        ...rollbarTools(this.env),







        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

/**
 * The RPC inbox, for a clawdwatch deployment on the same Cloudflare account.
 *
 * Preferred over the signed HTTP hook where it is available: the platform
 * authenticates the caller, so there is no shared secret to distribute or
 * rotate and no public endpoint to defend. There is correspondingly no
 * signature to verify here — that check belongs to the HTTP adapter, and
 * `triageAlert` is written not to assume it ran.
 *
 * Bound from the sending Worker as:
 *   "services": [
 *     { "binding": "AGENT", "service": "thinkbot", "entrypoint": "AlertInbox" }
 *   ]
 */
export class AlertInbox extends WorkerEntrypoint<Env> {
  async alert(event: AlertEvent): Promise<void> {
    // Return immediately, exactly as the HTTP inbox does. Triage runs an LLM
    // turn; holding the caller open for it would surface in clawdwatch's
    // delivery records as a slow or failed notification.
    this.ctx.waitUntil(triageAlert(this.env, event));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);

    // Channels and hooks are plain routes, checked before the agent router so
    // they never depend on its path conventions.
    if (request.method === "POST") {
      if (pathname === "/hooks/telegram") return handleTelegram(request, env, ctx);
      if (pathname === "/hooks/slack") return handleSlack(request, env, ctx);
      if (pathname === "/hooks/clawdwatch") {
        return handleMonitoringAlert(request, env, ctx);
      }
    }

    if (pathname === "/health") {
      return Response.json({ ok: true, service: "thinkbot" });
    }

    // The chat UI and agent RPC are deliberately NOT served. This Worker holds
    // a GitHub PAT, Datadog and Sentry keys, and write access to monitoring
    // incidents; an unauthenticated chat surface would hand all of that to
    // anyone who found the hostname. Every route above verifies its caller
    // before doing any work.
    //
    // To re-enable the chat UI, put the hostname behind Cloudflare Access with
    // a bypass policy for /hooks/* (webhook senders cannot authenticate to
    // Access), build the client assets, then restore routeAgentRequest here.
    void routeAgentRequest;
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
