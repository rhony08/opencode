import * as Tool from "./tool"
import DESCRIPTION from "./discuss.txt"
import z from "zod"
import { Agent } from "../agent/agent"
import { Provider } from "../provider"
import { Config } from "../config"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { generateText } from "ai"
import { DiscussionState, DiscussionResult, Turn, AnalysisResult, createDiscussionId } from "../discussion/state"
import { buildAgentPrompt, buildAnalyzerPrompt, extractNote } from "../discussion/prompts"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { ulid } from "ulid"
import { TaskTool } from "./task"

const id = "discuss"

const parameters = z.object({
  phase: z.enum(["start", "continue"]).describe("start = new discussion, continue = resume/next turn"),
  topic: z.string().describe("The discussion topic/question"),
  agents: z
    .array(
      z.object({
        id: z.string().describe("Agent identifier"),
        role: z.string().optional().describe("Optional role description"),
        agent_type: z.string().describe("Base agent type: 'general', 'explore', etc."),
      }),
    )
    .describe("Agents participating in discussion"),
  next_agent: z.string().describe("Which agent should speak next (orchestrator decides this)"),
  discussion_id: z.string().optional().describe("Resume previous discussion by ID"),
  transcript: z
    .array(
      z.object({
        agent: z.string(),
        output: z.string(),
        note: z.string().optional(),
        round: z.number(),
        turn_number: z.number().optional(),
      }),
    )
    .optional()
    .describe("Previous transcript (for continue phase)"),
  user_input: z.string().optional().describe("User's clarification/input to inject"),
  analyze: z.boolean().optional().describe("Run consensus analysis (spawns analyzer subagent)"),
  add_agent: z
    .object({
      id: z.string(),
      role: z.string().optional(),
      agent_type: z.string(),
    })
    .optional()
    .describe("Add new agent dynamically mid-discussion"),
  finalize: z.boolean().optional().describe("End discussion and return final result"),
})

export const DiscussTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service

    const run = Effect.fn("DiscussTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()

      // Handle analysis request (uses Task tool for analyzer subagent)
      if (params.analyze && params.transcript) {
        const transcriptText = params.transcript
          .map((t) => `[${t.agent}]: ${t.output}`)
          .join("\n\n")

        const analysisPrompt = buildAnalyzerPrompt({
          topic: params.topic,
          transcript: transcriptText,
        })

        // Use Task tool to spawn analyzer subagent
        const analyzerResult = yield* TaskTool.execute(
          {
            prompt: analysisPrompt,
            description: "Analyze discussion consensus",
            subagent_type: "general",
          },
          {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            abort: ctx.abort,
            agent: "build",
            messages: ctx.messages,
            extra: { bypassAgentCheck: true },
            metadata: () => Effect.void,
            ask: ctx.ask,
            callID: ulid(),
          },
        )

        // Parse analyzer output
        const analysisText = analyzerResult.output

        // Parse structured analysis from output
        const consensusMatch = analysisText.match(/## Consensus\s*\n([\s\S]*?)(?=## Disagreements|## Needs User Input|## Status|## Recommendation|$)/i)
        const disagreementsMatch = analysisText.match(/## Disagreements\s*\n([\s\S]*?)(?=## Needs User Input|## Status|## Recommendation|## Consensus|$)/i)
        const needsUserInputMatch = analysisText.match(/## Needs User Input\s*\n([\s\S]*?)(?=## Status|## Recommendation|## Consensus|## Disagreements|$)/i)
        const statusMatch = analysisText.match(/## Status\s*\n([\s\S]*?)(?=## Recommendation|## Consensus|## Disagreements|## Needs User Input|$)/i)
        const recommendationMatch = analysisText.match(/## Recommendation\s*\n([\s\S]*?)(?=## Consensus|## Disagreements|## Needs User Input|## Status|$)/i)

        const consensus = consensusMatch?.[1]?.trim().split("\n").filter(Boolean) ?? []
        const disagreements = disagreementsMatch?.[1]?.trim().split("\n").filter(Boolean) ?? []
        const needs_user_input = needsUserInputMatch?.[1]?.trim().split("\n").filter(Boolean) ?? []
        const statusRaw = statusMatch?.[1]?.trim() ?? "needs_resolution"
        const status =
          statusRaw.includes("consensus_reached")
            ? "consensus_reached"
            : statusRaw.includes("needs_user_input")
              ? "needs_user_input"
              : "needs_resolution"
        const recommendation = recommendationMatch?.[1]?.trim() ?? "Continue discussion"

        const analysis: AnalysisResult = {
          consensus,
          disagreements,
          needs_user_input,
          status,
          recommendation,
        }

        const result: DiscussionResult = {
          discussion_id: params.discussion_id ?? createDiscussionId(),
          analysis,
        }

        return {
          title: "Discussion Analysis",
          metadata: { analysis },
          output: [
            `<discussion_analysis>`,
            `Discussion ID: ${result.discussion_id}`,
            "",
            `## Consensus`,
            consensus.length > 0 ? consensus.join("\n") : "No clear consensus yet",
            "",
            `## Disagreements`,
            disagreements.length > 0 ? disagreements.join("\n") : "No disagreements identified",
            "",
            `## Needs User Input`,
            needs_user_input.length > 0 ? needs_user_input.join("\n") : "No user input needed",
            "",
            `## Status: ${status}`,
            "",
            `## Recommendation`,
            recommendation,
            `</discussion_analysis>`,
          ].join("\n"),
        }
      }

      // Handle finalize request
      if (params.finalize && params.transcript) {
        // Generate summary from transcript
        const rounds = Math.max(...params.transcript.map((t) => t.round ?? 1))
        const total_turns = params.transcript.length

        // Aggregate key points
        const key_points = params.transcript
          .map((t) => t.note ?? extractNote(t.output))
          .filter(Boolean)

        // Generate summary via Task tool
        const summaryPrompt = `
Summarize this discussion transcript:

Topic: ${params.topic}

Transcript:
${params.transcript.map((t) => `[${t.agent}]: ${t.output}`).join("\n\n")}

Return:
1. consensus: Points agreed upon by agents
2. disagreements: Points still in disagreement
3. recommendations: Actionable recommendations from the discussion
4. key_points: Most important points raised
`

        const summaryResult = yield* TaskTool.execute(
          {
            prompt: summaryPrompt,
            description: "Summarize discussion",
            subagent_type: "general",
          },
          {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            abort: ctx.abort,
            agent: "build",
            messages: ctx.messages,
            extra: { bypassAgentCheck: true },
            metadata: () => Effect.void,
            ask: ctx.ask,
            callID: ulid(),
          },
        )

        // Parse summary
        const summaryText = summaryResult.output
        const consensusMatch = summaryText.match(/consensus[:\s]*([\s\S]*?)(?=disagreements|recommendations|key_points|$)/i)
        const disagreementsMatch = summaryText.match(/disagreements[:\s]*([\s\S]*?)(?=recommendations|key_points|consensus|$)/i)
        const recommendationsMatch = summaryText.match(/recommendations[:\s]*([\s\S]*?)(?=key_points|consensus|disagreements|$)/i)
        const keyPointsMatch = summaryText.match(/key_points[:\s]*([\s\S]*?)(?=consensus|disagreements|recommendations|$)/i)

        const consensus = consensusMatch?.[1]?.trim().split("\n").filter(Boolean) ?? []
        const disagreements = disagreementsMatch?.[1]?.trim().split("\n").filter(Boolean) ?? []
        const recommendations = recommendationsMatch?.[1]?.trim().split("\n").filter(Boolean) ?? []
        const summary_key_points = keyPointsMatch?.[1]?.trim().split("\n").filter(Boolean) ?? key_points.slice(0, 10)

        const finalTranscript: Turn[] = params.transcript.map((t, i) => ({
          agent: t.agent,
          output: t.output,
          note: t.note ?? extractNote(t.output),
          round: t.round ?? Math.ceil((i + 1) / params.agents.length),
          turn_number: t.turn_number ?? i + 1,
          timestamp: Date.now(),
        }))

        const result: DiscussionResult = {
          discussion_id: params.discussion_id ?? createDiscussionId(),
          final: {
            transcript: finalTranscript,
            summary: {
              consensus,
              disagreements,
              recommendations,
              key_points: summary_key_points,
            },
            rounds,
            total_turns,
          },
        }

        return {
          title: "Discussion Final Result",
          metadata: { final: result.final },
          output: [
            `<discussion_final>`,
            `Discussion ID: ${result.discussion_id}`,
            `Rounds: ${rounds}`,
            `Total Turns: ${total_turns}`,
            "",
            `## Summary`,
            "",
            `### Consensus`,
            consensus.length > 0 ? consensus.join("\n") : "None",
            "",
            `### Disagreements`,
            disagreements.length > 0 ? disagreements.join("\n") : "None",
            "",
            `### Recommendations`,
            recommendations.length > 0 ? recommendations.join("\n") : "None",
            "",
            `### Key Points`,
            summary_key_points.slice(0, 10).join("\n"),
            "",
            `## Full Transcript`,
            finalTranscript.map((t) => `[Round ${t.round}] [${t.agent}]: ${t.output}`).join("\n\n"),
            `</discussion_final>`,
          ].join("\n"),
        }
      }

      // Execute agent turn inline (not via Task tool)
      const agentConfig = params.agents.find((a) => a.id === params.next_agent)
      if (!agentConfig) {
        return yield* Effect.fail(new Error(`Agent not found: ${params.next_agent}`))
      }

      // Get agent info
      const agentInfo = yield* agents.get(agentConfig.agent_type)
      if (!agentInfo) {
        return yield* Effect.fail(new Error(`Agent type not found: ${agentConfig.agent_type}`))
      }

      // Get model
      const model = agentInfo.model ?? (yield* provider.defaultModel())

      // Build discussion history from transcript
      const discussionHistory = params.transcript
        ? params.transcript.map((t) => `[${t.agent}]: ${t.output}`).join("\n\n")
        : ""

      // Build prompt
      const prompt = buildAgentPrompt({
        topic: params.topic,
        role: agentConfig.role,
        discussionHistory,
        userInput: params.user_input,
      })

      // Get provider language
      const resolvedModel = yield* provider.getModel(model.providerID, model.modelID)
      const language = yield* provider.getLanguage(resolvedModel)

      // Call LLM inline using generateText (simpler than streaming for discussion turns)
      const result = yield* Effect.promise(() =>
        generateText({
          model: language,
          prompt,
          maxTokens: 2000,
          temperature: agentInfo.temperature ?? 0.7,
        }),
      )

      const output = result.text
      const note = extractNote(output)

      // Calculate round and turn number
      const prevTurns = params.transcript ?? []
      const prevRound = prevTurns.length > 0 ? Math.max(...prevTurns.map((t) => t.round ?? 1)) : 0
      const prevTurnNum = prevTurns.length > 0 ? Math.max(...prevTurns.map((t) => t.turn_number ?? prevTurns.length)) : 0

      // New round if this is first agent of new round
      const agentsInPrevRound = prevTurns.filter((t) => t.round === prevRound).length
      const newRound = agentsInPrevRound >= params.agents.length ? prevRound + 1 : prevRound

      const turn: Turn = {
        agent: agentConfig.id,
        output,
        note,
        round: params.phase === "start" ? 1 : newRound,
        turn_number: params.phase === "start" ? 1 : prevTurnNum + 1,
        timestamp: Date.now(),
      }

      // Build updated transcript
      const updatedTranscript = [...(params.transcript ?? []), turn]

      const discussionId = params.phase === "start" ? createDiscussionId() : (params.discussion_id ?? createDiscussionId())

      const resultOutput: DiscussionResult = {
        discussion_id: discussionId,
        turn: {
          agent: turn.agent,
          output: turn.output,
          note: turn.note,
          round: turn.round,
          turn_number: turn.turn_number,
        },
      }

      // Build output for orchestrator
      const outputLines = [
        `<discussion_turn>`,
        `Discussion ID: ${discussionId}`,
        `Agent: ${turn.agent}`,
        `Round: ${turn.round}`,
        `Turn: ${turn.turn_number}`,
        "",
        `## Output`,
        turn.output,
        "",
        `## Key Point`,
        turn.note,
        "",
        `## Updated Transcript (${updatedTranscript.length} turns)`,
        updatedTranscript.map((t) => `[R${t.round}] [${t.agent}]: ${t.note}`).join("\n"),
        "",
        `## Available Agents`,
        params.agents.map((a) => `- ${a.id} (${a.agent_type})`).join("\n"),
        "",
        `Next: Call discuss tool again with phase="continue", next_agent=<your choice>, transcript=<above>`,
        `</discussion_turn>`,
      ]

      return {
        title: `Discussion Turn: ${turn.agent}`,
        metadata: { turn, transcript: updatedTranscript, discussion_id: discussionId },
        output: outputLines.join("\n"),
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)