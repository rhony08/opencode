export const AGENT_DISCUSSION_PROMPT = `
You are participating in a multi-agent discussion.

Instructions:
1. Read the previous discussion carefully
2. Respond to relevant points from other agents
3. Add your own perspectives and ideas
4. You can agree, disagree, or raise new topics
5. Be constructive and specific
6. If you agree with something, explain why
7. If you disagree, explain your reasoning
8. Feel free to raise topics others haven't mentioned
9. You are NOT restricted to any specific role or domain - you can discuss any relevant aspects

Provide your contribution to the discussion. Be thorough but concise.
`

export function buildAgentPrompt(input: {
  topic: string
  role?: string
  discussionHistory: string
  userInput?: string
}): string {
  const roleSection = input.role ? `Your suggested role: ${input.role} (but you are NOT restricted to this - discuss freely)` : ""

  const userInputSection = input.userInput
    ? `
<user_input>
The user provided this clarification/input that should be incorporated into the discussion:
${input.userInput}
</user_input>
`
    : ""

  return `
${AGENT_DISCUSSION_PROMPT}

---

Discussion Topic: ${input.topic}

${roleSection}

---

Previous Discussion:
${input.discussionHistory || "No previous discussion - you are the first to speak. Start the discussion by presenting your initial thoughts and ideas on the topic."}

${userInputSection}

---

Now provide your contribution to this discussion.
`
}

export function buildAnalyzerPrompt(input: { topic: string; transcript: string }): string {
  return `
You are analyzing a multi-agent discussion transcript to determine consensus, disagreements, and next steps.

Discussion Topic: ${input.topic}

Transcript:
${input.transcript}

---

Analyze this discussion and return your findings in this format:

## Consensus
List points where most/all agents agree (be specific, quote key phrases if helpful):

## Disagreements  
List points where agents have different opinions (explain the disagreement):

## Needs User Input
List decisions or questions that require user clarification (be specific about what needs to be decided):

## Status
Choose one:
- "consensus_reached": Majority agreement on key points, ready to proceed
- "needs_resolution": Disagreements that agents can potentially resolve through more discussion
- "needs_user_input": Critical decisions need user input before continuing

## Recommendation
What should happen next:
- If consensus_reached: Summarize the agreed approach
- If needs_resolution: Suggest which agents should discuss which specific points
- If needs_user_input: State clearly what the user needs to decide/clarify

Be thorough and specific in your analysis.
`
}

export function extractNote(output: string): string {
  // Extract key points from agent output - look for structured patterns
  // or summarize the main contribution

  // Try to find bullet points or key assertions
  const lines = output.split("\n")

  // Look for lines starting with common patterns
  const keyPoints: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (
      trimmed.startsWith("- ") ||
      trimmed.startsWith("* ") ||
      trimmed.startsWith("1. ") ||
      trimmed.startsWith("2. ") ||
      trimmed.startsWith("Key:") ||
      trimmed.startsWith("Important:") ||
      trimmed.startsWith("Proposed:") ||
      trimmed.startsWith("Suggested:") ||
      trimmed.startsWith("Agreed:") ||
      trimmed.startsWith("Disagreed:")
    ) {
      keyPoints.push(trimmed)
    }
  }

  // If found structured points, use them
  if (keyPoints.length > 0 && keyPoints.length <= 5) {
    return keyPoints.join("; ")
  }

  // Otherwise, summarize first few significant sentences
  const sentences = output.split(/[.!?]\s+/).filter((s) => s.trim().length > 20)
  if (sentences.length > 0) {
    // Take first 2-3 meaningful sentences
    return sentences.slice(0, 3).join(". ").substring(0, 200) + (sentences.length > 3 ? "..." : "")
  }

  // Fallback: take first 150 chars
  return output.substring(0, 150).trim() + (output.length > 150 ? "..." : "")
}

export * as DiscussionPrompts from "./prompts"