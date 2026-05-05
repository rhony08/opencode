import z from "zod"

export const AgentConfig = z.object({
  id: z.string().describe("Agent identifier"),
  role: z.string().optional().describe("Optional role description"),
  agent_type: z.string().describe("Base agent type"),
})
export type AgentConfig = z.infer<typeof AgentConfig>

export const Turn = z.object({
  agent: z.string(),
  output: z.string(),
  note: z.string().optional(),
  round: z.number(),
  turn_number: z.number(),
  timestamp: z.number(),
})
export type Turn = z.infer<typeof Turn>

export const AnalysisResult = z.object({
  consensus: z.array(z.string()),
  disagreements: z.array(z.string()),
  needs_user_input: z.array(z.string()),
  status: z.enum(["consensus_reached", "needs_resolution", "needs_user_input"]),
  recommendation: z.string(),
})
export type AnalysisResult = z.infer<typeof AnalysisResult>

export const DiscussionResult = z.object({
  discussion_id: z.string(),

  turn: z
    .object({
      agent: z.string(),
      output: z.string(),
      note: z.string(),
      round: z.number(),
      turn_number: z.number(),
    })
    .optional(),

  analysis: AnalysisResult.optional(),

  final: z
    .object({
      transcript: z.array(Turn),
      summary: z.object({
        consensus: z.array(z.string()),
        disagreements: z.array(z.string()),
        recommendations: z.array(z.string()),
        key_points: z.array(z.string()),
      }),
      rounds: z.number(),
      total_turns: z.number(),
    })
    .optional(),
})
export type DiscussionResult = z.infer<typeof DiscussionResult>

export interface DiscussionState {
  id: string
  topic: string
  agents: AgentConfig[]
  transcript: Turn[]
  round: number
  current_turn: number
  status: "active" | "paused_for_analysis" | "paused_for_user" | "complete"
}

export function createDiscussionId(): string {
  return `discuss_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

export * as DiscussionState from "./state"